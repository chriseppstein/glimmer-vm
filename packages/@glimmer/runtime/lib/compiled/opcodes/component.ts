
import { Opaque } from '@glimmer/interfaces';
import {
  combine,
  CONSTANT_TAG,
  isConst,
  ReferenceCache,
  Tag,
  VersionedPathReference,
} from '@glimmer/reference';
import Bounds from '../../bounds';
import { Component, ComponentDefinition, ComponentManager } from '../../component/interfaces';
import { DynamicScope } from '../../environment';
import { APPEND_OPCODES, Op, OpcodeJSON, UpdatingOpcode } from '../../opcodes';
import { UpdatingVM } from '../../vm';
import ARGS, { Arguments, IArguments } from '../../vm/arguments';
import { ComponentElementOperations } from './dom';
import { Assert } from './vm';

APPEND_OPCODES.add(Op.PushComponentManager, (vm, { op1: _definition }) => {
  let definition = vm.constants.getOther<ComponentDefinition<Opaque>>(_definition);
  let stack = vm.stack;

  stack.push({ definition, manager: definition.manager, component: null });
});

APPEND_OPCODES.add(Op.PushDynamicComponentManager, vm => {
  let stack = vm.stack;
  let reference = stack.pop<VersionedPathReference<ComponentDefinition<Opaque>>>();
  let cache = isConst(reference) ? undefined : new ReferenceCache<ComponentDefinition<Opaque>>(reference);
  let definition = cache ? cache.peek() : reference.value();

  stack.push({ definition, manager: definition.manager, component: null });

  if (cache) {
    vm.updateWith(new Assert(cache));
  }
});

interface InitialComponentState<T> {
  definition: ComponentDefinition<T>;
  manager: ComponentManager<T>;
  component: null;
}

export interface ComponentState<T> {
  definition: ComponentDefinition<T>;
  manager: ComponentManager<T>;
  component: T;
}

APPEND_OPCODES.add(Op.PushArgs, (vm, { op1: synthetic }) => {
  let stack = vm.stack;
  ARGS.setup(stack, !!synthetic);
  stack.push(ARGS);
});

APPEND_OPCODES.add(Op.PrepareArgs, (vm, { op1: _state }) => {
  let stack = vm.stack;
  let { definition, manager } = vm.fetchValue<InitialComponentState<Opaque>>(_state);
  let args = stack.pop<Arguments>();

  let preparedArgs = manager.prepareArgs(definition, args);

  if (preparedArgs) {
    args.clear();

    let { positional, named } = preparedArgs;

    let positionalCount = positional.length;

    for (let i = 0; i < positionalCount; i++) {
      stack.push(positional[i]);
    }

    stack.push(positionalCount);

    let names = Object.keys(named);
    let namedCount = names.length;
    let atNames = [];

    for (let i = 0; i < namedCount; i++) {
      let value = named[names[i]];
      let atName = `@${names[i]}`;

      stack.push(value);
      atNames.push(atName);
    }

    stack.push(atNames);
    args.setup(stack, false);
  }

  stack.push(args);
});

APPEND_OPCODES.add(Op.CreateComponent, (vm, { op1: flags, op2: _state }) => {
  let definition: ComponentDefinition<Opaque>;
  let manager: ComponentManager<Opaque>;
  let args = vm.stack.pop<IArguments>();
  let dynamicScope = vm.dynamicScope();
  let state = { definition, manager } = vm.fetchValue<InitialComponentState<Opaque>>(_state);

  let hasDefaultBlock = flags & 1;

  let component = manager.create(vm.env, definition, args, dynamicScope, vm.getSelf(), !!hasDefaultBlock);
  (state as ComponentState<typeof component>).component = component;

  vm.updateWith(new UpdateComponentOpcode(args.tag, definition.name, component, manager, dynamicScope));
});

APPEND_OPCODES.add(Op.RegisterComponentDestructor, (vm, { op1: _state }) => {
  let { manager, component } = vm.fetchValue<ComponentState<Opaque>>(_state);

  let destructor = manager.getDestructor(component);
  if (destructor) vm.newDestroyable(destructor);
});

APPEND_OPCODES.add(Op.BeginComponentTransaction, vm => {
  vm.beginCacheGroup();
  vm.elements().pushSimpleBlock();
});

APPEND_OPCODES.add(Op.PushComponentOperations, vm => {
  vm.stack.push(new ComponentElementOperations(vm.env));
});

APPEND_OPCODES.add(Op.DidCreateElement, (vm, { op1: _state }) => {
  let { manager, component } = vm.fetchValue<ComponentState<Opaque>>(_state);

  let action = 'DidCreateElementOpcode#evaluate';
  manager.didCreateElement(component, vm.elements().expectConstructing(action), vm.elements().expectOperations(action));
});

APPEND_OPCODES.add(Op.GetComponentSelf, (vm, { op1: _state }) => {
  let state = vm.fetchValue<ComponentState<Opaque>>(_state);
  vm.stack.push(state.manager.getSelf(state.component));
});

APPEND_OPCODES.add(Op.GetComponentLayout, (vm, { op1: _state }) => {
  let { manager, definition, component } = vm.fetchValue<ComponentState<Opaque>>(_state);
  vm.stack.push(manager.layoutFor(definition, component, vm.env));
});

APPEND_OPCODES.add(Op.DidRenderLayout, (vm, { op1: _state }) => {
  let { manager, component } = vm.fetchValue<ComponentState<Opaque>>(_state);
  let bounds = vm.elements().popBlock();

  manager.didRenderLayout(component, bounds);

  vm.env.didCreate(component, manager);

  vm.updateWith(new DidUpdateLayoutOpcode(manager, component, bounds));
});

APPEND_OPCODES.add(Op.CommitComponentTransaction, vm => vm.commitCacheGroup());

export class UpdateComponentOpcode extends UpdatingOpcode {
  public type = 'update-component';

  constructor(
    tag: Tag,
    private name: string,
    private component: Component,
    private manager: ComponentManager<Component>,
    private dynamicScope: DynamicScope,
  ) {
    super();

    let componentTag = manager.getTag(component);

    if (componentTag) {
      this.tag = combine([tag, componentTag]);
    } else {
      this.tag = tag;
    }
  }

  evaluate(_vm: UpdatingVM) {
    let { component, manager, dynamicScope } = this;

    manager.update(component, dynamicScope);
  }

  toJSON(): OpcodeJSON {
    return {
      args: [JSON.stringify(this.name)],
      guid: this._guid,
      type: this.type,
    };
  }
}

export class DidUpdateLayoutOpcode extends UpdatingOpcode {
  public type = 'did-update-layout';
  public tag: Tag = CONSTANT_TAG;

  constructor(
    private manager: ComponentManager<Component>,
    private component: Component,
    private bounds: Bounds,
  ) {
    super();
  }

  evaluate(vm: UpdatingVM) {
    let { manager, component, bounds } = this;

    manager.didUpdateLayout(component, bounds);

    vm.env.didUpdate(component, manager);
  }
}
