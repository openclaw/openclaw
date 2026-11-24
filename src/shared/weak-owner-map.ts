/** Return the inner map for an object owner, allocating it only when absent. */
export function getOrCreateWeakOwnerMap<Owner extends object, Key, Value>(
  owners: WeakMap<Owner, Map<Key, Value>>,
  owner: Owner,
): Map<Key, Value> {
  let values = owners.get(owner);
  if (!values) {
    values = new Map();
    owners.set(owner, values);
  }
  return values;
}
