import type { AnyAgentTool } from "./tools/common.js";

/** Replace executable callbacks without snapshotting lazy, inherited, or Proxy-backed definitions. */
export function overrideAgentToolCallbacks<T extends AnyAgentTool>(
  tool: T,
  callbacks: Partial<
    Pick<
      AnyAgentTool,
      | "execute"
      | "prepareArguments"
      | "prepareBeforeToolCallParams"
      | "finalizeBeforeToolCallParams"
    >
  >,
): T {
  // A shadow preserves frozen factory objects and caller-defined fixed properties without violating Proxy invariants.
  return new Proxy<T>(Object.create(Object.getPrototypeOf(tool)), {
    get(target, key, receiver) {
      if (Object.hasOwn(target, key)) {
        return Reflect.get(target, key, receiver);
      }
      return Object.hasOwn(callbacks, key)
        ? Reflect.get(callbacks, key)
        : Reflect.get(tool, key, tool);
    },
    has: (target, key) => Reflect.has(target, key) || Reflect.has(tool, key),
    ownKeys: (target) => [
      ...new Set([
        ...Reflect.ownKeys(tool),
        ...Reflect.ownKeys(callbacks),
        ...Reflect.ownKeys(target),
      ]),
    ],
    getOwnPropertyDescriptor(target, key) {
      const local = Reflect.getOwnPropertyDescriptor(target, key);
      if (local) {
        return local;
      }
      const source = Reflect.getOwnPropertyDescriptor(tool, key);
      if (Object.hasOwn(callbacks, key)) {
        return {
          configurable: true,
          enumerable: source?.enumerable ?? true,
          writable: true,
          value: Reflect.get(callbacks, key),
        };
      }
      if (!source) {
        return undefined;
      }
      return "value" in source
        ? { ...source, configurable: true }
        : {
            ...source,
            configurable: true,
            get: source.get ? () => Reflect.get(tool, key, tool) : undefined,
            set: source.set
              ? (value) => {
                  Reflect.set(tool, key, value, tool);
                }
              : undefined,
          };
    },
    set: (target, key, value, receiver) =>
      Object.hasOwn(target, key)
        ? Reflect.set(target, key, value, receiver)
        : Reflect.set(tool, key, value, tool),
    deleteProperty: (target, key) =>
      Object.hasOwn(target, key)
        ? Reflect.deleteProperty(target, key)
        : Reflect.deleteProperty(tool, key),
    preventExtensions: () => false,
  });
}
