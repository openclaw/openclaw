import type {
  PageDefinition,
  RouteHookOptions,
  RouteLocation,
  RouteState,
  RouterHistory,
} from "./types.ts";

type RouterOptions<TRouteId extends string, TLoadContext, TModule> = {
  routes: readonly PageDefinition<TRouteId, TLoadContext, TModule>[];
  defaultRouteId?: TRouteId;
};

type NavigationOptions = {
  history?: "none" | "push" | "replace";
  revalidate?: boolean;
};

type CompiledRoutes<TRouteId extends string, TLoadContext, TModule> = {
  byId: Map<TRouteId, PageDefinition<TRouteId, TLoadContext, TModule>>;
  byPath: Map<string, TRouteId>;
  pathForRoute: (routeId: TRouteId, basePath?: string) => string;
  routeIdFromPath: (pathname: string, basePath?: string) => TRouteId | null;
};

type NavigationRun = {
  controller: AbortController;
};

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
  return normalizeRoutePath(path).toLowerCase();
}

function normalizeLocation(location: RouteLocation): RouteLocation {
  return {
    pathname: normalizeRoutePath(location.pathname),
    search: location.search,
    hash: location.hash,
  };
}

function pathnameWithoutBase(pathname: string, basePath: string): string {
  const base = normalizeRouteBasePath(basePath);
  const path = normalizeRoutePath(pathname);
  if (path === base) {
    return "/";
  }
  return base && path.startsWith(`${base}/`) ? path.slice(base.length) : path;
}

function compileRoutes<TRouteId extends string, TLoadContext, TModule>(
  routes: RouterOptions<TRouteId, TLoadContext, TModule>["routes"],
): CompiledRoutes<TRouteId, TLoadContext, TModule> {
  const byId = new Map<TRouteId, PageDefinition<TRouteId, TLoadContext, TModule>>();
  const byPath = new Map<string, TRouteId>();

  for (const route of routes) {
    if (byId.has(route.id)) {
      throw new Error(`Duplicate route id "${route.id}".`);
    }
    const path = normalizeRoutePath(route.path);
    byId.set(route.id, { ...route, path });
    for (const candidate of [path, ...(route.aliases ?? [])]) {
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
      return byPath.get(pathKey(pathnameWithoutBase(pathname, basePath))) ?? null;
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

export function createRouter<TRouteId extends string, TLoadContext = unknown, TModule = unknown>(
  options: RouterOptions<TRouteId, TLoadContext, TModule>,
) {
  const compiled = compileRoutes(options.routes);
  const defaultRouteId = options.defaultRouteId ?? null;
  const moduleCache = new Map<TRouteId, Promise<TModule>>();
  const moduleValues = new Map<TRouteId, TModule>();
  const listeners = new Set<(state: RouteState<TRouteId>) => void>();
  let history: RouterHistory | undefined;
  let basePath = "";
  let stopHistory: (() => void) | undefined;
  let currentRun: NavigationRun | null = null;
  let resolvedRouteId: TRouteId | null = null;
  let state: RouteState<TRouteId> = {
    requested: locationForPath("/"),
    resolved: null,
    pendingRouteId: null,
    resolvedRouteId: null,
    status: "idle",
  };

  const publish = (next: RouteState<TRouteId>) => {
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  };

  const loadModule = (route: PageDefinition<TRouteId, TLoadContext, TModule>) => {
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

  const loadRoute = async (
    route: PageDefinition<TRouteId, TLoadContext, TModule>,
    context: TLoadContext,
    hookOptions: RouteHookOptions,
  ) => {
    await Promise.all([route.load?.(context, hookOptions), loadModule(route)]);
  };

  const runHook = async (
    routeId: TRouteId | null,
    hook: "onEnter" | "onLeave",
    context: TLoadContext,
    hookOptions: RouteHookOptions,
  ) => {
    if (!routeId || !hookOptions.shouldRun()) {
      return;
    }
    await compiled.byId.get(routeId)?.[hook]?.(context, hookOptions);
  };

  const navigate = async (
    routeId: TRouteId,
    context: TLoadContext,
    navigationOptions: NavigationOptions = {},
    requestedLocation = locationForPath(compiled.pathForRoute(routeId, basePath)),
  ): Promise<void> => {
    const route = compiled.byId.get(routeId);
    if (!route) {
      throw new Error(`Unknown route id "${routeId}".`);
    }
    if (
      resolvedRouteId === routeId &&
      state.status === "resolved" &&
      !navigationOptions.revalidate
    ) {
      return;
    }

    const location = normalizeLocation(requestedLocation);
    if (history && navigationOptions.history && navigationOptions.history !== "none") {
      history[navigationOptions.history](location);
    }

    currentRun?.controller.abort();
    const run: NavigationRun = { controller: new AbortController() };
    currentRun = run;
    const hookOptions: RouteHookOptions = {
      signal: run.controller.signal,
      shouldRun: () => isCurrentRun(currentRun, run),
    };
    const previousRouteId =
      navigationOptions.revalidate && resolvedRouteId === routeId ? null : resolvedRouteId;
    publish({
      requested: location,
      resolved: state.resolved,
      pendingRouteId: routeId,
      resolvedRouteId,
      status: "loading",
    });

    try {
      await loadRoute(route, context, hookOptions);
      if (!hookOptions.shouldRun()) {
        return;
      }
      resolvedRouteId = routeId;
      publish({
        requested: location,
        resolved: location,
        pendingRouteId: null,
        resolvedRouteId,
        status: "resolved",
      });
      await runHook(previousRouteId, "onLeave", context, hookOptions);
      await runHook(routeId, "onEnter", context, hookOptions);
    } catch (error) {
      if (!hookOptions.shouldRun()) {
        return;
      }
      publish({
        requested: location,
        resolved: state.resolved,
        pendingRouteId: null,
        resolvedRouteId,
        status: "error",
        error,
      });
      throw error;
    } finally {
      if (isCurrentRun(currentRun, run)) {
        currentRun = null;
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

  return {
    routes: [...compiled.byId.values()],
    getRoute: (routeId: TRouteId) => compiled.byId.get(routeId) ?? null,
    getLoadedModule: (routeId: TRouteId) => moduleValues.get(routeId),
    getState: () => state,
    subscribe(listener: (next: RouteState<TRouteId>) => void) {
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
      if (!routeId) {
        return Promise.resolve();
      }
      return navigate(routeId, context, { history: "none" }, normalized);
    },
    revalidate(context: TLoadContext): Promise<void> {
      if (!resolvedRouteId) {
        return Promise.resolve();
      }
      const routeId = resolvedRouteId;
      return navigate(routeId, context, { history: "none", revalidate: true });
    },
    stop() {
      stopHistory?.();
      stopHistory = undefined;
      currentRun?.controller.abort();
      currentRun = null;
      history = undefined;
    },
  };
}
