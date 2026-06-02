type LazyValue<T> = T | (() => T);

/** Build a getter that resolves a literal or thunk once, then returns the cached value. */
export function createCachedLazyValueGetter<T>(value: LazyValue<T>): () => T;
/** Build a getter that falls back when the first lazy resolution is nullish. */
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
      // Cache the first result, including fallback use, so plugin descriptors do not rerun
      // schema thunks during repeated registry reads.
      const nextValue =
        typeof value === "function" ? (value as () => T | null | undefined)() : value;
      cached = nextValue ?? fallback;
      resolved = true;
    }
    return cached;
  };
}
