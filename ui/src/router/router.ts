import { createRouteLoading } from "./loading.ts";
import {
  compileRoutes,
  locationForPath,
  locationsEqual,
  normalizeLocation,
  normalizeRouteBasePath,
  normalizeRoutePath,
} from "./matches.ts";
import type {
  RouteHookOptions,
  RouteLocation,
  RouteLoadCause,
  RouteState,
  Router,
  RouterNavigationOptions,
  RouterOptions,
  RouterHistory,
} from "./types.ts";

type NavigationRun = {
  controller: AbortController;
};

const DEFAULT_STALE_TIME = 0;
const DEFAULT_PRELOAD_STALE_TIME = 30_000;
const DEFAULT_GC_TIME = 30 * 60_000;

function isCurrentRun(current: NavigationRun | null, run: NavigationRun): boolean {
  return current === run && !run.controller.signal.aborted;
}

function cancelRun(run: NavigationRun | null): void {
  run?.controller.abort();
}

export function createRouter<
  TRouteId extends string,
  TLoadContext = unknown,
  TModule = unknown,
  TData = unknown,
>(
  options: RouterOptions<TRouteId, TLoadContext, TModule, TData>,
): Router<TRouteId, TLoadContext, TModule, TData> {
  const defaultRouteId = options.defaultRouteId ?? null;
  const compiled = compileRoutes(options.routes, defaultRouteId);
  const staleTime = options.staleTime ?? DEFAULT_STALE_TIME;
  const preloadStaleTime = options.preloadStaleTime ?? DEFAULT_PRELOAD_STALE_TIME;
  const gcTime = options.gcTime ?? DEFAULT_GC_TIME;
  const loading = createRouteLoading<TRouteId, TLoadContext, TModule, TData>({
    staleTime,
    preloadStaleTime,
    gcTime,
  });
  const listeners = new Set<(state: RouteState<TRouteId, TData>) => void>();
  let history: RouterHistory | undefined;
  let basePath = "";
  let stopHistory: (() => void) | undefined;
  let currentRun: NavigationRun | null = null;
  let activeNavigation: Promise<void> | null = null;
  let resolvedRouteId: TRouteId | null = null;
  let state: RouteState<TRouteId, TData> = {
    requested: locationForPath("/"),
    resolved: null,
    pendingRouteId: null,
    resolvedRouteId: null,
    pendingData: undefined,
    resolvedData: undefined,
    status: "idle",
    revalidating: false,
  };

  const publish = (next: RouteState<TRouteId, TData>) => {
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  };

  const runHook = async (
    routeId: TRouteId | null,
    hook: "onEnter" | "onLeave",
    context: TLoadContext,
    data: TData | undefined,
    hookOptions: RouteHookOptions,
  ): Promise<void> => {
    if (!routeId || !hookOptions.shouldRun()) {
      return;
    }
    await compiled.byId.get(routeId)?.[hook]?.(context, data as TData, hookOptions);
  };

  const navigate = async (
    routeId: TRouteId,
    context: TLoadContext,
    navigationOptions: RouterNavigationOptions = {},
    requestedLocation = locationForPath(compiled.pathForRoute(routeId, basePath)),
  ): Promise<void> => {
    const route = compiled.byId.get(routeId);
    if (!route) {
      throw new Error(`Unknown route id "${routeId}".`);
    }
    const location = normalizeLocation(requestedLocation);
    if (
      resolvedRouteId === routeId &&
      state.status === "resolved" &&
      !state.revalidating &&
      !navigationOptions.revalidate &&
      locationsEqual(state.resolved, location)
    ) {
      return;
    }

    if (history && navigationOptions.history && navigationOptions.history !== "none") {
      history[navigationOptions.history](location);
    }

    cancelRun(currentRun);
    const run: NavigationRun = { controller: new AbortController() };
    currentRun = run;
    const sameRoute = resolvedRouteId === routeId;
    const revalidating = navigationOptions.revalidate === true && sameRoute;
    const cause: RouteLoadCause = revalidating ? "revalidate" : "navigation";
    const hookOptions: RouteHookOptions = {
      signal: run.controller.signal,
      shouldRun: () => isCurrentRun(currentRun, run),
      revalidating,
      location,
      deps: route.loaderDeps?.(context, location) ?? "",
      cause,
    };
    const previousRouteId = sameRoute ? null : resolvedRouteId;
    const keepResolved = sameRoute && state.resolved !== null;
    const pendingData = loading.getCachedData(routeId, hookOptions.deps);
    const navigation = (async () => {
      publish({
        requested: location,
        resolved: state.resolved,
        pendingRouteId: routeId,
        resolvedRouteId,
        pendingData,
        resolvedData: state.resolvedData,
        status: keepResolved ? "resolved" : "loading",
        revalidating: keepResolved,
      });

      let result: { data: TData; module: TModule };
      try {
        result = await loading.loadRoute(
          route,
          context,
          hookOptions,
          navigationOptions.revalidate === true,
        );
      } catch (error) {
        if (!hookOptions.shouldRun()) {
          return;
        }
        publish({
          requested: location,
          resolved: state.resolved,
          pendingRouteId: routeId,
          resolvedRouteId,
          pendingData: undefined,
          resolvedData: state.resolvedData,
          status: "error",
          revalidating: false,
          error,
        });
        if (isCurrentRun(currentRun, run)) {
          currentRun = null;
        }
        throw error;
      }
      if (!hookOptions.shouldRun()) {
        return;
      }

      const previousData = state.resolvedData;
      resolvedRouteId = routeId;
      publish({
        requested: location,
        resolved: location,
        pendingRouteId: null,
        resolvedRouteId,
        pendingData: undefined,
        resolvedData: result.data,
        status: "resolved",
        revalidating: false,
      });

      const lifecycleErrors: unknown[] = [];
      try {
        await runHook(previousRouteId, "onLeave", context, previousData, {
          ...hookOptions,
          revalidating: false,
        });
      } catch (error) {
        lifecycleErrors.push(error);
      }
      if (!sameRoute) {
        try {
          await runHook(routeId, "onEnter", context, result.data, hookOptions);
        } catch (error) {
          lifecycleErrors.push(error);
        }
      }
      if (lifecycleErrors.length > 0) {
        throw lifecycleErrors[0];
      }
    })();
    activeNavigation = navigation;
    try {
      await navigation;
    } finally {
      if (activeNavigation === navigation) {
        activeNavigation = null;
      }
    }
  };

  const handleLocation = async (
    location: RouteLocation,
    context: TLoadContext,
    revalidate = false,
  ): Promise<void> => {
    const normalized = normalizeLocation(location);
    const matched = compiled.routeIdFromPath(normalized.pathname, basePath);
    const routeId = matched ?? defaultRouteId;
    if (!routeId) {
      return;
    }
    const canonical = locationForPath(compiled.pathForRoute(routeId, basePath));
    const target = matched
      ? normalized
      : { ...canonical, search: normalized.search, hash: normalized.hash };
    if (!matched && history) {
      history.replace(target);
    }
    await navigate(routeId, context, { history: "none", revalidate }, target);
  };

  const preloadAtLocation = (
    routeId: TRouteId,
    context: TLoadContext,
    location: RouteLocation,
  ): Promise<void> => {
    const route = compiled.byId.get(routeId);
    if (!route) {
      return Promise.reject(new Error(`Unknown route id "${routeId}".`));
    }
    const controller = new AbortController();
    const options: RouteHookOptions = {
      signal: controller.signal,
      shouldRun: () => !controller.signal.aborted,
      revalidating: false,
      location,
      deps: route.loaderDeps?.(context, location) ?? "",
      cause: "preload",
    };
    return loading.loadRoute(route, context, options, false).then(() => undefined);
  };

  const preloadRoute = (routeId: TRouteId, context: TLoadContext): Promise<void> =>
    preloadAtLocation(routeId, context, locationForPath(compiled.pathForRoute(routeId, basePath)));

  const preloadLocation = (location: RouteLocation, context: TLoadContext): Promise<void> => {
    const normalized = normalizeLocation(location);
    const routeId = compiled.routeIdFromPath(normalized.pathname, basePath);
    return routeId ? preloadAtLocation(routeId, context, normalized) : Promise.resolve();
  };

  return {
    routes: [...compiled.byId.values()],
    getRoute: (routeId: TRouteId) => compiled.byId.get(routeId) ?? null,
    getLoadedModule: loading.getLoadedModule,
    preloadRoute,
    preloadLocation,
    invalidate: loading.invalidate,
    getState: () => state,
    subscribe(listener: (next: RouteState<TRouteId, TData>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pathForRoute: compiled.pathForRoute,
    routeIdFromPath: compiled.routeIdFromPath,
    start(nextHistory: RouterHistory, nextBasePath: string, context: TLoadContext): Promise<void> {
      history = nextHistory;
      basePath = normalizeRouteBasePath(nextBasePath);
      stopHistory?.();
      stopHistory = history.listen((location) => {
        void handleLocation(location, context).catch(() => undefined);
      });
      return handleLocation(history.location(), context, true);
    },
    navigate,
    navigateLocation(location: RouteLocation, context: TLoadContext): Promise<void> {
      const normalized = normalizeLocation(location);
      const matched = compiled.routeIdFromPath(normalized.pathname, basePath);
      const routeId = matched ?? defaultRouteId;
      const target = routeId
        ? matched
          ? normalized
          : {
              ...locationForPath(compiled.pathForRoute(routeId, basePath)),
              search: normalized.search,
              hash: normalized.hash,
            }
        : normalized;
      return routeId ? navigate(routeId, context, { history: "none" }, target) : Promise.resolve();
    },
    revalidate(
      context: TLoadContext,
      routeId = (state.status === "loading" ? state.pendingRouteId : null) ??
        resolvedRouteId ??
        undefined,
    ): Promise<void> {
      if (!routeId) {
        return Promise.resolve();
      }
      loading.invalidate(routeId);
      const location =
        state.pendingRouteId === routeId ? state.requested : (state.resolved ?? state.requested);
      return navigate(routeId, context, { history: "none", revalidate: true }, location);
    },
    stop() {
      stopHistory?.();
      stopHistory = undefined;
      cancelRun(currentRun);
      currentRun = null;
      activeNavigation = null;
      history = undefined;
      resolvedRouteId = null;
      loading.clear();
      publish({
        requested: locationForPath("/"),
        resolved: null,
        pendingRouteId: null,
        resolvedRouteId: null,
        pendingData: undefined,
        resolvedData: undefined,
        status: "idle",
        revalidating: false,
      });
    },
  };
}
