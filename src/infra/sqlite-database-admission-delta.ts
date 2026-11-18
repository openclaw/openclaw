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

export function changedAdmissionWriteScopes<Key, Value>(
  current: readonly ReadonlyMap<Key, Value>[],
  previous: readonly ReadonlyMap<Key, Value>[],
): Map<Key, Value> {
  const changed = new Map<Key, Value>();
  current.forEach((bucket, index) => {
    if (bucket !== previous[index]) {
      bucket.forEach((value, key) => {
        if (previous[index]!.get(key) !== value) {
          changed.set(key, value);
        }
      });
    }
  });
  return changed;
}
