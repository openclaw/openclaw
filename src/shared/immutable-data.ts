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

/** Immutable graphs keep their classification for exactly as long as their objects live. */
export function isDeeplyFrozenPlainData(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return typeof value !== "function";
  }
  if (deeplyFrozenPlainData.has(value)) {
    return true;
  }
  if (!isPlainDataObject(value) || !Object.isFrozen(value)) {
    return false;
  }
  const inspected = new Set<object>();
  const pending = [value];
  while (pending.length) {
    const candidate = pending.pop()!;
    if (inspected.has(candidate)) {
      continue;
    }
    if (!isPlainDataObject(candidate) || !Object.isFrozen(candidate)) {
      return false;
    }
    inspected.add(candidate);
    const childStart = pending.length;
    // Direct members disprove the container before queued child graphs are inspected.
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
      if (!("value" in descriptor) || typeof descriptor.value === "function") {
        return false;
      }
      if (
        descriptor.value &&
        typeof descriptor.value === "object" &&
        !deeplyFrozenPlainData.has(descriptor.value)
      ) {
        pending.push(descriptor.value);
      }
    }
    // Keep depth-first child order without retaining a separate list per container.
    for (let left = childStart, right = pending.length - 1; left < right; left++, right--) {
      const child = pending[left]!;
      pending[left] = pending[right]!;
      pending[right] = child;
    }
  }
  // A cycle is proven only when every reachable member passes, not on a back edge.
  for (const candidate of inspected) {
    deeplyFrozenPlainData.add(candidate);
  }
  return true;
}

/** Freeze an owner's cloned JSON snapshot without executing opaque members. */
export function freezeJsonSnapshot<T>(value: T): T {
  const seen = new Set<object>();
  const visit = (candidate: unknown) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      seen.has(candidate) ||
      deeplyFrozenPlainData.has(candidate) ||
      !isPlainDataObject(candidate)
    ) {
      return;
    }
    seen.add(candidate);
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
      if ("value" in descriptor) {
        visit(descriptor.value);
      }
    }
    Object.freeze(candidate);
  };
  visit(value);
  return value;
}
