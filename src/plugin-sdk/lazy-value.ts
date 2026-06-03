type LazyValue<T> = T | (() => T);

/** Return a getter that resolves a value or factory once, then reuses the cached result. */
export function createCachedLazyValueGetter<T>(value: LazyValue<T>): () => T;
/** Return a getter that substitutes `fallback` when the lazy source resolves nullish. */
export function createCachedLazyValueGetter<T>(
  value: LazyValue<T | null | undefined>,
  fallback: T,
): () => T;
export function createCachedLazyValueGetter<T>(
  value: LazyValue<T | null | undefined>,
  fallback?: T,
): () => T | undefined {
  let resolved = false;
  let cached: T | undefined;

  return () => {
    if (!resolved) {
      const nextValue =
        typeof value === "function" ? (value as () => T | null | undefined)() : value;
      // Cache nullish fallback selection too; callers rely on factories running only once.
      cached = nextValue ?? fallback;
      resolved = true;
    }
    return cached;
  };
}
