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
  const inspected = new Set<object>();
  const visit = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== "object") {
      return typeof candidate !== "function";
    }
    if (deeplyFrozenPlainData.has(candidate) || inspected.has(candidate)) {
      return true;
    }
    if (!isPlainDataObject(candidate) || !Object.isFrozen(candidate)) {
      return false;
    }
    inspected.add(candidate);
    let firstChild: object | undefined;
    let moreChildren: object[] | undefined;
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
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
    // Opaque members disprove the container before any child graph needs inspection.
    if (firstChild && !visit(firstChild)) {
      return false;
    }
    if (moreChildren) {
      for (const child of moreChildren) {
        if (!visit(child)) {
          return false;
        }
      }
    }
    return true;
  };
  if (!visit(value)) {
    return false;
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
