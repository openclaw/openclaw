export function resolveGlobalSingleton<T>(key: symbol, create: () => T): T {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[key] as T | undefined;
  if (Object.prototype.hasOwnProperty.call(globalStore, key)) {
    return existing;
  }
  const created = create();
  globalStore[key] = created;
  return created;
}

export function resolveGlobalMap<TKey, TValue>(key: symbol): Map<TKey, TValue> {
  return resolveGlobalSingleton(key, () => new Map<TKey, TValue>());
}
