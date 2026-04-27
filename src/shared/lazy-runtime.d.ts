export declare function createLazyRuntimeSurface<TModule, TSurface>(importer: () => Promise<TModule>, select: (module: TModule) => TSurface): () => Promise<TSurface>;
/** Cache the raw dynamically imported runtime module behind a stable loader. */
export declare function createLazyRuntimeModule<TModule>(importer: () => Promise<TModule>): () => Promise<TModule>;
/** Cache a single named runtime export without repeating a custom selector closure per caller. */
export declare function createLazyRuntimeNamedExport<TModule, const TKey extends keyof TModule>(importer: () => Promise<TModule>, key: TKey): () => Promise<TModule[TKey]>;
export declare function createLazyRuntimeMethod<TSurface, TArgs extends unknown[], TResult>(load: () => Promise<TSurface>, select: (surface: TSurface) => (...args: TArgs) => TResult): (...args: TArgs) => Promise<Awaited<TResult>>;
export declare function createLazyRuntimeMethodBinder<TSurface>(load: () => Promise<TSurface>): <TArgs extends unknown[], TResult>(select: (surface: TSurface) => (...args: TArgs) => TResult) => (...args: TArgs) => Promise<Awaited<TResult>>;
