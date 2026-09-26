import { types } from "node:util";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";

/** Restore opaque handles only when they return to the instance that created their view. */
function restorePluginArgumentViews(
  args: unknown[],
  originals: WeakMap<object, object>,
): unknown[] {
  // Callable arguments are handled separately; only objects can contain opaque handles.
  if (!args.some((value) => value !== null && typeof value === "object")) {
    return args;
  }
  // Parents are plain records or arrays; a Set represents multiple parents.
  const parents = new Map<object, object | Set<object> | undefined>();
  const replacements = new Map<object, object>();
  const visit = (value: unknown, parent?: object) => {
    if (!value || typeof value !== "object") {
      return;
    }
    if (!parents.has(value)) {
      let original = originals.get(value);
      // Collapse only this instance's object views; callable restoration keeps its separate guard.
      while (original && typeof original === "object") {
        const previous = originals.get(original);
        if (!previous || typeof previous !== "object") {
          break;
        }
        original = previous;
      }
      if (!original) {
        if (isDeeplyFrozenPlainData(value)) {
          return;
        }
        if (types.isProxy(value)) {
          return;
        }
        const prototype = Object.getPrototypeOf(value);
        if (
          prototype !== null &&
          prototype !== Object.prototype &&
          !(Array.isArray(value) && prototype === Array.prototype)
        ) {
          return;
        }
      }
      const keys = original ? undefined : Reflect.ownKeys(value);
      let firstChild: object | undefined;
      let moreChildren: object[] | undefined;
      // Caller methods and accessors can depend on this exact object's identity.
      // Keep their containers opaque instead of cloning them to restore a nested handle.
      if (keys) {
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!("value" in descriptor) || typeof descriptor.value === "function") {
            return;
          }
          if (descriptor.value && typeof descriptor.value === "object") {
            if (firstChild === undefined) {
              firstChild = descriptor.value;
            } else {
              (moreChildren ??= []).push(descriptor.value);
            }
          }
        }
      }
      parents.set(value, parent);
      if (original) {
        replacements.set(value, original);
      } else {
        // Descend only after every member passed the data-only check.
        if (firstChild) {
          visit(firstChild, value);
        }
        if (moreChildren) {
          for (const child of moreChildren) {
            visit(child, value);
          }
        }
      }
    } else if (parent) {
      const previous = parents.get(value);
      if (!previous) {
        parents.set(value, parent);
      } else if (previous !== parent) {
        // Most data is a tree; only shared children need a parent collection.
        if (previous instanceof Set) {
          previous.add(parent);
        } else {
          parents.set(value, new Set([previous, parent]));
        }
      }
    }
  };
  args.forEach((value) => visit(value));
  // Copy only changed ancestors; visiting all parents also preserves cycles and shared children.
  for (const value of replacements.keys()) {
    const owners = parents.get(value);
    for (const parent of owners instanceof Set ? owners : owners ? [owners] : []) {
      if (!replacements.has(parent)) {
        replacements.set(
          parent,
          Array.isArray(parent) ? [] : Object.create(Object.getPrototypeOf(parent)),
        );
      }
    }
  }
  for (const [value, replacement] of replacements) {
    if (!originals.has(value)) {
      // The synchronous, data-only walk executes no caller code. Read descriptors
      // only for copied ancestors instead of retaining them for the entire input.
      const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key]!;
        descriptor.value = replacements.get(descriptor.value) ?? descriptor.value;
      }
      Object.defineProperties(replacement, descriptors);
    }
  }
  return args.map((value) =>
    value && typeof value === "object" ? (replacements.get(value) ?? value) : value,
  );
}

/** Preserves caller data and caches callback views within one instance. */
export function createPluginArgumentView(bindings: {
  originalValues: WeakMap<object, object>;
  isWrapped: (value: object) => boolean;
  wrap: <T>(value: T) => T;
  invoke: <T>(run: () => T) => T;
}) {
  const callbacks = new WeakMap<Function, Function>();
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
          value && (typeof value === "object" || typeof value === "function")
            ? (bindings.originalValues.get(value) ?? value)
            : value,
        ),
      };
    }
    const callerData =
      callbackIndex === 0 && (field === "reduce" || field === "reduceRight")
        ? args.slice(1, 2)
        : undefined;
    const callArgs =
      callbackIndex === undefined
        ? restorePluginArgumentViews(args, bindings.originalValues)
        : args;
    const prepared = callArgs.map((value, index) => {
      if (typeof value !== "function" || (callbackIndex !== undefined && index !== callbackIndex)) {
        return value;
      }
      // Returned handles regain identity only in their own instance. One hop preserves
      // the guarded callback when the plugin returned an incoming caller callback.
      if (callbackIndex === undefined && bindings.isWrapped(value)) {
        return bindings.originalValues.get(value) ?? value;
      }
      let callback = callerData ? undefined : callbacks.get(value);
      if (!callback) {
        const invoke = <R>(values: unknown[], run: (values: unknown[]) => R): R =>
          bindings.invoke(() =>
            run(
              values.map((entry, position) =>
                position === 0 && callerData?.includes(entry) ? entry : bindings.wrap(entry),
              ),
            ),
          );
        // Caller objects and receivers stay native; only values delivered back through callbacks are owned.
        callback = new Proxy(value, {
          apply: (target, receiver, values) => {
            const result = invoke(values, (wrapped) => Reflect.apply(target, receiver, wrapped));
            // Native reducers deliver this exact caller value as the next and final accumulator.
            if (callerData) {
              callerData[0] = result;
            }
            return result;
          },
          construct: (target, values, newTarget) =>
            invoke(values, (wrapped) =>
              Reflect.construct(target, wrapped, newTarget === callback ? target : newTarget),
            ),
        });
        bindings.originalValues.set(callback, value);
        if (!callerData) {
          callbacks.set(value, callback);
          callbacks.set(callback, callback);
        }
      }
      return callback;
    });
    return { args: prepared, callerData };
  };
}
