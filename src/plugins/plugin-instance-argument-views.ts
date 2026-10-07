import { types } from "node:util";
import { PluginHostObject } from "./plugin-instance-owned-values.js";

class CallbackView extends PluginHostObject {
  #factory: object;

  constructor(value: Function, factory: object) {
    super(value);
    this.#factory = factory;
  }

  static belongsTo(value: Function, factory: object): boolean {
    return #factory in value && value.#factory === factory;
  }
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

/** Native signatures distinguish callbacks, stored callables, and function invocation helpers. */
export function getPluginMethodArgumentKind(
  object: object,
  key: PropertyKey,
): 0 | null | "function" | undefined {
  const array = Array.isArray(object);
  const intrinsic =
    typeof object === "function"
      ? Function.prototype
      : array
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
  if (typeof object === "function") {
    return "function";
  }
  return key === "forEach" || (array && typeof key === "string" && arrayCallbacks.has(key))
    ? 0
    : null;
}

/** Preserves caller data and caches callback views within one instance. */
export function createPluginArgumentView(bindings: {
  original: (value: object) => object | undefined;
  setOriginal: (value: object, original: object) => void;
  isWrapped: (value: object) => boolean;
  invoke: <T>(run: () => T) => T;
}) {
  const restoreHandle = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") {
      return value;
    }
    let source: object = value;
    for (let original = bindings.original(source); original; original = bindings.original(source)) {
      source = original;
    }
    return source;
  };
  const callbacks = new WeakMap<Function, Function>();
  const factory = {};
  return (
    args: unknown[],
    callbackIndex?: 0 | null,
    field = "",
  ): {
    args: unknown[];
    callerData?: unknown[];
  } => {
    if (callbackIndex === null || args.length === 0) {
      return {
        args: args.map((value) =>
          typeof value === "function" ? (bindings.original(value) ?? value) : restoreHandle(value),
        ),
      };
    }
    const callerData =
      callbackIndex === 0 && (field === "reduce" || field === "reduceRight")
        ? args.slice(1, 2)
        : undefined;
    const prepared = args.map((value, index) => {
      if (typeof value !== "function" || (callbackIndex !== undefined && index !== callbackIndex)) {
        return restoreHandle(value);
      }
      // Returned handles regain identity only in their own instance. One hop preserves
      // the guarded callback when the plugin returned an incoming caller callback.
      if (callbackIndex === undefined && bindings.isWrapped(value)) {
        return bindings.original(value) ?? value;
      }
      let callback = callerData
        ? undefined
        : CallbackView.belongsTo(value, factory)
          ? value
          : callbacks.get(value);
      if (!callback) {
        // Callback delivery retains its invocation; arguments and receivers stay native.
        callback = new Proxy(value, {
          apply: (target, receiver, values) => {
            const result = bindings.invoke(() => Reflect.apply(target, receiver, values));
            // Native reducers deliver this exact caller value as the next and final accumulator.
            if (callerData) {
              callerData[0] = result;
            }
            return result;
          },
          construct: (target, values, newTarget) =>
            bindings.invoke(() =>
              Reflect.construct(target, values, newTarget === callback ? target : newTarget),
            ),
        });
        bindings.setOriginal(callback, value);
        if (!callerData) {
          callbacks.set(value, callback);
          void new CallbackView(callback, factory);
        }
      }
      return callback;
    });
    return { args: prepared, callerData };
  };
}
