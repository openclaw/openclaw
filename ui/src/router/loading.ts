import type { MaybePromise, PageDefinition, RouteHookOptions } from "./types.ts";

type DataEntry<TData> = {
  routeId: string;
  key: string;
  status: "pending" | "success" | "error";
  data?: TData;
  error?: unknown;
  promise?: Promise<TData>;
  signal: AbortSignal;
  updatedAt: number;
  lastAccessedAt: number;
  preloaded: boolean;
  gcTimer?: ReturnType<typeof globalThis.setTimeout>;
};

export type RouteLoadResult<TModule, TData> = {
  data: TData;
  module: TModule;
};

export type RouteLoading<TRouteId extends string, TLoadContext, TModule, TData> = {
  loadRoute: (
    route: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
    context: TLoadContext,
    hookOptions: RouteHookOptions,
    force: boolean,
  ) => Promise<RouteLoadResult<TModule, TData>>;
  getLoadedModule: (routeId: TRouteId) => TModule | undefined;
  getCachedData: (routeId: TRouteId, deps: string) => TData | undefined;
  invalidate: (routeId?: TRouteId) => void;
  clear: () => void;
};

type RouteLoadingOptions = {
  staleTime: number;
  preloadStaleTime: number;
  gcTime: number;
};

function dataCacheKey<TRouteId extends string>(routeId: TRouteId, deps: string): string {
  return `${routeId}\u0000${deps}`;
}

export function createRouteLoading<TRouteId extends string, TLoadContext, TModule, TData>(
  options: RouteLoadingOptions,
): RouteLoading<TRouteId, TLoadContext, TModule, TData> {
  const moduleCache = new Map<TRouteId, Promise<TModule>>();
  const moduleValues = new Map<TRouteId, TModule>();
  const dataCache = new Map<string, DataEntry<TData>>();
  const now = () => Date.now();

  const scheduleGc = (
    entry: DataEntry<TData>,
    route: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
  ) => {
    if (entry.gcTimer) {
      globalThis.clearTimeout(entry.gcTimer);
    }
    const lifetime = route.gcTime ?? options.gcTime;
    entry.gcTimer = globalThis.setTimeout(() => {
      if (dataCache.get(entry.key) === entry && now() - entry.lastAccessedAt >= lifetime) {
        dataCache.delete(entry.key);
      }
    }, lifetime);
    (entry.gcTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  };

  const loadModule = (route: PageDefinition<TRouteId, TLoadContext, TModule, TData>) => {
    if (!route.component) {
      return Promise.resolve(undefined as TModule);
    }
    const cached = moduleCache.get(route.id);
    if (cached) {
      return cached;
    }
    const loaded = Promise.resolve(route.component()).then((module) => {
      moduleValues.set(route.id, module);
      return module;
    });
    moduleCache.set(route.id, loaded);
    void loaded.catch(() => moduleCache.delete(route.id));
    return loaded;
  };

  const startDataLoad = (
    route: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
    context: TLoadContext,
    hookOptions: RouteHookOptions,
    key: string,
    deps: string,
    preloaded: boolean,
  ): Promise<TData> => {
    const existing = dataCache.get(key);
    if (existing?.status === "pending" && existing.promise && !existing.signal.aborted) {
      return existing.promise;
    }
    const entry: DataEntry<TData> = {
      routeId: route.id,
      key,
      status: "pending",
      signal: hookOptions.signal,
      updatedAt: 0,
      lastAccessedAt: now(),
      preloaded,
    };
    const promise = Promise.resolve(
      route.loader?.(context, {
        ...hookOptions,
        deps,
      }) as MaybePromise<TData>,
    ).then(
      (data) => {
        entry.status = "success";
        entry.data = data;
        entry.updatedAt = now();
        entry.lastAccessedAt = entry.updatedAt;
        entry.promise = undefined;
        scheduleGc(entry, route);
        return data;
      },
      (error: unknown) => {
        entry.status = "error";
        entry.error = error;
        entry.promise = undefined;
        scheduleGc(entry, route);
        throw error;
      },
    );
    entry.promise = promise;
    dataCache.set(key, entry);
    return promise;
  };

  const loadData = async (
    route: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
    context: TLoadContext,
    hookOptions: RouteHookOptions,
    force: boolean,
  ): Promise<TData> => {
    const deps = hookOptions.deps;
    const key = dataCacheKey(route.id, deps);
    const current = dataCache.get(key);
    const freshFor =
      current?.preloaded || hookOptions.cause === "preload"
        ? (route.preloadStaleTime ?? options.preloadStaleTime)
        : (route.staleTime ?? options.staleTime);
    if (current) {
      current.lastAccessedAt = now();
      if (current.status === "pending" && current.promise && !current.signal.aborted) {
        return current.promise;
      }
      if (!force && current.status === "success" && now() - current.updatedAt < freshFor) {
        if (hookOptions.cause !== "preload") {
          current.preloaded = false;
        }
        scheduleGc(current, route);
        return current.data as TData;
      }
    }
    return startDataLoad(route, context, hookOptions, key, deps, hookOptions.cause === "preload");
  };

  return {
    async loadRoute(route, context, hookOptions, force) {
      const [data, module] = await Promise.all([
        loadData(route, context, hookOptions, force),
        loadModule(route),
      ]);
      return { data, module };
    },
    getLoadedModule: (routeId) => moduleValues.get(routeId),
    getCachedData: (routeId, deps) => {
      const entry = dataCache.get(dataCacheKey(routeId, deps));
      return entry?.status === "success" ? entry.data : undefined;
    },
    invalidate(routeId) {
      for (const [key, entry] of dataCache) {
        if (routeId === undefined || entry.routeId === routeId) {
          if (entry.gcTimer) {
            globalThis.clearTimeout(entry.gcTimer);
          }
          dataCache.delete(key);
        }
      }
    },
    clear() {
      for (const entry of dataCache.values()) {
        if (entry.gcTimer) {
          globalThis.clearTimeout(entry.gcTimer);
        }
      }
      dataCache.clear();
      moduleCache.clear();
      moduleValues.clear();
    },
  };
}
