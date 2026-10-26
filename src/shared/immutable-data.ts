import { isProxy } from "node:util/types";

const MAX_FROZEN_PLAIN_DATA_ADMISSIONS = 256 * 1024;
let deeplyFrozenPlainData = new WeakSet<object>();
let frozenPlainDataAdmissions = 0;

function boundFrozenPlainData(root: object): void {
  // Dead weak keys can leave a large backing table behind. Evict only after the
  // traversal finishes: trusted freezing also uses this set to stop cycles.
  if (frozenPlainDataAdmissions > MAX_FROZEN_PLAIN_DATA_ADMISSIONS) {
    deeplyFrozenPlainData = new WeakSet([root]);
    frozenPlainDataAdmissions = 1;
  }
}

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
  if (plain && (freeze || requireFrozen)) {
    for (const candidate of inspected) {
      deeplyFrozenPlainData.add(candidate);
    }
    frozenPlainDataAdmissions += inspected.size;
    boundFrozenPlainData(value);
  }
  return plain;
}

/** Inspect mutable plain graphs without caching them or reading accessors. */
export function isPlainData(value: unknown): boolean {
  return inspectPlainData(value, false, false);
}

/** Memoized proofs use weak keys and can be evicted without changing graph immutability. */
export function isDeeplyFrozenPlainData(value: unknown): boolean {
  return inspectPlainData(value, false);
}

/** Freeze an owner's cloned JSON snapshot without executing opaque members. */
export function freezeJsonSnapshot<T>(value: T): T {
  inspectPlainData(value, true);
  return value;
}

/** Freeze decoded/internal JSON only; callers own the plain-data guarantee. */
export function freezeTrustedJsonSnapshot<T>(value: T): T {
  if (!value || typeof value !== "object" || deeplyFrozenPlainData.has(value)) {
    return value;
  }
  Object.freeze(value);
  deeplyFrozenPlainData.add(value);
  frozenPlainDataAdmissions++;
  const pending: object[] = [value];
  while (pending.length) {
    const candidate = pending.pop()!;
    for (const key in candidate) {
      const child: unknown = Reflect.get(candidate, key);
      if (child && typeof child === "object" && !deeplyFrozenPlainData.has(child)) {
        // Admit before queuing so shared frozen tails and cycles need no work item.
        Object.freeze(child);
        deeplyFrozenPlainData.add(child);
        frozenPlainDataAdmissions++;
        pending.push(child);
      }
    }
  }
  boundFrozenPlainData(value);
  return value;
}

/** Reuse a pure projection only while its entire source graph is immutable. */
export function memoizeFrozenPlainDataProjection<T extends object, R>(
  project: (source: T) => R,
): (source: T) => R {
  const projections = new WeakMap<T, R>();
  return (source) => {
    if (projections.has(source)) {
      return projections.get(source)!;
    }
    if (!isDeeplyFrozenPlainData(source)) {
      return project(source);
    }
    const projected = freezeJsonSnapshot(project(source));
    projections.set(source, projected);
    return projected;
  };
}
