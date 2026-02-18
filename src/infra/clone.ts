/**
 * Fast Clone Utilities
 * Optimized shallow/deep clone operations to replace costly structuredClone
 */

export function shallowClone<T extends object>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return [...obj] as T;
  }
  return { ...obj };
}

export function shallowCloneMap<K, V>(map: Map<K, V>): Map<K, V> {
  return new Map(map);
}

export function shallowCloneSet<T>(set: Set<T>): Set<T> {
  return new Set(set);
}

export function freeze<T extends object>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    Object.freeze(obj);
    return obj as Readonly<T>;
  }
  return Object.freeze(obj);
}

export function cloneWithFreeze<T extends object>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    const cloned = [...obj];
    Object.freeze(cloned);
    return cloned as unknown as Readonly<T>;
  }
  const cloned = { ...obj };
  Object.freeze(cloned);
  return cloned as Readonly<T>;
}
