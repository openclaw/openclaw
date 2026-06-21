import { createRouteLoading } from "./loading.ts";
import {
  compileRoutes,
  createMatchStore,
  createRouteMatch,
  locationForPath,
  matchIdForLocation,
  normalizeLocation,
  normalizeRouteBasePath,
} from "./matches.ts";
import type {
  RouteHookOptions,
  RouteLocation,
  RouteLoadCause,
  RouteMatch,
  RouteNotFound,
  RouteRedirect,
  Router,
  RouterHistory,
  RouterNavigationOptions,
  RouterOptions,
} from "./types.ts";

type NavigationRun = {
  controller: AbortController;
  matchId: string;
  location: RouteLocation;
  promise?: Promise<void>;
};

const DEFAULT_STALE_TIME = 0;
const DEFAULT_STALE_RELOAD_MODE = "background" as const;
const DEFAULT_PRELOAD_STALE_TIME = 30_000;
const DEFAULT_GC_TIME = 30 * 60_000;

function isCurrentRun(current: NavigationRun | null, run: NavigationRun): boolean {
  return current === run && !run.controller.signal.aborted;
}

function cancelRun(run: NavigationRun | null): void {
  run?.controller.abort();
}

function canCacheMatch<TRouteId extends string, TModule, TData>(
  match: RouteMatch<TRouteId, TModule, TData>,
): boolean {
  return match.status !== "error" && match.status !== "notFound" && match.status !== "redirected";
}

function isRouteNotFound(error: unknown): error is RouteNotFound {
  return (
    typeof error === "object" && error !== null && (error as RouteNotFound).type === "notFound"
  );
}

function isRouteRedirect(error: unknown): error is RouteRedirect {
  return (
    typeof error === "object" && error !== null && (error as RouteRedirect).type === "redirect"
  );
}

export function createRouter<
  TRouteId extends string,
  TLoadContext = unknown,
  TModule = unknown,
  TData = unknown,
>(
  options: RouterOptions<TRouteId, TLoadContext, TModule, TData>,
): Router<TRouteId, TLoadContext, TModule, TData> {
  const compiled = compileRoutes(options.routes);
  const matches = createMatchStore<TRouteId, TModule, TData>();
  const loading = createRouteLoading<TRouteId, TLoadContext, TModule, TData>(
    {
      staleTime: options.staleTime ?? DEFAULT_STALE_TIME,
      staleReloadMode: options.defaultStaleReloadMode ?? DEFAULT_STALE_RELOAD_MODE,
      preloadStaleTime: options.preloadStaleTime ?? DEFAULT_PRELOAD_STALE_TIME,
      preloadGcTime: options.preloadGcTime ?? DEFAULT_GC_TIME,
      gcTime: options.gcTime ?? DEFAULT_GC_TIME,
    },
    matches,
  );
  let history: RouterHistory | undefined;
  let basePath = "";
  let stopHistory: (() => void) | undefined;
  let currentRun: NavigationRun | null = null;
  let lastContext: TLoadContext | undefined;
  let hasLastContext = false;

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

    lastContext = context;
    hasLastContext = true;
    const location = normalizeLocation(requestedLocation);
    const previous = matches.getActiveMatch();
    const deps = route.loaderDeps?.(context, location) ?? "";
    const sameRoute = previous?.routeId === routeId;
    const matchId = matchIdForLocation(routeId, deps);
    const sameMatch = previous?.id === matchId;
    const revalidating = navigationOptions.revalidate === true && previous?.routeId === routeId;
    const cached = matches.getCachedMatch(matchId);
    const cachedReady =
      !sameMatch && cached?.status === "success" && cached.module !== undefined && !cached.invalid;
    const cachedFresh = cachedReady && loading.isFresh(cached, route, "navigation");
    const backgroundReload =
      sameMatch && revalidating
        ? true
        : Boolean(cachedReady && !cachedFresh && loading.shouldReloadInBackground(route));

    if (history && navigationOptions.history && navigationOptions.history !== "none") {
      history[navigationOptions.history](location);
    }

    const ongoing = currentRun;
    if (ongoing?.matchId === matchId && ongoing.promise && !ongoing.controller.signal.aborted) {
      matches.updateMatch(matchId, (current) => ({ ...current, location }));
      matches.setLocation(location, matches.getState().resolvedLocation);
      ongoing.location = location;
      return ongoing.promise;
    }

    if (sameMatch && previous?.status === "success" && !previous.invalid && !revalidating) {
      matches.updateMatch(previous.id, (current) => ({ ...current, location }));
      matches.setLocation(location, location);
      matches.setStatus("success");
      return;
    }

    cancelRun(currentRun);
    const controller = new AbortController();
    const cause: RouteLoadCause = revalidating ? "revalidate" : "navigation";
    const match =
      sameMatch && previous
        ? {
            ...previous,
            location,
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
              location,
              abortController: controller,
              cause,
              error: undefined,
              invalid: cached.invalid,
              isFetching: false as const,
              preload: false,
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
    const activatedCachedMatch =
      cachedReady && (cachedFresh || backgroundReload)
        ? {
            ...match,
            isFetching: backgroundReload ? ("loader" as const) : false,
            preload: false,
          }
        : undefined;
    let targetPublished = Boolean(activatedCachedMatch);
    const run: NavigationRun = { controller, matchId, location };
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

    if (activatedCachedMatch) {
      matches.batch(() => {
        if (previous && canCacheMatch(previous)) {
          matches.setCached([
            ...matches.getState().cachedMatches.filter((candidate) => candidate.id !== previous.id),
            previous,
          ]);
          const previousRoute = compiled.byId.get(previous.routeId);
          if (previousRoute) {
            loading.scheduleGc(previous, previousRoute);
          }
        }
        matches.setActive([activatedCachedMatch]);
        matches.setPending([]);
        matches.setLocation(location, location);
        matches.setStatus("success");
      });
    } else if (sameMatch) {
      matches.updateMatch(match.id, () => match);
    } else {
      matches.setPending([match]);
    }
    if (!activatedCachedMatch) {
      matches.setLocation(location, previousLocation);
      matches.setStatus(backgroundReload ? "success" : "loading");
    }

    const navigation = (async () => {
      let result: { data: TData; module: TModule };
      try {
        result = await loading.loadRoute(
          match,
          route,
          context,
          hookOptions,
          revalidating || Boolean(cached?.invalid),
          (module) => {
            if (!hookOptions.shouldRun() || matches.getActiveMatch()?.id === match.id) {
              return;
            }
            const loadedMatch = matches.getMatch(match.id);
            if (!loadedMatch) {
              return;
            }
            targetPublished = true;
            matches.batch(() => {
              if (previous && canCacheMatch(previous)) {
                matches.setCached([
                  ...matches
                    .getState()
                    .cachedMatches.filter((candidate) => candidate.id !== previous.id),
                  previous,
                ]);
                const previousRoute = compiled.byId.get(previous.routeId);
                if (previousRoute) {
                  loading.scheduleGc(previous, previousRoute);
                }
              }
              matches.setActive([{ ...loadedMatch, module }]);
              matches.setPending([]);
              matches.setLocation(location, location);
            });
          },
        );
      } catch (error) {
        if (!hookOptions.shouldRun()) {
          return;
        }
        if (isRouteRedirect(error)) {
          matches.updateMatch(match.id, (current) => ({
            ...current,
            status: "redirected",
            isFetching: false,
            error,
            updatedAt: Date.now(),
          }));
          matches.setStatus("redirected");
          currentRun = null;
          if (hookOptions.cause !== "preload") {
            await handleLocation(error.location, context, false, "replace");
          }
          return;
        }
        const status = isRouteNotFound(error) ? "notFound" : "error";
        const failedMatch = matches.getMatch(match.id);
        if (failedMatch) {
          const currentActive = targetPublished ? previous : matches.getActiveMatch();
          matches.batch(() => {
            if (!targetPublished && !sameMatch && currentActive && canCacheMatch(currentActive)) {
              matches.setCached([...matches.getState().cachedMatches, currentActive]);
              const currentRoute = compiled.byId.get(currentActive.routeId);
              if (currentRoute) {
                loading.scheduleGc(currentActive, currentRoute);
              }
            }
            matches.updateMatch(match.id, (current) => ({
              ...current,
              status,
              isFetching: false,
              error,
              updatedAt: Date.now(),
            }));
            if (!targetPublished) {
              matches.setActive([matches.getMatch(match.id) ?? failedMatch]);
            }
            matches.setPending([]);
            matches.setLocation(location, location);
            matches.setStatus(status);
          });
        } else {
          matches.setStatus(status);
        }
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
      };
      const currentActive = targetPublished ? previous : matches.getActiveMatch();
      matches.batch(() => {
        if (!targetPublished && !sameMatch && currentActive && canCacheMatch(currentActive)) {
          matches.setCached([...matches.getState().cachedMatches, currentActive]);
          const currentRoute = compiled.byId.get(currentActive.routeId);
          if (currentRoute) {
            loading.scheduleGc(currentActive, currentRoute);
          }
        }
        matches.setActive([resolvedMatch]);
        matches.setPending([]);
        matches.setLocation(run.location, run.location);
        matches.setStatus("success");
      });

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
        const error = lifecycleErrors[0];
        matches.updateMatch(resolvedMatch.id, (current) => ({
          ...current,
          status: "error",
          error,
        }));
        matches.setStatus("error");
        if (isCurrentRun(currentRun, run)) {
          currentRun = null;
        }
        throw error;
      }
      if (isCurrentRun(currentRun, run)) {
        currentRun = null;
      }
    })();
    run.promise = navigation;
    if (backgroundReload) {
      void navigation.catch(() => undefined);
      return;
    }
    await navigation;
  };

  const handleLocation = async (
    location: RouteLocation,
    context: TLoadContext,
    revalidate = false,
    history: RouterNavigationOptions["history"] = "none",
  ): Promise<void> => {
    const normalized = normalizeLocation(location);
    const matched = compiled.routeIdFromPath(normalized.pathname, basePath);
    if (!matched) {
      cancelRun(currentRun);
      currentRun = null;
      matches.batch(() => {
        matches.setActive([]);
        matches.setPending([]);
        matches.setLocation(normalized, null);
        matches.setStatus("notFound");
      });
      return;
    }
    await navigate(matched, context, { history, revalidate }, normalized);
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
    lastContext = context;
    hasLastContext = true;
    const deps = route.loaderDeps?.(context, location) ?? "";
    const matchId = matchIdForLocation(routeId, deps);
    const existing = matches.getMatch(matchId);
    const cached = matches.getCachedMatch(matchId);
    const active = matches.getActiveMatch();
    if (active?.id === matchId && active.status === "success" && !active.invalid) {
      return Promise.resolve();
    }
    const match =
      existing ??
      createRouteMatch<TRouteId, TModule, TData>(
        routeId,
        location,
        deps,
        "preload",
        new AbortController(),
        true,
      );
    if (!existing) {
      matches.setCached([
        ...matches.getState().cachedMatches.filter((candidate) => candidate.id !== match.id),
        match,
      ]);
    }
    const controller = match.abortController;
    const cause = existing && !cached ? match.cause : "preload";
    const hookOptions: RouteHookOptions = {
      signal: controller.signal,
      shouldRun: () => !controller.signal.aborted,
      revalidating: false,
      location,
      deps,
      cause,
    };
    return loading
      .loadRoute(match, route, context, hookOptions, false)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (isRouteRedirect(error)) {
          matches.removeCached(match.id);
          return preloadLocation(error.location, context);
        }
        matches.removeCached(match.id);
      });
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
      const active = matches.getActiveMatch();
      if (!active || (routeId !== undefined && active.routeId !== routeId) || !hasLastContext) {
        return Promise.resolve();
      }
      return navigate(
        active.routeId,
        lastContext as TLoadContext,
        { history: "none" },
        active.location,
      );
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
      if (!matched) {
        cancelRun(currentRun);
        currentRun = null;
        matches.batch(() => {
          matches.setActive([]);
          matches.setPending([]);
          matches.setLocation(normalized, null);
          matches.setStatus("notFound");
        });
        return Promise.resolve();
      }
      return navigate(matched, context, { history: "none" }, normalized);
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
      history = undefined;
      lastContext = undefined;
      hasLastContext = false;
      loading.clear();
      matches.clear();
    },
  };
}
