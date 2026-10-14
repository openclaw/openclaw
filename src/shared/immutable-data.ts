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

function inspectPlainData(value: unknown, freeze: boolean, requireFrozen = true): boolean {
  if (!value || typeof value !== "object") {
    return typeof value !== "function";
  }
  if (deeplyFrozenPlainData.has(value)) {
    return true;
  }
  if (!freeze && requireFrozen && (isProxy(value) || !Object.isFrozen(value))) {
    return false;
  }
  let plain = true;
  const inspected = new Set<object>();
  const pending = [value];
  while (pending.length) {
    const candidate = pending.pop()!;
    if (inspected.has(candidate)) {
      continue;
    }
    if (!isPlainDataObject(candidate)) {
      if (!freeze) {
        return false;
      }
      plain = false;
      continue;
    }
    if (!freeze && requireFrozen && !Object.isFrozen(candidate)) {
      return false;
    }
    inspected.add(candidate);
    // Direct members disprove the container before queued child graphs are inspected.
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
      const member: unknown = descriptor.value;
      if (!("value" in descriptor) || typeof member === "function") {
        if (!freeze) {
          return false;
        }
        plain = false;
        continue;
      }
      if (member && typeof member === "object" && !deeplyFrozenPlainData.has(member)) {
        pending.push(member);
      }
    }
    if (freeze) {
      Object.freeze(candidate);
    }
  }
  // A cycle is proven only when every reachable member passes, not on a back edge.
  if (plain && freeze) {
    deeplyFrozenPlainData.add(value);
  } else if (plain && requireFrozen) {
    for (const candidate of inspected) {
      deeplyFrozenPlainData.add(candidate);
    }
  }
  return plain;
}

/** Inspect mutable plain graphs without caching them or reading accessors. */
export function isPlainData(value: unknown): boolean {
  return inspectPlainData(value, false, false);
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
