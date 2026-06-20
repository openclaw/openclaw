import { createRouteLoading } from "./loading.ts";
import {
  compileRoutes,
  createMatchStore,
  createRouteMatch,
  locationForPath,
  locationsEqual,
  matchIdForLocation,
  normalizeLocation,
  normalizeRouteBasePath,
} from "./matches.ts";
import type {
  RouteHookOptions,
  RouteLocation,
  RouteLoadCause,
  RouteMatch,
  Router,
  RouterHistory,
  RouterNavigationOptions,
  RouterOptions,
} from "./types.ts";

type NavigationRun = {
  controller: AbortController;
  matchId: string;
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
  const matches = createMatchStore<TRouteId, TModule, TData>();
  const loading = createRouteLoading<TRouteId, TLoadContext, TModule, TData>(
    {
      staleTime: options.staleTime ?? DEFAULT_STALE_TIME,
      preloadStaleTime: options.preloadStaleTime ?? DEFAULT_PRELOAD_STALE_TIME,
      gcTime: options.gcTime ?? DEFAULT_GC_TIME,
    },
    matches,
  );
  let history: RouterHistory | undefined;
  let basePath = "";
  let stopHistory: (() => void) | undefined;
  let currentRun: NavigationRun | null = null;
  let activeNavigation: Promise<void> | null = null;

  const runHook = async (
    match: RouteMatch<TRouteId, TModule, TData> | undefined,
    hook: "onEnter" | "onLeave",
    context: TLoadContext,
    hookOptions: RouteHookOptions,
  ): Promise<void> => {
    if (!match || !hookOptions.shouldRun()) {
      return;
    }
    const route = compiled.byId.get(match.routeId);
    await route?.[hook]?.(context, match.data as TData, {
      ...hookOptions,
      location: match.location,
      deps: match.deps,
    });
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
    const previous = matches.getActiveMatch();
    const deps = route.loaderDeps?.(context, location) ?? "";
    const sameRoute = previous?.routeId === routeId && locationsEqual(previous.location, location);
    const revalidating = navigationOptions.revalidate === true && previous?.routeId === routeId;
    if (sameRoute && previous?.status === "success" && !previous.invalid && !revalidating) {
      return;
    }

    if (history && navigationOptions.history && navigationOptions.history !== "none") {
      history[navigationOptions.history](location);
    }

    cancelRun(currentRun);
    const controller = new AbortController();
    const cause: RouteLoadCause = revalidating ? "revalidate" : "navigation";
    const matchId = matchIdForLocation(routeId, location, deps);
    const cached = matches.getCachedMatch(matchId);
    const match =
      sameRoute && previous
        ? {
            ...previous,
            abortController: controller,
            cause,
            error: undefined,
            invalid: true,
            isFetching: "loader" as const,
            preload: false,
          }
        : cached
          ? {
              ...cached,
              abortController: controller,
              cause,
              error: undefined,
              invalid: cached.invalid,
              isFetching: false as const,
              preload: cached.preload,
            }
          : {
              ...createRouteMatch<TRouteId, TModule, TData>(
                routeId,
                location,
                deps,
                cause,
                controller,
              ),
            };
    const run: NavigationRun = { controller, matchId: match.id };
    currentRun = run;
    const hookOptions: RouteHookOptions = {
      signal: controller.signal,
      shouldRun: () => isCurrentRun(currentRun, run),
      revalidating,
      location,
      deps,
      cause,
    };
    const previousLocation = matches.getState().resolvedLocation;

    if (sameRoute) {
      matches.updateMatch(match.id, () => match);
    } else {
      matches.setPending([match]);
    }
    matches.setLocation(location, previousLocation);
    matches.setStatus("loading");

    const navigation = (async () => {
      let result: { data: TData; module: TModule };
      try {
        result = await loading.loadRoute(
          match,
          route,
          context,
          hookOptions,
          revalidating || Boolean(cached?.invalid),
        );
      } catch (error) {
        if (!hookOptions.shouldRun()) {
          return;
        }
        matches.setStatus("error");
        if (isCurrentRun(currentRun, run)) {
          currentRun = null;
        }
        throw error;
      }
      if (!hookOptions.shouldRun()) {
        return;
      }

      const resolvedMatch = matches.getMatch(match.id) ?? {
        ...match,
        data: result.data,
        module: result.module,
        status: "success" as const,
        isFetching: false as const,
        error: undefined,
        invalid: false,
        updatedAt: Date.now(),
        lastAccessedAt: Date.now(),
      };
      const currentActive = matches.getActiveMatch();
      if (!sameRoute && currentActive) {
        matches.setCached([...matches.getState().cachedMatches, currentActive]);
      }
      matches.setActive([resolvedMatch]);
      matches.setPending([]);
      matches.setLocation(location, location);
      matches.setStatus("success");

      const lifecycleErrors: unknown[] = [];
      if (!sameRoute) {
        try {
          await runHook(currentActive, "onLeave", context, {
            ...hookOptions,
            revalidating: false,
          });
        } catch (error) {
          lifecycleErrors.push(error);
        }
        try {
          await runHook(resolvedMatch, "onEnter", context, hookOptions);
        } catch (error) {
          lifecycleErrors.push(error);
        }
      }
      if (lifecycleErrors.length > 0) {
        throw lifecycleErrors[0];
      }
      if (isCurrentRun(currentRun, run)) {
        currentRun = null;
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
    const deps = route.loaderDeps?.(context, location) ?? "";
    const matchId = matchIdForLocation(routeId, location, deps);
    const match =
      matches.getCachedMatch(matchId) ??
      createRouteMatch<TRouteId, TModule, TData>(
        routeId,
        location,
        deps,
        "preload",
        controller,
        true,
      );
    matches.setCached([
      ...matches.getState().cachedMatches.filter((candidate) => candidate.id !== match.id),
      match,
    ]);
    const hookOptions: RouteHookOptions = {
      signal: controller.signal,
      shouldRun: () => !controller.signal.aborted,
      revalidating: false,
      location,
      deps,
      cause: "preload",
    };
    return loading.loadRoute(match, route, context, hookOptions, false).then(() => undefined);
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
    getMatch: matches.getMatch,
    preloadRoute,
    preloadLocation,
    invalidate(routeId) {
      matches.invalidate(routeId);
    },
    getState: matches.getState,
    subscribe: matches.subscribe,
    subscribeSelector: matches.subscribeSelector,
    subscribeMatch: matches.subscribeMatch,
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
    revalidate(context: TLoadContext, routeId = matches.getActiveMatch()?.routeId): Promise<void> {
      if (!routeId) {
        return Promise.resolve();
      }
      const target =
        matches.getActiveMatch()?.routeId === routeId
          ? matches.getActiveMatch()?.location
          : locationForPath(compiled.pathForRoute(routeId, basePath));
      return navigate(routeId, context, { history: "none", revalidate: true }, target);
    },
    stop() {
      stopHistory?.();
      stopHistory = undefined;
      cancelRun(currentRun);
      currentRun = null;
      activeNavigation = null;
      history = undefined;
      loading.clear();
      matches.clear();
    },
  };
}
