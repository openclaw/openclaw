import type { PluginHookName } from "./types.js";

export class HookIsolationError extends Error {}

function containsSharedMemory(value: unknown, seen: Set<object>, sourceData = false): boolean {
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (ArrayBuffer.isView(value)) {
    // Native clones read backing slots, not custom view properties or accessors.
    const prototype =
      value instanceof DataView ? DataView.prototype : Object.getPrototypeOf(Uint8Array.prototype);
    return (
      typeof SharedArrayBuffer !== "undefined" &&
      Reflect.get(prototype, "buffer", value) instanceof SharedArrayBuffer
    );
  }
  if (value instanceof ArrayBuffer) {
    return false;
  }
  const webAssemblyMemory = (
    globalThis as unknown as {
      WebAssembly?: { Memory?: { new (...args: unknown[]): object; prototype: object } };
    }
  ).WebAssembly?.Memory;
  if (
    webAssemblyMemory &&
    value instanceof webAssemblyMemory &&
    typeof SharedArrayBuffer !== "undefined"
  ) {
    if (Reflect.get(webAssemblyMemory.prototype, "buffer", value) instanceof SharedArrayBuffer) {
      return true;
    }
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (value instanceof Map) {
    const entries = Map.prototype.entries.call(value) as IterableIterator<[unknown, unknown]>;
    for (const [key, entry] of entries) {
      if (
        containsSharedMemory(key, seen, sourceData) ||
        containsSharedMemory(entry, seen, sourceData)
      ) {
        return true;
      }
    }
    return false;
  }
  if (value instanceof Set) {
    const entries = Set.prototype.values.call(value) as IterableIterator<unknown>;
    for (const entry of entries) {
      if (containsSharedMemory(entry, seen, sourceData)) {
        return true;
      }
    }
    return false;
  }
  if (sourceData && !(value instanceof Error) && !Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    // Non-plain values retain their native clone semantics. Inspect their
    // actual snapshots below rather than their ignored custom properties.
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const crossesBoundary =
      !sourceData ||
      (value instanceof Error
        ? key === "cause"
        : typeof key === "string" && descriptor?.enumerable);
    if (
      crossesBoundary &&
      descriptor &&
      "value" in descriptor &&
      containsSharedMemory(descriptor.value, seen, sourceData)
    ) {
      return true;
    }
  }
  return false;
}

export function cloneHookIsolationValue<T>(hookName: PluginHookName, value: T): T {
  try {
    // The pinned Bun clone omits Error.cause. Validate source data edges too;
    // accessors are evaluated only once, by the native clone below.
    if (containsSharedMemory(value, new Set<object>(), true)) {
      throw new TypeError("shared memory cannot be isolated");
    }
    const cloned = structuredClone(value);
    // Inspect exactly what crosses the boundary, including values produced by getters.
    if (containsSharedMemory(cloned, new Set<object>())) {
      throw new TypeError("shared memory cannot be isolated");
    }
    return cloned;
  } catch (cause) {
    throw new HookIsolationError(`[hooks] ${hookName} mutable input isolation failed`, { cause });
  }
}
