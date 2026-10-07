// Registered executable surfaces retain receiver binding and instance lifetime.
import { AsyncResource } from "node:async_hooks";
import { types } from "node:util";
import {
  createPluginArgumentView,
  getPluginMethodArgumentKind,
} from "./plugin-instance-argument-views.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import type { PluginInstanceInvocation } from "./plugin-instance-invocation.types.js";
import { PluginHostObject } from "./plugin-instance-owned-values.js";
import {
  getPluginOriginalValue,
  pluginInstanceState,
  pluginInvocationContext,
  setPluginOriginalValue,
  type PluginInstanceHandle,
} from "./plugin-instance-scope.js";
import type { PluginInstanceCallLease } from "./plugin-instance.types.js";
import { mapPluginReturnPromise, resolvePluginReturnPromise } from "./plugin-return-value.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

const { values: valueInstances } = pluginInstanceState;
/** An iterator keeps the admission that owns its pending protocol operations. */
type PluginIteratorAdmission = {
  readonly origin: PluginInstanceInvocation;
  reenter: <T>(run: () => T) => T;
  readonly done: boolean;
  readonly active: boolean;
  invoke: <T>(run: () => T) => T;
  close: () => void;
  call: (key: PropertyKey, method: Function | undefined, args: unknown[]) => Promise<unknown>;
};

class ExecutableBinding extends PluginHostObject {
  #factory: object;

  constructor(value: object, factory: object) {
    super(value);
    this.#factory = factory;
  }

  static belongsTo(value: object, factory: object) {
    return #factory in value && value.#factory === factory;
  }
}

const DATA_FIELDS = new Set([
  "parameters",
  "schema",
  "configSchema",
  "configJsonSchema",
  "inputSchema",
  "outputSchema",
]);

function pluginMemberDescriptor(object: object, key: PropertyKey) {
  let descriptor: PropertyDescriptor | undefined;
  for (
    let source: object | null = object;
    source && !descriptor;
    source = Object.getPrototypeOf(source)
  ) {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  }
  return descriptor;
}

function readPluginMember(
  object: object,
  key: PropertyKey,
  invoke: (run: () => unknown) => unknown,
  receiver = object,
): unknown {
  return pluginMemberNeedsAdmission(object, key)
    ? invoke(() => Reflect.get(object, key, receiver))
    : Reflect.get(object, key, receiver);
}

function pluginMemberNeedsAdmission(object: object, key: PropertyKey, getters = true): boolean {
  for (let source: object | null = object; source; source = Object.getPrototypeOf(source)) {
    if (types.isProxy(source)) {
      return true;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor) {
      return getters && descriptor.get !== undefined;
    }
  }
  return false;
}

function hasProxyPrototype(object: object): boolean {
  for (let source: object | null = object; source; source = Object.getPrototypeOf(source)) {
    if (types.isProxy(source)) {
      return true;
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

type PluginInstanceBindingOwner = {
  instance: PluginInstanceHandle;
  enter: <T>(token: object, run: () => T) => T;
  invoke: <T>(run: () => T) => T;
  lease: () => PluginInstanceCallLease;
  hasToken: (token: object) => boolean;
  isConsumerToken: (token: object) => boolean;
};

/** Registration facts and captured stream scopes share the instance's lifetime. */
export function createPluginInstanceBindings(bindings: PluginInstanceBindingOwner) {
  const factories = new WeakSet<object>();
  const admitFactory = (factory: (...args: never[]) => unknown): void => {
    factories.add(factory);
  };
  return {
    admitFactory,
    create(
      admit: <T>(run: () => T) => T,
      admitCallback: <T>(run: () => T) => T = (run) => admit(() => bindings.invoke(run)),
    ) {
      return createPluginBindings(bindings, factories, admit, admitCallback);
    },
  };
}

/** Builds callable views while the exact instance continues to own admission and leases. */
function createPluginBindings(
  bindings: PluginInstanceBindingOwner,
  factories: WeakSet<object>,
  admit: <T>(run: () => T) => T,
  admitCallback: <T>(run: () => T) => T,
) {
  const { instance } = bindings;
  const prepareInvocation = (token: object, parent?: PluginInstanceInvocation) => {
    const context = pluginInvocationContext.getStore();
    const consumer = bindings.isConsumerToken(token);
    // Iterator creation runs inside its admitting call; renewals keep that original parent.
    const origin = parent ?? pluginInstanceInvocation.getStore()!;
    const held: { registry?: PluginRegistry } = {};
    // Capture once: replaying AsyncLocalStorage.run copies Node's context map per event.
    const resource = bindings.enter(token, () => {
      held.registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
      return new AsyncResource("OpenClawPluginStream");
    });
    return {
      origin,
      reenter: <T>(run: () => T): T => {
        if (consumer && !bindings.hasToken(token)) {
          throw new Error(`Plugin ${instance.pluginId} consumer is closed`);
        }
        return resource.runInAsyncScope(() => pluginInstanceInvocation.run(origin, run));
      },
      assertCurrent: () => {
        context?.lookup(instance);
        const current = pluginInvocationContext.getStore();
        if (current !== context) {
          current?.lookup(instance);
        }
      },
      run: <T>(run: () => T): T => resource.runInAsyncScope(run),
      close: () => {
        held.registry = undefined;
        resource.emitDestroy();
      },
    };
  };
  const isFactory = (value: object) => {
    for (
      let source: object | undefined = value;
      source;
      source = getPluginOriginalValue(source, instance)
    ) {
      if (factories.has(source)) {
        return true;
      }
    }
    return false;
  };
  const wrapped = new WeakMap<object, unknown>();
  const factory = {};
  const originalValue = (value: object) => getPluginOriginalValue(value, bindings.instance);
  const derivedReceivers = new WeakSet<object>();
  const prototypeReceivers = new WeakMap<object, WeakMap<object, object>>();
  const iterators = new WeakMap<object, PluginIteratorAdmission>();
  const wrapArguments = createPluginArgumentView({
    original: originalValue,
    setOriginal: (value, source) => setPluginOriginalValue(value, source, bindings.instance),
    isWrapped: (value) => ExecutableBinding.belongsTo(value, factory),
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
  const bindFactoryResult = <T>(value: T): T => {
    if (!Array.isArray(value)) {
      return wrap(value);
    }
    // SAFETY: Each member keeps its declared shape while native iteration sees its bound methods.
    return value.map((entry) => wrap(entry)) as T;
  };
  const wrapResult = <T>(result: T, callerData?: unknown[], executable = false): T => {
    const completion = resolvePluginReturnPromise(result);
    if (completion) {
      const pending = mapPluginReturnPromise(completion, (resolved) =>
        executable ? bindFactoryResult(resolved) : passResult(resolved),
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
        ? bindFactoryResult(result)
        : passResult(result);
  };

  /** Callables retain their instance; schemas remain data for host validators. */
  const wrap = <T>(value: T, field = "", callbackIndex?: 0 | null): T => {
    if ((!value || typeof value !== "object") && typeof value !== "function") {
      return value;
    }
    // Native APIs and structuredClone reject Proxy data, including byte views.
    if (DATA_FIELDS.has(field) || (typeof value === "object" && isNativePluginData(value))) {
      return value;
    }
    const object: object = value;
    if (ExecutableBinding.belongsTo(object, factory)) {
      return value;
    }
    const cached = wrapped.get(object);
    if (cached) {
      // SAFETY: The cache stores only the view created for this exact input value.
      return cached as T;
    }
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
        property = readPluginMember(object, key, invoke, resolvedReceiver);
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
      const kind = hasProxyPrototype(object) ? invoke(classify) : classify();
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
                  if (isFactory(result)) {
                    factories.add(source);
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
            pluginMemberDescriptor(object, key)?.set ? resolveReceiver(key, receiver) : receiver,
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
                isFactory(result),
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
    void new ExecutableBinding(result, factory);
    setPluginOriginalValue(result, object, bindings.instance);
    valueInstances.setHost(result, bindings.instance);
    // SAFETY: The view retains the input prototype and routes each member to the original object.
    return result as T;
  };

  const admitIterator = (iterator: object): PluginIteratorAdmission => {
    const current = iterators.get(iterator);
    if (current?.active || current?.done) {
      return current;
    }
    const create = () => admit(() => createIteratorAdmission(iterator, current));
    return current ? current.reenter(create) : create();
  };

  const createIteratorAdmission = (
    iterator: object,
    previous?: PluginIteratorAdmission,
  ): PluginIteratorAdmission => {
    const { token, release } = bindings.lease();
    let invocation: ReturnType<typeof prepareInvocation>;
    try {
      invocation = prepareInvocation(token, previous?.origin);
    } catch (error) {
      void release();
      throw error;
    }
    let state: "open" | "returned" | "done" = "open";
    let active = true;
    let pending = 0;
    let closed = false;
    const settle = () => {
      if (state === "done" && pending === 0 && !closed) {
        closed = true;
        invocation.close();
      }
      if (state !== "open" && pending === 0 && active) {
        active = false;
        return release();
      }
      return undefined;
    };
    const releaseOperation = () => {
      pending -= 1;
      return settle();
    };
    const assertActive = () => {
      if (!active || !bindings.hasToken(token)) {
        throw new Error(`Plugin ${bindings.instance.pluginId} stream is closed`);
      }
    };
    const invoke = <T>(run: () => T): T => {
      pending += 1;
      try {
        try {
          assertActive();
          invocation.assertCurrent();
        } catch (error) {
          state = "done";
          throw error;
        }
        return invocation.run(() => {
          const result = run();
          const completion = resolvePluginReturnPromise(result);
          if (completion) {
            const settled = mapPluginReturnPromise(
              completion,
              async (value) => {
                await releaseOperation();
                return value;
              },
              async (error: unknown) => {
                await releaseOperation()?.catch(() => {});
                throw error;
              },
            );
            // SAFETY: Promise-like reads keep their resolved value while settling the stream lease.
            return settled.value as T;
          }
          void releaseOperation();
          return result;
        });
      } catch (error) {
        void releaseOperation();
        throw error;
      }
    };
    const admission: PluginIteratorAdmission = {
      origin: invocation.origin,
      reenter: (run) => {
        try {
          invocation.assertCurrent();
          return invocation.reenter(run);
        } catch (error) {
          state = "done";
          void settle();
          throw error;
        }
      },
      get done() {
        return state === "done";
      },
      get active() {
        return active;
      },
      invoke,
      close: () => {
        state = "done";
        void settle();
      },
      call: (key, method, args) => {
        // Completed return is protocol cleanup and executes no plugin code.
        if (state === "done" && key === "return") {
          return Promise.resolve(args[0]).then((value) => ({ done: true, value }));
        }
        if (state === "done") {
          // Preserve terminal results without reentering source methods or getters.
          return Promise.resolve().then(() =>
            admit(() => {
              if (key === "throw") {
                throw args[0];
              }
              return { done: true, value: undefined };
            }),
          );
        }
        try {
          assertActive();
          invocation.assertCurrent();
          return invocation.run(async () => {
            pending += 1;
            try {
              if (!method) {
                if (key === "return") {
                  state = "done";
                  return { done: true, value: await args[0] };
                }
                throw new TypeError("Plugin iterator method must be callable");
              }
              const next: unknown = await Reflect.apply(method, iterator, args);
              if (next === null || (typeof next !== "object" && typeof next !== "function")) {
                throw new TypeError("Plugin async iterator result must be an object");
              }
              assertActive();
              state = Reflect.get(next, "done") ? "done" : key === "return" ? "returned" : state;
              return next;
            } catch (error) {
              state = "done";
              throw error;
            } finally {
              const completion = releaseOperation();
              if (completion) {
                await completion;
              }
            }
          });
        } catch (error) {
          state = "done";
          const reject = () => {
            throw error;
          };
          return Promise.resolve(settle()).then(reject, reject);
        }
      },
    };
    iterators.set(iterator, admission);
    previous?.close();
    return admission;
  };

  return wrap;
}
