/** Prunes a Map in insertion order until it fits the requested maximum size. */
export function pruneMapToMaxSize<K, V>(map: Map<K, V>, maxSize: number): void {
  if (Number.isNaN(maxSize) || maxSize === Number.POSITIVE_INFINITY) {
    // Treat "unknown" or unlimited sizes as no-op so callers can wire optional caps directly.
    return;
  }
  const limit = Math.max(0, Math.floor(maxSize));
  if (limit <= 0) {
    map.clear();
    return;
  }

  // Reuse the insertion-order cursor so bulk pruning does not restart at deleted entries.
  for (const key of map.keys()) {
    if (map.size <= limit) {
      break;
    }
    map.delete(key);
  }
}

/** Remembers a key as newest and evicts oldest keys beyond the caller's bound. */
export function touchBoundedSet(keys: Set<string>, key: string, maxSize: number): void {
  keys.delete(key);
  keys.add(key);
  while (keys.size > maxSize) {
    const oldest = keys.values().next().value;
    if (oldest === undefined) {
      break;
    }
    keys.delete(oldest);
  }
}
