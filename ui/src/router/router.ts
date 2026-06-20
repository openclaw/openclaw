import type {
  MaybePromise,
  PageDefinition,
  RouteHookOptions,
  RouteLocation,
  RouteLoadCause,
  RouteState,
  Router,
  RouterNavigationOptions,
  RouterOptions,
  RouterHistory,
} from "./types.ts";

type CompiledRoutes<TRouteId extends string, TLoadContext, TModule, TData> = {
  byId: Map<TRouteId, PageDefinition<TRouteId, TLoadContext, TModule, TData>>;
  byPath: Map<string, TRouteId>;
  pathForRoute: (routeId: TRouteId, basePath?: string) => string;
  routeIdFromPath: (pathname: string, basePath?: string) => TRouteId | null;
};

type NavigationRun = {
  controller: AbortController;
};

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

const DEFAULT_STALE_TIME = 0;
const DEFAULT_PRELOAD_STALE_TIME = 30_000;
const DEFAULT_GC_TIME = 30 * 60_000;

export function normalizeRouteBasePath(basePath: string): string {
  const value = basePath.trim();
  if (!value || value === "/") {
    return "";
  }
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

export function normalizeRoutePath(path: string): string {
  const value = path.trim();
  if (!value) {
    return "/";
  }
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function pathKey(path: string): string {
  const normalized = normalizeRoutePath(path).toLowerCase();
  if (normalized.endsWith("/index.html")) {
    return normalizeRoutePath(normalized.slice(0, -"/index.html".length));
  }
  return normalized;
}

function normalizeLocation(location: RouteLocation): RouteLocation {
  return {
    pathname: normalizeRoutePath(location.pathname),
    search: location.search,
    hash: location.hash,
  };
}

function locationsEqual(left: RouteLocation | null, right: RouteLocation): boolean {
  return Boolean(
    left &&
    right &&
    left.pathname === right.pathname &&
    left.search === right.search &&
    left.hash === right.hash,
  );
}

function pathnameWithoutBase(pathname: string, basePath: string): string {
  const base = normalizeRouteBasePath(basePath);
  const path = normalizeRoutePath(pathname);
  if (path === base) {
    return "/";
  }
  return base && path.startsWith(`${base}/`) ? path.slice(base.length) : path;
}

function compileRoutes<TRouteId extends string, TLoadContext, TModule, TData>(
  routes: RouterOptions<TRouteId, TLoadContext, TModule, TData>["routes"],
  defaultRouteId: TRouteId | null,
): CompiledRoutes<TRouteId, TLoadContext, TModule, TData> {
  const byId = new Map<TRouteId, PageDefinition<TRouteId, TLoadContext, TModule, TData>>();
  const byPath = new Map<string, TRouteId>();

  for (const route of routes) {
    if (byId.has(route.id)) {
      throw new Error(`Duplicate route id "${route.id}".`);
    }
    const normalizedRoute = { ...route, path: normalizeRoutePath(route.path) };
    byId.set(route.id, normalizedRoute);
    for (const candidate of [normalizedRoute.path, ...(route.aliases ?? [])]) {
      const key = pathKey(candidate);
      const existing = byPath.get(key);
      if (existing && existing !== route.id) {
        throw new Error(`Duplicate route path "${candidate}".`);
      }
      byPath.set(key, route.id);
    }
  }

  return {
    byId,
    byPath,
    pathForRoute(routeId, basePath = "") {
      const route = byId.get(routeId);
      if (!route) {
        throw new Error(`Unknown route id "${routeId}".`);
      }
      const base = normalizeRouteBasePath(basePath);
      return base ? `${base}${route.path}` : route.path;
    },
    routeIdFromPath(pathname, basePath = "") {
      const key = pathKey(pathnameWithoutBase(pathname, basePath));
      return byPath.get(key) ?? (key === "/" ? defaultRouteId : null);
    },
  };
}

function locationForPath(path: string): RouteLocation {
  const hashIndex = path.indexOf("#");
  const searchIndex = path.indexOf("?");
  const queryStart =
    searchIndex < 0 ? hashIndex : hashIndex < 0 ? searchIndex : Math.min(searchIndex, hashIndex);
  const hashStart = hashIndex < 0 ? path.length : hashIndex;
  const pathnameEnd = queryStart < 0 ? path.length : queryStart;
  const searchEnd = hashIndex < 0 ? path.length : hashIndex;
  return {
    pathname: normalizeRoutePath(path.slice(0, pathnameEnd)),
    search: queryStart >= 0 && queryStart < hashStart ? path.slice(queryStart, searchEnd) : "",
    hash: hashStart < path.length ? path.slice(hashStart) : "",
  };
}

function isCurrentRun(current: NavigationRun | null, run: NavigationRun): boolean {
  return current === run && !run.controller.signal.aborted;
}

function cancelRun(run: NavigationRun | null): void {
  run?.controller.abort();
}

function dataCacheKey<TRouteId extends string>(routeId: TRouteId, deps: string): string {
  return `${routeId}\u0000${deps}`;
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
  const moduleCache = new Map<TRouteId, Promise<TModule>>();
  const moduleValues = new Map<TRouteId, TModule>();
  const dataCache = new Map<string, DataEntry<TData>>();
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

  const now = () => Date.now();

  const publish = (next: RouteState<TRouteId, TData>) => {
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  };

  const scheduleGc = (
    entry: DataEntry<TData>,
    route: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
  ) => {
    if (entry.gcTimer) {
      globalThis.clearTimeout(entry.gcTimer);
    }
    const lifetime = route.gcTime ?? gcTime;
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
        ? (route.preloadStaleTime ?? preloadStaleTime)
        : (route.staleTime ?? staleTime);
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

  const loadRoute = async (
    route: PageDefinition<TRouteId, TLoadContext, TModule, TData>,
    context: TLoadContext,
    hookOptions: RouteHookOptions,
    force: boolean,
  ) => {
    const [data, module] = await Promise.all([
      loadData(route, context, hookOptions, force),
      loadModule(route),
    ]);
    return { data, module };
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
    const cachedPending = dataCache.get(dataCacheKey(routeId, hookOptions.deps));
    const pendingData = cachedPending?.status === "success" ? cachedPending.data : undefined;
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
        result = await loadRoute(
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
    if (!matched && history) {
      history.replace({ ...canonical, search: normalized.search, hash: normalized.hash });
    }
    await navigate(routeId, context, { history: "none", revalidate }, normalized);
  };

  const invalidate = (routeId?: TRouteId) => {
    for (const [key, entry] of dataCache) {
      if (routeId === undefined || entry.routeId === routeId) {
        if (entry.gcTimer) {
          globalThis.clearTimeout(entry.gcTimer);
        }
        dataCache.delete(key);
      }
    }
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
    return loadRoute(route, context, options, false).then(() => undefined);
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
    getLoadedModule: (routeId: TRouteId) => moduleValues.get(routeId),
    preloadRoute,
    preloadLocation,
    invalidate,
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
      return routeId
        ? navigate(routeId, context, { history: "none" }, normalized)
        : Promise.resolve();
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
      invalidate(routeId);
      const location = state.resolved ?? state.requested;
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
      for (const entry of dataCache.values()) {
        if (entry.gcTimer) {
          globalThis.clearTimeout(entry.gcTimer);
        }
      }
      dataCache.clear();
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
