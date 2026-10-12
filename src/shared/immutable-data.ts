import { isProxy } from "node:util/types";

const deeplyFrozenPlainData = new WeakSet<object>();

function isPlainDataObject(value: object): boolean {
  if (isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === null ||
    prototype === Object.prototype ||
    (Array.isArray(value) && prototype === Array.prototype)
  );
}

function inspectPlainData(value: unknown, freeze: boolean): boolean {
  if (!value || typeof value !== "object") {
    return typeof value !== "function";
  }
  if (deeplyFrozenPlainData.has(value)) {
    return true;
  }
  let plain = true;
  const inspected = new Set<object>();
  const pending = [value];
  while (pending.length) {
    const candidate = pending.pop()!;
    if (inspected.has(candidate) || deeplyFrozenPlainData.has(candidate)) {
      continue;
    }
    if (!isPlainDataObject(candidate)) {
      if (!freeze) {
        return false;
      }
      plain = false;
      continue;
    }
    if (!freeze && !Object.isFrozen(candidate)) {
      return false;
    }
    inspected.add(candidate);
    // Direct members disprove the container before queued child graphs are inspected.
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
      if (!("value" in descriptor) || typeof descriptor.value === "function") {
        if (!freeze) {
          return false;
        }
        plain = false;
        continue;
      }
      if (
        descriptor.value &&
        typeof descriptor.value === "object" &&
        !deeplyFrozenPlainData.has(descriptor.value)
      ) {
        pending.push(descriptor.value);
      }
    }
    if (freeze) {
      Object.freeze(candidate);
    }
  }
  // A cycle is proven only when every reachable member passes, not on a back edge.
  if (plain) {
    if (freeze) {
      // Freezing publishes a root; admission can memoize descendants when they are consumed.
      deeplyFrozenPlainData.add(value);
    } else {
      for (const candidate of inspected) {
        deeplyFrozenPlainData.add(candidate);
      }
    }
  }
  return plain;
}

/** Immutable graphs keep their classification for exactly as long as their objects live. */
export function isDeeplyFrozenPlainData(value: unknown): boolean {
  return inspectPlainData(value, false);
}

/** Freeze an owner's cloned JSON snapshot without executing opaque members. */
export function freezeJsonSnapshot<T>(value: T): T {
  inspectPlainData(value, true);
  return value;
}
