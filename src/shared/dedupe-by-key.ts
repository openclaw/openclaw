export function indexFirstByKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): Map<string, T> {
  const deduped = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return deduped;
}

export function dedupeByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  return [...indexFirstByKey(items, keyOf).values()];
}
