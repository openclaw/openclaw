import type { MatchStore } from "./matches.ts";
import type { MaybePromise, PageDefinition, RouteHookOptions, RouteMatch } from "./types.ts";

export type RouteLoadResult<TModule, TData> = {
  data: TData;
  module: TModule;
};

type RouteDataResult<TData> = {
  data: TData;
  updatedAt: number;
};

export type RouteLoading<TRouteId extends string, TLoadContext, TModule, TData> = {
  loadRoute: (
    match: RouteMatch<TRouteId, TModule, TData>,
    route: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
    context: TLoadContext,
    hookOptions: RouteHookOptions,
    force: boolean,
  ) => Promise<RouteLoadResult<TModule, TData>>;
  scheduleGc: (
    match: RouteMatch<TRouteId, TModule, TData>,
    route: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
  ) => void;
  clear: () => void;
};

type RouteLoadingOptions = {
  staleTime: number;
  preloadStaleTime: number;
  preloadGcTime: number;
  gcTime: number;
};

export function createRouteLoading<TRouteId extends string, TLoadContext, TModule, TData>(
  options: RouteLoadingOptions,
  matchStore: MatchStore<TRouteId, TModule, TData>,
): RouteLoading<TRouteId, TLoadContext, TModule, TData> {
  const moduleCache = new Map<TRouteId, Promise<TModule>>();
  const inFlight = new Map<string, Promise<RouteLoadResult<TModule, TData>>>();
  const gcTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
  const now = () => Date.now();

  const scheduleGc = (
    match: RouteMatch<TRouteId, TModule, TData>,
    route: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
  ) => {
    const gcTime = match.preload
      ? (route.preloadGcTime ?? options.preloadGcTime)
      : (route.gcTime ?? options.gcTime);
    const remaining = gcTime - (now() - match.updatedAt);
    if (!matchStore.getCachedMatch(match.id) || remaining <= 0) {
      if (remaining <= 0) {
        matchStore.removeCached(match.id);
        gcTimers.delete(match.id);
      }
      return;
    }
    const previousTimer = gcTimers.get(match.id);
    if (previousTimer) {
      globalThis.clearTimeout(previousTimer);
    }
    const timer = globalThis.setTimeout(() => {
      const current = matchStore.getCachedMatch(match.id);
      if (!current) {
        gcTimers.delete(match.id);
        return;
      }
      if (now() - current.updatedAt < gcTime) {
        scheduleGc(current, route);
        return;
      }
      matchStore.removeCached(match.id);
      gcTimers.delete(match.id);
    }, remaining);
    gcTimers.set(match.id, timer);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  };

  const loadModule = (
    route: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
    match: RouteMatch<TRouteId, TModule, TData>,
  ): Promise<TModule> => {
    if (match.module !== undefined) {
      return Promise.resolve(match.module);
    }
    const cached = moduleCache.get(route.id);
    if (cached) {
      return cached;
    }
    const loaded = Promise.resolve(route.component());
    moduleCache.set(route.id, loaded);
    void loaded.catch(() => moduleCache.delete(route.id));
    return loaded;
  };

  const loadData = (
    match: RouteMatch<TRouteId, TModule, TData>,
    route: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
    context: TLoadContext,
    hookOptions: RouteHookOptions,
    force: boolean,
  ): Promise<RouteDataResult<TData>> => {
    const current = matchStore.getMatch(match.id) ?? match;
    const freshFor =
      current.preload || hookOptions.cause === "preload"
        ? (route.preloadStaleTime ?? options.preloadStaleTime)
        : (route.staleTime ?? options.staleTime);
    if (
      !force &&
      current.status === "success" &&
      !current.invalid &&
      now() - current.updatedAt < freshFor
    ) {
      matchStore.updateMatch(current.id, (next) => ({
        ...next,
        preload: hookOptions.cause === "preload",
      }));
      scheduleGc(current, route);
      return Promise.resolve({ data: current.data as TData, updatedAt: current.updatedAt });
    }
    return Promise.resolve(
      route.loader?.(context, {
        ...hookOptions,
        deps: current.deps,
      }) as MaybePromise<TData>,
    ).then((data) => ({ data, updatedAt: now() }));
  };

  const loadRoute = async (
    match: RouteMatch<TRouteId, TModule, TData>,
    route: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
    context: TLoadContext,
    hookOptions: RouteHookOptions,
    force: boolean,
  ): Promise<RouteLoadResult<TModule, TData>> => {
    const existing = inFlight.get(match.id);
    if (existing && !force) {
      return existing;
    }
    const current = matchStore.getMatch(match.id) ?? match;
    const fetchCount = current.fetchCount + 1;
    matchStore.updateMatch(match.id, (next) => ({
      ...next,
      isFetching: "loader",
      fetchCount,
    }));
    const dataPromise = loadData(current, route, context, hookOptions, force);
    const modulePromise = loadModule(route, current);
    const visibleModulePromise = modulePromise.then((module) => {
      const latest = matchStore.getMatch(current.id);
      if (latest?.fetchCount === fetchCount && !hookOptions.signal.aborted) {
        matchStore.updateMatch(current.id, (next) => ({ ...next, module }));
      }
      return module;
    });
    const promise = Promise.all([dataPromise, visibleModulePromise]).then(
      ([dataResult, module]) => {
        const latest = matchStore.getMatch(current.id);
        if (latest?.fetchCount !== fetchCount || hookOptions.signal.aborted) {
          return { data: dataResult.data, module };
        }
        matchStore.updateMatch(current.id, (next) => ({
          ...next,
          data: dataResult.data,
          module,
          status: "success",
          isFetching: false,
          error: undefined,
          invalid: false,
          preload: hookOptions.cause === "preload",
          updatedAt: dataResult.updatedAt,
        }));
        const resolved = matchStore.getMatch(current.id);
        if (resolved) {
          scheduleGc(resolved, route);
        }
        return { data: dataResult.data, module };
      },
    );
    inFlight.set(match.id, promise);
    try {
      return await promise;
    } catch (error) {
      const latest = matchStore.getMatch(match.id);
      if (latest?.fetchCount === fetchCount && !hookOptions.signal.aborted) {
        matchStore.updateMatch(match.id, (next) => ({
          ...next,
          status: "error",
          isFetching: false,
          error,
          updatedAt: now(),
        }));
      }
      throw error;
    } finally {
      if (inFlight.get(match.id) === promise) {
        inFlight.delete(match.id);
      }
    }
  };

  return {
    loadRoute,
    scheduleGc,
    clear() {
      const state = matchStore.getState();
      for (const match of [...state.matches, ...state.pendingMatches, ...state.cachedMatches]) {
        if (match.isFetching || match.status === "pending") {
          match.abortController.abort();
        }
      }
      for (const timer of gcTimers.values()) {
        globalThis.clearTimeout(timer);
      }
      gcTimers.clear();
      inFlight.clear();
      moduleCache.clear();
    },
  };
}
