/** Promise-backed loader that caches the in-flight/resolved load until cleared. */
export type LazyPromiseLoader<T> = {
  load(): Promise<T>;
  clear(): void;
};

/** Lazy loader behavior controls for retrying or caching failed loads. */
export type LazyPromiseLoaderOptions = {
  /** When true, rejected loads remain cached instead of being evicted for retry. */
  cacheRejections?: boolean;
};

/** Creates a small promise cache that dedupes concurrent loads and can be cleared manually. */
export function createLazyPromiseLoader<T>(
  load: () => T | Promise<T>,
  options: LazyPromiseLoaderOptions = {},
): LazyPromiseLoader<T> {
  let promise: Promise<T> | undefined;

  const createPromise = (): Promise<T> => {
    const loaded = Promise.resolve().then(load);
    if (options.cacheRejections !== true) {
      void loaded.catch(() => {
        // Failed lazy loads are usually transient import/runtime issues; evict the exact
        // rejected promise so the next caller can retry without racing a newer load.
        if (promise === loaded) {
          promise = undefined;
        }
      });
    }
    return loaded;
  };

  return {
    async load(): Promise<T> {
      promise ??= createPromise();
      return await promise;
    },
    clear(): void {
      promise = undefined;
    },
  };
}

/** Convenience wrapper for dynamic-import-shaped loaders. */
export function createLazyImportLoader<T>(
  load: () => Promise<T>,
  options?: LazyPromiseLoaderOptions,
): LazyPromiseLoader<T> {
  return createLazyPromiseLoader(load, options);
}
