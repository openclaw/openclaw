export function resolveProcessScopedSingleton<T>(key: symbol, create: () => T): T {
  const proc = process as NodeJS.Process & {
    [symbolKey: symbol]: T | undefined;
  };
  const existing = proc[key];
  if (existing !== undefined) {
    return existing;
  }
  const created = create();
  proc[key] = created;
  return created;
}

export function resolveProcessScopedMap<T>(key: symbol): Map<string, T> {
  return resolveProcessScopedSingleton(key, () => new Map<string, T>());
}

export function resolveProcessScopedSet<T>(key: symbol): Set<T> {
  return resolveProcessScopedSingleton(key, () => new Set<T>());
}
