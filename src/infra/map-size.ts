export function pruneMapToMaxSize<K, V>(map: Map<K, V>, maxSize: number): void {
  const limit = Math.max(0, Math.floor(maxSize));
  if (limit <= 0) {
    map.clear();
    return;
  }
  if (map.size <= limit) {
    return;
  }
  const deleteCount = map.size - limit;
  let i = 0;
  for (const key of map.keys()) {
    if (i++ >= deleteCount) break;
    map.delete(key);
  }
}
