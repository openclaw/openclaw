// Callable value views preserve plugin admission and native data/receiver contracts.
import { types } from "node:util";
import { createPluginArgumentView } from "./plugin-instance-argument-views.js";
import { pluginInstanceState, type PluginInstanceHandle } from "./plugin-instance-scope.js";
import type { PluginInstanceCallLease, PluginIteratorAdmission } from "./plugin-instance.types.js";
import { resolvePluginReturnPromise } from "./plugin-return-value.js";

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

function isPluginData(value: unknown, seen?: Set<object>): boolean {
  if (!value || typeof value !== "object") {
    return typeof value !== "function";
  }
  if (types.isProxy(value)) {
    return false;
  }
  if (
    types.isAnyArrayBuffer(value) ||
    types.isArrayBufferView(value) ||
    types.isDate(value) ||
    types.isRegExp(value) ||
    types.isNativeError(value)
  ) {
    return true;
  }
  if (seen?.has(value)) {
    return true;
  }
  const native = Array.isArray(value)
    ? Array
    : types.isMap(value)
      ? Map
      : types.isSet(value)
        ? Set
        : Object;
  const prototype = Object.getPrototypeOf(value);
  if (prototype && types.isProxy(prototype)) {
    return false;
  }
  const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  // Same-engine realm intrinsics share native source; subclasses retain their own executable source.
  if (
    prototype !== null &&
    (typeof constructor !== "function" ||
      (constructor !== native &&
        Function.prototype.toString.call(constructor) !==
          Function.prototype.toString.call(native)) ||
      Object.getOwnPropertyDescriptor(constructor, "prototype")?.value !== prototype)
  ) {
    return false;
  }
  let firstChild: object | undefined;
  let moreChildren: object[] | undefined;
  // A callable or accessor already requires a view. Check direct members before
  // walking large data graphs attached to tool metadata and execution contexts.
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || typeof descriptor.value === "function") {
      return false;
    }
    if (descriptor.value && typeof descriptor.value === "object") {
      if (firstChild === undefined) {
        firstChild = descriptor.value;
      } else {
        (moreChildren ??= []).push(descriptor.value);
      }
    }
  }
  if (!firstChild && native !== Map && native !== Set) {
    // Repeated leaves in an existing graph still share its completed classification.
    seen?.add(value);
    return true;
  }
  const visited = seen ?? new Set<object>();
  visited.add(value);
  if (firstChild && !isPluginData(firstChild, visited)) {
    return false;
  }
  if (moreChildren) {
    for (const child of moreChildren) {
      if (!isPluginData(child, visited)) {
        return false;
      }
    }
  }
  // Stream collection members so an early callable does not materialize every
  // entry, and Set members do not allocate duplicate key/value pairs.
  if (native === Map) {
    for (const [key, entry] of Map.prototype.entries.call(value)) {
      if (!isPluginData(key, visited) || !isPluginData(entry, visited)) {
        return false;
      }
    }
  } else if (native === Set) {
    for (const entry of Set.prototype.values.call(value)) {
      if (!isPluginData(entry, visited)) {
        return false;
      }
    }
  }
  return true;
}

const arrayCallbacks = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
  "sort",
  "toSorted",
]);

/** Native collection signatures distinguish callbacks from callable keys and stored values. */
function collectionCallbackIndex(object: object, key: PropertyKey): 0 | null | undefined {
  const array = Array.isArray(object);
  const intrinsic = array
    ? Array.prototype
    : types.isMap(object)
      ? Map.prototype
      : types.isSet(object)
        ? Set.prototype
        : types.isWeakMap(object)
          ? WeakMap.prototype
          : types.isWeakSet(object)
            ? WeakSet.prototype
            : undefined;
  if (!intrinsic || !Object.hasOwn(intrinsic, key)) {
    return undefined;
  }
  let prototype: object | null = object;
  while (prototype && !Object.hasOwn(prototype, key)) {
    prototype = Object.getPrototypeOf(prototype);
  }
  const parent = prototype && Object.getPrototypeOf(prototype);
  // Intrinsic collection prototypes directly inherit their realm's Object.prototype.
  // Own/subclass overrides remain ordinary plugin methods, including custom higher-order methods.
  if (!parent || Object.getPrototypeOf(parent) !== null) {
    return undefined;
  }
  return key === "forEach" || (array && typeof key === "string" && arrayCallbacks.has(key))
    ? 0
    : null;
}

function bindNativeReceiver<T, R>(invoke: (receiver: T, args: unknown[]) => R) {
  return function (this: T, ...args: unknown[]): R {
    return invoke(this, args);
  };
}

/** Builds callable views while the exact instance continues to own admission and leases. */
export function createPluginValueView(
  bindings: {
    instance: PluginInstanceHandle;
    originalValues: WeakMap<object, object>;
    invoke: <T>(run: () => T, lease?: PluginInstanceCallLease) => T;
    lease: () => PluginInstanceCallLease;
    hasToken: (token: object) => boolean;
  },
  admit: <T>(run: () => T) => T,
  admitCallback: <T>(run: () => T) => T,
) {
  const wrapped = new WeakMap<object, unknown>();
  const derivedReceivers = new WeakSet<object>();
  const prototypeReceivers = new WeakMap<object, WeakMap<object, object>>();
  const iterators = new WeakMap<object, PluginIteratorAdmission>();
  const wrapArguments = createPluginArgumentView({
    originalValues: bindings.originalValues,
    wrapped,
    wrap: (value) => wrap(value),
    invoke: admitCallback,
  });
  const wrapResult = <T>(result: T, callerData?: unknown[]): T => {
    const completion = resolvePluginReturnPromise(result);
    if (completion) {
      const pending = completion.then((resolved) => wrap(resolved));
      valueInstances.set(pending, bindings.instance);
      // SAFETY: Promise-like results retain their resolved type while callable values stay owned.
      return pending as T;
    }
    return callerData?.includes(result) ? result : wrap(result);
  };

  /** Callables retain their instance; schemas remain data for host validators. */
  const wrap = <T>(value: T, field = "", callbackIndex?: 0 | null): T => {
    if ((!value || typeof value !== "object") && typeof value !== "function") {
      return value;
    }
    // Native APIs and structuredClone reject Proxy data, including byte views.
    if (DATA_FIELDS.has(field) || isPluginData(value)) {
      return value;
    }
    const object: object = value;
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
    const inspectIterable = () => pluginMemberDescriptor(object, Symbol.asyncIterator);
    const iterableDescriptor = pluginMemberNeedsAdmission(object, Symbol.asyncIterator, false)
      ? admit(inspectIterable)
      : inspectIterable();
    const iterable =
      typeof iterableDescriptor?.value === "function" || iterableDescriptor?.get !== undefined;
    const reflect = <R>(run: () => R): R => (types.isProxy(object) ? admit(run) : run());
    const resolveReceiver = (key: PropertyKey, receiver: object) => {
      const receivers = prototypeReceivers.get(object);
      if (receivers) {
        const original = bindings.originalValues.get(receiver) ?? receiver;
        return receivers.get(original) ?? original;
      }
      // Inherited access belongs to the child; exact-view access keeps private fields on the original.
      if (receiver !== object && receiver !== result) {
        return bindings.originalValues.get(receiver) ?? receiver;
      }
      return derivedReceivers.has(object) &&
        (!reflect(() => Object.hasOwn(object, key)) || derivedFields.has(key))
        ? result
        : object;
    };
    const read = (key: PropertyKey, receiver = object) => {
      const protocol = key === "next" || key === "return" || key === "throw";
      const iteration = iterators.get(object);
      if (protocol && iteration?.done) {
        return (...args: unknown[]) => iteration.call(key, undefined, args);
      }
      const invoke = <R>(run: () => R): R =>
        iteration?.active ? iteration.invoke(run) : admit(run);
      let resolvedReceiver = receiver;
      let property: unknown;
      try {
        resolvedReceiver = resolveReceiver(key, receiver);
        property = readPluginMember(object, key, invoke, resolvedReceiver);
      } catch (error) {
        if (key === "return" && iteration?.active) {
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
            ? (...args: unknown[]) =>
                invoke(() => {
                  const iterator: unknown = Reflect.apply(property, resolvedReceiver, args);
                  if (
                    !iterator ||
                    (typeof iterator !== "object" && typeof iterator !== "function")
                  ) {
                    throw new TypeError("Plugin async iterator factory must return an object");
                  }
                  admitIterator(iterator);
                  return wrap(iterator);
                })
            : async (...args: unknown[]) => {
                const current = iterators.get(object);
                const owner =
                  current && (current.active || current.done)
                    ? current
                    : admit(() => admitIterator(object));
                return owner.call(key, property, args);
              };
        methods.set(key, { original: property, receiver: resolvedReceiver, wrapped: bound });
        valueInstances.set(bound, bindings.instance);
        return bound;
      }
      const bind = () =>
        prototypeReceivers.has(object)
          ? new Proxy(property, {
              apply: (target, callReceiver, args) =>
                Reflect.apply(target, resolveReceiver(key, callReceiver), args),
            })
          : Function.prototype.bind.call(property, resolvedReceiver);
      const callback = () => collectionCallbackIndex(object, key);
      const bound = wrap(
        // Our callable views already guard metadata and preserve derived receiver bindings.
        !bindings.originalValues.has(property) &&
          (pluginMemberNeedsAdmission(property, "length") ||
            pluginMemberNeedsAdmission(property, "name"))
          ? invoke(bind)
          : bind(),
        String(key),
        hasProxyPrototype(object) ? invoke(callback) : callback(),
      );
      bindings.originalValues.set(bound, property);
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
          ? admit(() => Reflect.has(object, key))
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
                    admit(() =>
                      Reflect.set(object, key, next, resolveReceiver(key, receiver ?? object)),
                    ),
                  )
                : undefined,
            };
      },
      set: (_target, key, next, receiver) =>
        admit(() =>
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
        admit(() => {
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
      deleteProperty: (_target, key) => admit(() => Reflect.deleteProperty(object, key)),
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
              return wrapResult(Reflect.apply(value, receiver, call.args), call.callerData);
            }),
          construct: (_target, args, newTarget): object =>
            admit(() => {
              const constructed = Reflect.construct(
                value,
                wrapArguments(args, callbackIndex, field).args,
                newTarget === result ? value : newTarget,
              );
              receivers?.set(bindings.originalValues.get(constructed) ?? constructed, constructed);
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
    wrapped.set(result, result);
    bindings.originalValues.set(result, object);
    valueInstances.set(result, bindings.instance);
    // SAFETY: The view retains the input prototype and routes each member to the original object.
    return result as T;
  };

  const admitIterator = (iterator: object): PluginIteratorAdmission => {
    const current = iterators.get(iterator);
    if (current?.active) {
      return current;
    }
    const { token, release } = bindings.lease();
    let state: "open" | "returned" | "done" = "open";
    let active = true;
    let pending = 0;
    const releaseOperation = () => {
      pending -= 1;
      if (state !== "open" && pending === 0 && active) {
        active = false;
        return release();
      }
      return undefined;
    };
    const assertActive = () => {
      if (!active || !bindings.hasToken(token)) {
        throw new Error(`Plugin ${bindings.instance.pluginId} stream is closed`);
      }
    };
    const invoke = <T>(run: () => T): T => {
      assertActive();
      pending += 1;
      return bindings.invoke(run, { token, release: releaseOperation });
    };
    const readResultMember = (result: object, key: "done" | "value"): unknown => {
      assertActive();
      const descriptor = !types.isProxy(result) && Object.getOwnPropertyDescriptor(result, key);
      if (descriptor && "value" in descriptor) {
        const value: unknown = descriptor.value;
        // Primitive data cannot execute plugin code or require thenable settlement.
        if (value === null || (typeof value !== "object" && typeof value !== "function")) {
          return value;
        }
      }
      return invoke(() => Reflect.get(result, key));
    };
    const admission: PluginIteratorAdmission = {
      get done() {
        return state === "done";
      },
      get active() {
        return active;
      },
      invoke,
      close: () =>
        invoke(() => {
          state = "done";
        }),
      call: async (key, method, args) => {
        // Completed return is protocol cleanup and executes no plugin code.
        if (state === "done" && key === "return") {
          return { done: true, value: await args[0] };
        }
        if (state === "done") {
          // Preserve terminal results without reentering source methods or getters.
          return admit(() => {
            if (key === "throw") {
              throw args[0];
            }
            return { done: true, value: undefined };
          });
        }
        return invoke(async () => {
          try {
            if (!method) {
              if (key === "return") {
                state = "done";
                return { done: true, value: await args[0] };
              }
              throw new TypeError("Plugin iterator method must be callable");
            }
            const next: unknown = await wrapResult(Reflect.apply(method, iterator, args));
            if (next === null || (typeof next !== "object" && typeof next !== "function")) {
              throw new TypeError("Plugin async iterator result must be an object");
            }
            const complete = Boolean(readResultMember(next, "done"));
            // IteratorClose ends this admission even when a generator yields in finally.
            // A later explicit next can acquire a new lease only while the instance is live.
            state = complete ? "done" : key === "return" ? "returned" : state;
            return {
              // The consumer reads completion after the last call may have joined disposal.
              done: complete,
              get value() {
                return active ? readResultMember(next, "value") : Reflect.get(next, "value");
              },
            };
          } catch (error) {
            state = "done";
            throw error;
          }
        });
      },
    };
    iterators.set(iterator, admission);
    return admission;
  };

  return wrap;
}
