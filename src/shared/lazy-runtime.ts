import { createLazyPromiseLoader } from "./lazy-promise.js";

export { createLazyPromise, createLazyPromiseLoader } from "./lazy-promise.js";

type LazyRuntimeLoader<T> = (() => Promise<T>) & {
  peek: () => Promise<T> | undefined;
  clear: () => void;
};

type LazyRuntimeLoaderOptions = {
  /** Keep rejected load promises cached instead of allowing the next caller to retry. */
  cacheRejections?: boolean;
};

// Lazy runtime helpers expose dynamic imports through cached runtime surfaces.
// These default to caching rejections (evict-by-default is reserved for
// createLazyPromiseLoader/import loader callers that opt in): status/CLI and
// plugin surfaces keep their historical sticky-failure behavior unless they
// explicitly pass cacheRejections: false. Flipping this default silently
// changes retry semantics for ~40 call sites, so the opt-out is deliberate.
export function createLazyRuntimeSurface<TModule, TSurface>(
  importer: () => Promise<TModule>,
  select: (module: TModule) => TSurface,
  options: LazyRuntimeLoaderOptions = {},
): LazyRuntimeLoader<TSurface> {
  const loader = createLazyPromiseLoader(() => importer().then(select), {
    cacheRejections: options.cacheRejections ?? true,
  });
  const load = loader.load as LazyRuntimeLoader<TSurface>;
  load.peek = loader.peek;
  load.clear = loader.clear;
  return load;
}

/** Cache the raw dynamically imported runtime module behind a stable loader. */
export function createLazyRuntimeModule<TModule>(
  importer: () => Promise<TModule>,
  options?: LazyRuntimeLoaderOptions,
): LazyRuntimeLoader<TModule> {
  return createLazyRuntimeSurface(importer, (module) => module, options);
}

/** Cache a single named runtime export without repeating a custom selector closure per caller. */
export function createLazyRuntimeNamedExport<TModule, const TKey extends keyof TModule>(
  importer: () => Promise<TModule>,
  key: TKey,
  options?: LazyRuntimeLoaderOptions,
): () => Promise<TModule[TKey]> {
  return createLazyRuntimeSurface(importer, (module) => module[key], options);
}

export function createLazyRuntimeMethod<TSurface, TArgs extends unknown[], TResult>(
  load: () => Promise<TSurface>,
  select: (surface: TSurface) => (...args: TArgs) => TResult,
): (...args: TArgs) => Promise<Awaited<TResult>> {
  const invoke = async (...args: TArgs): Promise<Awaited<TResult>> => {
    const method = select(await load());
    return await method(...args);
  };
  return invoke;
}

export function createLazyRuntimeMethodBinder<TSurface>(load: () => Promise<TSurface>) {
  return function <TArgs extends unknown[], TResult>(
    select: (surface: TSurface) => (...args: TArgs) => TResult,
  ): (...args: TArgs) => Promise<Awaited<TResult>> {
    return createLazyRuntimeMethod(load, select);
  };
}
