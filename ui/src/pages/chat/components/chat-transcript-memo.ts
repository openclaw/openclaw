/** Derived facts share their source's lifetime, with one current entry per owner. */
export function createTranscriptMemo<T>() {
  const cache = new WeakMap<object, { key: readonly unknown[]; value: T }>();
  return (owner: object, key: readonly unknown[], build: () => T): T => {
    const cached = cache.get(owner);
    if (
      cached?.key.length === key.length &&
      cached.key.every((value, index) => Object.is(value, key[index]))
    ) {
      return cached.value;
    }
    const value = build();
    cache.set(owner, { key, value });
    return value;
  };
}
