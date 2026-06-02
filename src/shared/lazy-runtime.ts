/** Caches a selected surface from a dynamically imported runtime module. */
export function createLazyRuntimeSurface<TModule, TSurface>(
  importer: () => Promise<TModule>,
  select: (module: TModule) => TSurface,
): () => Promise<TSurface> {
  let cached: Promise<TSurface> | null = null;
  return () => {
    cached ??= importer().then(select);
    return cached;
  };
}

/** Cache the raw dynamically imported runtime module behind a stable loader. */
export function createLazyRuntimeModule<TModule>(
  importer: () => Promise<TModule>,
): () => Promise<TModule> {
  return createLazyRuntimeSurface(importer, (module) => module);
}

/** Cache a single named runtime export without repeating a custom selector closure per caller. */
export function createLazyRuntimeNamedExport<TModule, const TKey extends keyof TModule>(
  importer: () => Promise<TModule>,
  key: TKey,
): () => Promise<TModule[TKey]> {
  return createLazyRuntimeSurface(importer, (module) => module[key]);
}

/** Creates an async proxy for one method on a lazily loaded runtime surface. */
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

/** Binds multiple lazy runtime method proxies to the same cached surface loader. */
export function createLazyRuntimeMethodBinder<TSurface>(load: () => Promise<TSurface>) {
  return function <TArgs extends unknown[], TResult>(
    select: (surface: TSurface) => (...args: TArgs) => TResult,
  ): (...args: TArgs) => Promise<Awaited<TResult>> {
    return createLazyRuntimeMethod(load, select);
  };
}
