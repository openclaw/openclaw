/// <reference lib="es2024.collection" />

export function disambiguate<T>(
  items: readonly T[],
  label: (item: T) => string,
  candidates: ReadonlyArray<(item: T) => string | undefined>,
): Array<string | undefined> {
  const suffixes: Array<string | undefined> = items.map(() => undefined);
  const fallback = candidates.at(-1);
  if (!fallback) {
    return suffixes;
  }
  const groups = Map.groupBy(items.keys(), (index) => label(items[index]!));
  for (const indices of groups.values()) {
    if (indices.length < 2) {
      continue;
    }
    for (const candidate of candidates) {
      const values = new Set<string | undefined>();
      for (const index of indices) {
        const item = items[index]!;
        const suffix = candidate(item) ?? fallback(item);
        suffixes[index] = suffix;
        values.add(suffix);
      }
      if (!values.has(undefined) && values.size === indices.length) {
        break;
      }
    }
  }
  return suffixes;
}
