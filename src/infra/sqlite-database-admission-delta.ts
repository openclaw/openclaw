export function changedAdmissionEntries<Key, Value>(
  current: Map<Key, Value>,
  previous: Map<Key, Value>,
): Map<Key, Value> {
  const changed = new Map<Key, Value>();
  for (const [key, value] of current) {
    if (previous.get(key) !== value) {
      changed.set(key, value);
    }
  }
  return changed;
}
