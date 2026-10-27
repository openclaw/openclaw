// Registered executable surfaces retain receiver binding and instance lifetime.
import { types } from "node:util";
import {
  createPluginArgumentView,
  getPluginMethodArgumentKind,
} from "./plugin-instance-argument-views.js";
import {
  createPluginIteratorBindings,
  type PluginIteratorBindingOwner,
} from "./plugin-instance-iterator.js";
import { PluginFactoryBinding } from "./plugin-instance-owned-values.js";
import {
  getPluginOriginalValue,
  pluginInstanceState,
  setPluginOriginalValue,
} from "./plugin-instance-scope.js";
import { mapPluginReturnPromise, resolvePluginReturnPromise } from "./plugin-return-value.js";
import { createPluginToolExecutionBinding } from "./plugin-tool-execution.js";

const { values: valueInstances } = pluginInstanceState;
const DATA_FIELDS = new Set([
  "parameters",
  "schema",
  "configSchema",
  "configJsonSchema",
  "inputSchema",
  "outputSchema",
]);

function pluginMemberDescriptor(object: object, key: PropertyKey) {
  for (let source: object | null = object; source; source = Object.getPrototypeOf(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor) {
      return descriptor;
    }
  }
  return undefined;
}

function pluginMemberNeedsAdmission(object: object, key?: PropertyKey, getters = true): boolean {
  for (let source: object | null = object; source; source = Object.getPrototypeOf(source)) {
    if (types.isProxy(source)) {
      return true;
    }
    const descriptor = key !== undefined && Object.getOwnPropertyDescriptor(source, key);
    if (descriptor) {
      return getters && descriptor.get !== undefined;
    }
  }
  return false;
}

function isNativePluginData(value: object): boolean {
  return (
    types.isAnyArrayBuffer(value) ||
    types.isArrayBufferView(value) ||
    types.isDate(value) ||
    types.isRegExp(value) ||
    types.isNativeError(value)
  );
}

function bindNativeReceiver<T, R>(invoke: (receiver: T, args: unknown[]) => R) {
  return function (this: T, ...args: unknown[]): R {
    return invoke(this, args);
  };
}

type PluginInstanceBindingOwner = PluginIteratorBindingOwner & {
  invoke: <T>(run: () => T) => T;
};

/** Registration facts and captured stream scopes share the instance's lifetime. */
export function createPluginInstanceBindings(bindings: PluginInstanceBindingOwner) {
  const factories = new WeakMap<object, true | "tool" | readonly PropertyKey[]>();
  return {
    admitFactory: (
      factory: (...args: never[]) => unknown,
      resultCallbacks?: "tool" | readonly PropertyKey[],
    ): void => void factories.set(factory, resultCallbacks ?? true),
    create(
      admit: <T>(run: () => T) => T,
      admitCallback: <T>(run: () => T) => T = (run) => admit(() => bindings.invoke(run)),
    ) {
      // Unused custody needs no callable cache; each admission still owns its views.
      let wrap: ReturnType<typeof createPluginBindings> | undefined;
      return <T>(value: T): T =>
        (wrap ??= createPluginBindings(bindings, factories, admit, admitCallback))(value);
    },
  };
}

function createPluginBindings(
  bindings: PluginInstanceBindingOwner,
  factories: WeakMap<object, true | "tool" | readonly PropertyKey[]>,
  admit: <T>(run: () => T) => T,
  admitCallback: <T>(run: () => T) => T,
) {
  const factoryBinding = (value: object) => {
    for (
      let source: object | undefined = value;
      source;
      source = getPluginOriginalValue(source, bindings.instance)
    ) {
      const binding = factories.get(source);
      if (binding) {
        return binding;
      }
    }
    return undefined;
  };
  const wrapped = new WeakMap<object, unknown>();
  const factory = {};
  const originalValue = (value: object) => getPluginOriginalValue(value, bindings.instance);
  const derivedReceivers = new WeakSet<object>();
  const prototypeReceivers = new WeakMap<object, WeakMap<object, object>>();
  const { iterators, admitIterator } = createPluginIteratorBindings(bindings, factory, admit);
  const wrapArguments = createPluginArgumentView({
    original: originalValue,
    setOriginal: (value, source) => setPluginOriginalValue(value, source, bindings.instance),
    isWrapped: (value) => PluginFactoryBinding.belongsTo(value, factory),
    invoke: admitCallback,
  });
  // Executable return contracts keep admission; ordinary result graphs are never inspected.
  const passResult = <T>(value: T): T =>
    typeof value === "function" ||
    (value !== null &&
      typeof value === "object" &&
      typeof Reflect.get(value, Symbol.asyncIterator) === "function")
      ? wrap(value)
      : value;
  // Factory arrays contain executable registrations, not ordinary result payloads.
  const bindFactoryResult = <T>(value: T, binding: true | "tool" | readonly PropertyKey[]): T => {
    if (binding === "tool") {
      return bindTool(value);
    }
    const callbacks = binding === true ? undefined : binding;
    if (
      callbacks &&
      value !== null &&
      typeof value === "object" &&
      !callbacks.some((key) => typeof Reflect.get(value, key) === "function")
    ) {
      return value;
    }
    return Array.isArray(value)
      ? (value.map((entry) => wrap(entry, "", undefined, callbacks)) as T) // SAFETY: Binding preserves each member's shape.
      : wrap(value, "", undefined, callbacks);
  };
  const wrapResult = <T>(
    result: T,
    callerData?: unknown[],
    executable?: true | "tool" | readonly PropertyKey[],
  ): T => {
    const completion = resolvePluginReturnPromise(result);
    if (completion) {
      const pending = mapPluginReturnPromise(completion, (resolved) =>
        executable ? bindFactoryResult(resolved, executable) : passResult(resolved),
      );
      if (pending.host) {
        valueInstances.setHost(pending.value, bindings.instance);
      } else {
        valueInstances.set(pending.value, bindings.instance);
      }
      // SAFETY: Promise-like results retain their resolved type while callable values stay owned.
      return pending.value as T;
    }
    return callerData?.includes(result)
      ? result
      : executable
        ? bindFactoryResult(result, executable)
        : passResult(result);
  };

  const bindTool = createPluginToolExecutionBinding({
    admit,
    wrapProxy: (tool) => wrap(tool),
    call: (method, receiver, args) =>
      admit(() => {
        const call = wrapArguments(args);
        return wrapResult(Reflect.apply(method, receiver, call.args), call.callerData);
      }),
    register: (view, source) => {
      void new PluginFactoryBinding(view, factory);
      setPluginOriginalValue(view, source, bindings.instance);
      valueInstances.setHost(view, bindings.instance);
    },
  });

  /** Callables retain their instance; schemas remain data for host validators. */
  const wrap = <T>(
    value: T,
    field = "",
    callbackIndex?: 0 | null,
    resultCallbacks?: readonly PropertyKey[],
  ): T => {
    if ((!value || typeof value !== "object") && typeof value !== "function") {
      return value;
    }
    // Native APIs and structuredClone reject Proxy data, including byte views.
    if (DATA_FIELDS.has(field) || (typeof value === "object" && isNativePluginData(value))) {
      return value;
    }
    if (PluginFactoryBinding.belongsTo(value, factory)) {
      return value;
    }
    // SAFETY: The cache stores only the view created for this exact input value.
    return (wrapped.get(value) ?? createView(value, field, callbackIndex, resultCallbacks)) as T;
  };

  // Keep closure contexts off primitive reads and already-bound value lookups.
  const createView = <T extends object>(
    value: T,
    field: string,
    callbackIndex?: 0 | null,
    resultCallbacks?: readonly PropertyKey[],
  ): T => {
    const object: object = value;
    const methods = new Map<
      PropertyKey,
      { original: Function; receiver: object; wrapped: unknown }
    >();
    const derivedFields = new Set<PropertyKey>();
    const invoke = <R>(run: () => R): R => {
      const current = iterators.get(object);
      if (current?.active) {
        return current.invoke(run);
      }
      return current && !current.done ? current.reenter(() => admit(run)) : admit(run);
    };
    const inspectIterable = () => pluginMemberDescriptor(object, Symbol.asyncIterator);
    const iterableDescriptor = pluginMemberNeedsAdmission(object, Symbol.asyncIterator, false)
      ? invoke(inspectIterable)
      : inspectIterable();
    const iterable =
      typeof iterableDescriptor?.value === "function" || iterableDescriptor?.get !== undefined;
    const reflect = <R>(run: () => R): R => (types.isProxy(object) ? invoke(run) : run());
    const resolveReceiver = (key: PropertyKey, receiver: object) => {
      const receivers = prototypeReceivers.get(object);
      if (receivers) {
        const original = originalValue(receiver) ?? receiver;
        return receivers.get(original) ?? original;
      }
      // Inherited access belongs to the child; exact-view access keeps private fields on the original.
      if (receiver !== object && receiver !== result) {
        return originalValue(receiver) ?? receiver;
      }
      return derivedReceivers.has(object) &&
        (!reflect(() => Object.hasOwn(object, key)) || derivedFields.has(key))
        ? result
        : object;
    };
    const read = (key: PropertyKey, receiver = object) => {
      const protocol = key === "next" || key === "return" || key === "throw";
      const iteration = iterators.get(object);
      if (iteration?.done) {
        if (key === Symbol.asyncIterator) {
          return methods.get(key)?.wrapped ?? (() => result);
        }
        if (protocol) {
          return (...args: unknown[]) => iteration.call(key, undefined, args);
        }
      }
      const prepared = methods.get(key);
      if (protocol && iteration?.active && prepared) {
        return prepared.wrapped;
      }
      let resolvedReceiver = receiver;
      let property: unknown;
      try {
        resolvedReceiver = resolveReceiver(key, receiver);
        property = pluginMemberNeedsAdmission(object, key)
          ? invoke(() => Reflect.get(object, key, resolvedReceiver))
          : Reflect.get(object, key, resolvedReceiver);
      } catch (error) {
        if (protocol && iteration?.active) {
          iteration.close();
        }
        throw error;
      }
      if (key === "return" && iteration && typeof property !== "function") {
        if (property == null) {
          return (...args: unknown[]) => iteration.call(key, undefined, args);
        }
        if (iteration.active) {
          iteration.close();
        }
      }
      // Mixed result envelopes declare their executable slots; all other values remain data.
      if (resultCallbacks && !resultCallbacks.includes(key)) {
        return property;
      }
      if (typeof property !== "function" || key === "constructor") {
        return wrap(property, String(key));
      }
      const cachedMethod = methods.get(key);
      if (cachedMethod?.original === property && cachedMethod.receiver === resolvedReceiver) {
        return cachedMethod.wrapped;
      }
      if (key === Symbol.asyncIterator || (protocol && (iterable || iteration))) {
        const bound =
          key === Symbol.asyncIterator
            ? (...args: unknown[]) => {
                if (iterators.get(object)?.done) {
                  return result;
                }
                return invoke(() => {
                  const iterator: unknown = Reflect.apply(property, resolvedReceiver, args);
                  if (
                    !iterator ||
                    (typeof iterator !== "object" && typeof iterator !== "function")
                  ) {
                    throw new TypeError("Plugin async iterator factory must return an object");
                  }
                  admitIterator(iterator);
                  return wrap(iterator);
                });
              }
            : (...args: unknown[]) => {
                try {
                  const current = iterators.get(object);
                  const owner =
                    current && (current.active || current.done) ? current : admitIterator(object);
                  return owner.call(key, property, args);
                } catch (error) {
                  return Promise.resolve().then(() => {
                    throw error;
                  });
                }
              };
        methods.set(key, { original: property, receiver: resolvedReceiver, wrapped: bound });
        valueInstances.setHost(bound, bindings.instance);
        return bound;
      }
      const classify = () => getPluginMethodArgumentKind(object, key);
      const kind = pluginMemberNeedsAdmission(object) ? invoke(classify) : classify();
      if (
        kind === "function" &&
        !prototypeReceivers.has(object) &&
        (key === "call" || key === "apply" || key === "bind")
      ) {
        const bound =
          key === "bind"
            ? (...args: unknown[]) =>
                admit(() => {
                  const source: (...args: never[]) => unknown = Reflect.apply(
                    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the wrapped callable as bind's receiver.
                    Function.prototype.bind,
                    result,
                    wrapArguments(args).args,
                  );
                  const binding = factoryBinding(result);
                  if (binding) {
                    factories.set(source, binding);
                  }
                  return wrap(source);
                })
            : wrap(Function.prototype.bind.call(Function.prototype[key], result), key);
        methods.set(key, { original: property, receiver: resolvedReceiver, wrapped: bound });
        valueInstances.setHost(bound, bindings.instance);
        return bound;
      }
      const bind = () =>
        prototypeReceivers.has(object)
          ? new Proxy(property, {
              apply: (target, callReceiver, args) =>
                Reflect.apply(target, resolveReceiver(key, callReceiver), args),
            })
          : Function.prototype.bind.call(property, resolvedReceiver);
      const bound = wrap(
        !originalValue(property) &&
          (pluginMemberNeedsAdmission(property, "length") ||
            pluginMemberNeedsAdmission(property, "name"))
          ? invoke(bind)
          : bind(),
        String(key),
        kind === "function" ? undefined : kind,
      );
      setPluginOriginalValue(bound, property, bindings.instance);
      methods.set(key, { original: property, receiver: resolvedReceiver, wrapped: bound });
      return bound;
    };
    const handlers: ProxyHandler<object> = {
      get: (target, key, receiver) => {
        const fixed = Object.getOwnPropertyDescriptor(target, key);
        return fixed?.configurable === false && "value" in fixed && !fixed.writable
          ? fixed.value
          : read(key, receiver);
      },
      has: (_target, key) =>
        pluginMemberNeedsAdmission(object, key, false)
          ? invoke(() => Reflect.has(object, key))
          : Reflect.has(object, key),
      // Ordinary prototype identity stays native; user-defined Proxy traps remain admitted code.
      getPrototypeOf: () =>
        prototypeReceivers.has(object) ? object : reflect(() => Object.getPrototypeOf(object)),
      ownKeys: () => reflect(() => Reflect.ownKeys(object)),
      getOwnPropertyDescriptor: (target, key) => {
        const original = reflect(() => Object.getOwnPropertyDescriptor(object, key));
        if (!original) {
          return undefined;
        }
        const configurable = key !== "length" || !Array.isArray(value);
        const fixed = Object.getOwnPropertyDescriptor(target, key);
        if (configurable && fixed?.configurable === false) {
          return "value" in fixed && fixed.writable ? { ...fixed, value: read(key) } : fixed;
        }
        if (!configurable) {
          // Array length is fixed on the target too; otherwise frozen-array reflection throws.
          Object.defineProperty(target, key, original);
        }
        return "value" in original
          ? { ...original, configurable, value: read(key) }
          : {
              ...original,
              configurable,
              get: original.get
                ? bindNativeReceiver((receiver: object) => read(key, receiver))
                : undefined,
              set: original.set
                ? bindNativeReceiver((receiver: object, [next]) =>
                    invoke(() =>
                      Reflect.set(object, key, next, resolveReceiver(key, receiver ?? object)),
                    ),
                  )
                : undefined,
            };
      },
      set: (_target, key, next, receiver) =>
        invoke(() =>
          Reflect.set(
            object,
            key,
            next,
            // Inherited and derived data writes must reach their owning view's defineProperty.
            (receiver === result && !derivedReceivers.has(object)) ||
              pluginMemberDescriptor(object, key)?.set
              ? resolveReceiver(key, receiver)
              : receiver,
          ),
        ),
      // Freezing only the shadow would invalidate its live original-property projection.
      preventExtensions: () => false,
      defineProperty: (target, key, attributes) =>
        invoke(() => {
          const current = handlers.getOwnPropertyDescriptor!(target, key);
          if (!Reflect.defineProperty(object, key, attributes)) {
            return false;
          }
          derivedFields.add(key);
          // Fixed descriptors must exist on the target, retaining projected plugin methods
          // and the exact identity of any explicitly supplied caller-owned member.
          if (current) {
            Object.defineProperty(target, key, current);
          }
          return Reflect.defineProperty(target, key, attributes);
        }),
      deleteProperty: (_target, key) => invoke(() => Reflect.deleteProperty(object, key)),
    };
    let result: object;
    if (typeof value === "function") {
      const prototype = reflect(() => Object.getOwnPropertyDescriptor(value, "prototype")?.value);
      const receivers =
        prototype && typeof prototype === "object"
          ? (prototypeReceivers.get(prototype) ?? new WeakMap<object, object>())
          : undefined;
      if (receivers) {
        prototypeReceivers.set(prototype, receivers);
      }
      // A bound target has no fixed static properties, so frozen exports can
      // expose fenced members without violating Proxy descriptor invariants.
      const bind = () => Function.prototype.bind.call(value, undefined);
      result = new Proxy(
        pluginMemberNeedsAdmission(value, "length") || pluginMemberNeedsAdmission(value, "name")
          ? admit(bind)
          : bind(),
        {
          ...handlers,
          apply: (_target, receiver, args) =>
            admit(() => {
              const call = wrapArguments(args, callbackIndex, field);
              return wrapResult(
                Reflect.apply(value, receiver, call.args),
                call.callerData,
                factoryBinding(result),
              );
            }),
          construct: (_target, args, newTarget): object =>
            admit(() => {
              const constructed = Reflect.construct(
                value,
                wrapArguments(args, callbackIndex, field).args,
                newTarget === result ? value : newTarget,
              );
              receivers?.set(originalValue(constructed) ?? constructed, constructed);
              // Derived private fields are installed on super()'s returned view;
              // base prototype methods still require the original branded receiver.
              if (newTarget !== result) {
                derivedReceivers.add(constructed);
              }
              return wrap(constructed);
            }),
        },
      );
    } else {
      // A view preserves class/private-field receivers and live properties. A plain
      // record copy loses both; proxying a frozen original forbids wrapped methods.
      result = new Proxy(
        Array.isArray(value) ? [] : Object.create(reflect(() => Object.getPrototypeOf(object))),
        handlers,
      );
    }
    wrapped.set(object, result);
    void new PluginFactoryBinding(result, factory);
    setPluginOriginalValue(result, object, bindings.instance);
    valueInstances.setHost(result, bindings.instance);
    // SAFETY: The view retains the input prototype and routes each member to the original object.
    return result as T;
  };

  return wrap;
}
