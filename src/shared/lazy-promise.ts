/**
 * Returns true when `err` matches a synthetic ESM failure triggered by an
 * in-place package upgrade or rollback: the dist tree hash rotated while the
 * gateway process is still running.  Dynamic `import()` resolves to
 * `ERR_MODULE_NOT_FOUND` for old hashed chunk names that no longer exist on
 * disk.
 *
 * Only classifies as dist rotation when the *missing module itself* is under
 * the openclaw dist tree — a third-party package whose importer happens to be
 * under openclaw/dist/ is not a rotation error.
 */
export function isDistRotationError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const obj = err as Record<string, unknown>;
  const code = typeof obj.code === "string" ? obj.code : undefined;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
    return false;
  }
  const msg = typeof obj.message === "string" ? obj.message : "";
  // Node.js ESM errors use the format:
  //   Cannot find module 'MISSING_TARGET' imported from IMPORTER_PATH
  // We must verify that the *missing target* is under the dist tree, not
  // merely that the importer happens to be there (otherwise a missing
  // third-party dependency imported from openclaw/dist/ would be mislabeled).
  const missingMatch = msg.match(
    /cannot find (?:module|package)\s+'([^']+)'/i,
  );
  if (missingMatch) {
    return /openclaw[/\\]dist[/\\]/i.test(missingMatch[1]);
  }
  // Fallback: if we cannot parse the message format, check the full text.
  return /openclaw[/\\]dist[/\\]/i.test(msg);
}

/** Manual-control promise cache for lazy runtime resources. */
export type LazyPromiseLoader<T> = {
  /** Resolves the cached value, creating one load promise when needed. */
  load(): Promise<T>;
  /** Drops the cached promise so the next load starts fresh. */
  clear(): void;
};

/** Options for controlling lazy promise cache behavior. */
export type LazyPromiseLoaderOptions = {
  /** Keep rejected promises cached instead of allowing the next caller to retry. */
  cacheRejections?: boolean;
};

/**
 * Creates a small promise cache that dedupes concurrent loads and can be cleared manually.
 *
 * Rejections are evicted by default so transient dynamic-import/runtime failures can recover.
 */
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
