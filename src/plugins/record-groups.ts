export function groupPluginRecords<T, K>(
  records: Iterable<T>,
  keyOf: (record: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const record of records) {
    const key = keyOf(record);
    const group = groups.get(key);
    if (group) {
      group.push(record);
    } else {
      groups.set(key, [record]);
    }
  }
  return groups;
}
