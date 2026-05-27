export function resolveProcessScopedMap<T>(key: symbol): Map<string, T> {
  const proc = process as NodeJS.Process & {
    [symbolKey: symbol]: Map<string, T> | undefined;
  };
  const existing = proc[key];
  if (existing) {
    return existing;
  }
  const created = new Map<string, T>();
  proc[key] = created;
  return created;
}
