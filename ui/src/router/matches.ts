import type {
  PageDefinition,
  RouteLocation,
  RouteMatch,
  RouterOptions,
  RouterState,
  RouterStateSelector,
} from "./types.ts";

export type MatchStore<TRouteId extends string, TModule, TData> = {
  batch: (operation: () => void) => void;
  getState: () => RouterState<TRouteId, TModule, TData>;
  getMatch: (matchId: string) => RouteMatch<TRouteId, TModule, TData> | undefined;
  getCachedMatch: (matchId: string) => RouteMatch<TRouteId, TModule, TData> | undefined;
  getActiveMatch: () => RouteMatch<TRouteId, TModule, TData> | undefined;
  setLocation: (location: RouteLocation, resolvedLocation: RouteLocation | null) => void;
  setStatus: (status: RouterState<TRouteId, TModule, TData>["status"]) => void;
  setActive: (matches: readonly RouteMatch<TRouteId, TModule, TData>[]) => void;
  setPending: (matches: readonly RouteMatch<TRouteId, TModule, TData>[]) => void;
  setCached: (matches: readonly RouteMatch<TRouteId, TModule, TData>[]) => void;
  removeCached: (matchId: string) => void;
  updateMatch: (
    matchId: string,
    update: (match: RouteMatch<TRouteId, TModule, TData>) => RouteMatch<TRouteId, TModule, TData>,
  ) => boolean;
  invalidate: (routeId?: TRouteId) => void;
  clear: () => void;
  subscribe: (listener: (state: RouterState<TRouteId, TModule, TData>) => void) => () => boolean;
  subscribeSelector: <TSelected>(
    selector: RouterStateSelector<RouterState<TRouteId, TModule, TData>, TSelected>,
    listener: (next: TSelected) => void,
    equal?: (previous: TSelected, next: TSelected) => boolean,
  ) => () => boolean;
  subscribeMatch: (
    matchId: string,
    listener: (match: RouteMatch<TRouteId, TModule, TData> | undefined) => void,
  ) => () => boolean;
};

export type CompiledRoutes<TRouteId extends string, TLoadContext, TModule, TData> = {
  byId: Map<TRouteId, PageDefinition<TRouteId, TLoadContext, TModule, TData>>;
  byPath: Map<string, TRouteId>;
  pathForRoute: (routeId: TRouteId, basePath?: string) => string;
  routeIdFromPath: (pathname: string, basePath?: string) => TRouteId | null;
};

export function matchIdForLocation<TRouteId extends string>(
  routeId: TRouteId,
  deps: string,
): string {
  return `${routeId}\u0000${deps}`;
}

export function createRouteMatch<TRouteId extends string, TModule, TData>(
  routeId: TRouteId,
  location: RouteLocation,
  deps: string,
  cause: RouteMatch<TRouteId, TModule, TData>["cause"],
  abortController: AbortController,
  preload = false,
): RouteMatch<TRouteId, TModule, TData> {
  return {
    id: matchIdForLocation(routeId, deps),
    routeId,
    location,
    deps,
    status: "pending",
    isFetching: false,
    updatedAt: 0,
    fetchCount: 0,
    abortController,
    cause,
    preload,
    invalid: false,
  };
}

export function createMatchStore<TRouteId extends string, TModule, TData>(): MatchStore<
  TRouteId,
  TModule,
  TData
> {
  const active = new Map<string, RouteMatch<TRouteId, TModule, TData>>();
  const pending = new Map<string, RouteMatch<TRouteId, TModule, TData>>();
  const cached = new Map<string, RouteMatch<TRouteId, TModule, TData>>();
  const listeners = new Set<(state: RouterState<TRouteId, TModule, TData>) => void>();
  const matchListeners = new Map<
    string,
    Set<(match: RouteMatch<TRouteId, TModule, TData> | undefined) => void>
  >();
  let location = locationForPath("/");
  let resolvedLocation: RouteLocation | null = null;
  let status: RouterState<TRouteId, TModule, TData>["status"] = "idle";
  let activeSnapshot: readonly RouteMatch<TRouteId, TModule, TData>[] = [];
  let pendingSnapshot: readonly RouteMatch<TRouteId, TModule, TData>[] = [];
  let cachedSnapshot: readonly RouteMatch<TRouteId, TModule, TData>[] = [];
  let transactionDepth = 0;
  let dirty = false;
  const changedMatchIds = new Set<string>();

  const readState = (): RouterState<TRouteId, TModule, TData> => ({
    location,
    resolvedLocation,
    status,
    matches: activeSnapshot,
    pendingMatches: pendingSnapshot,
    cachedMatches: cachedSnapshot,
  });

  const refreshSnapshots = () => {
    activeSnapshot = [...active.values()];
    pendingSnapshot = [...pending.values()];
    cachedSnapshot = [...cached.values()];
  };

  const notify = (matchId?: string) => {
    dirty = true;
    if (matchId) {
      changedMatchIds.add(matchId);
    }
    if (transactionDepth > 0) {
      return;
    }
    const next = readState();
    const ids = [...changedMatchIds];
    changedMatchIds.clear();
    dirty = false;
    for (const listener of listeners) {
      listener(next);
    }
    for (const id of ids) {
      const match = active.get(id) ?? pending.get(id) ?? cached.get(id);
      for (const listener of matchListeners.get(id) ?? []) {
        listener(match);
      }
    }
  };

  const batch = (operation: () => void) => {
    transactionDepth += 1;
    try {
      operation();
    } finally {
      transactionDepth -= 1;
      if (transactionDepth === 0 && dirty) {
        notify();
      }
    }
  };

  const removeFromOtherPools = (
    id: string,
    keep: Map<string, RouteMatch<TRouteId, TModule, TData>>,
  ) => {
    for (const pool of [active, pending, cached]) {
      if (pool !== keep && pool.delete(id)) {
        changedMatchIds.add(id);
      }
    }
  };

  const setPool = (
    pool: Map<string, RouteMatch<TRouteId, TModule, TData>>,
    matches: readonly RouteMatch<TRouteId, TModule, TData>[],
  ) => {
    let changed = false;
    const nextIds = new Set(matches.map((match) => match.id));
    for (const id of pool.keys()) {
      if (!nextIds.has(id)) {
        pool.delete(id);
        changedMatchIds.add(id);
        changed = true;
      }
    }
    for (const match of matches) {
      const previous = pool.get(match.id);
      removeFromOtherPools(match.id, pool);
      if (previous !== match) {
        pool.set(match.id, match);
        changedMatchIds.add(match.id);
        changed = true;
      }
    }
    if (changed) {
      refreshSnapshots();
      notify();
    }
  };

  const getMatch = (matchId: string) =>
    active.get(matchId) ?? pending.get(matchId) ?? cached.get(matchId);

  return {
    batch,
    getState: readState,
    getMatch,
    getCachedMatch: (matchId) => cached.get(matchId),
    getActiveMatch: () => active.values().next().value,
    setLocation(nextLocation, nextResolvedLocation) {
      if (
        location.pathname === nextLocation.pathname &&
        location.search === nextLocation.search &&
        location.hash === nextLocation.hash &&
        resolvedLocation?.pathname === nextResolvedLocation?.pathname &&
        resolvedLocation?.search === nextResolvedLocation?.search &&
        resolvedLocation?.hash === nextResolvedLocation?.hash
      ) {
        return;
      }
      location = nextLocation;
      resolvedLocation = nextResolvedLocation;
      notify();
    },
    setStatus(nextStatus) {
      if (status === nextStatus) {
        return;
      }
      status = nextStatus;
      notify();
    },
    setActive(matches) {
      batch(() => setPool(active, matches));
    },
    setPending(matches) {
      batch(() => setPool(pending, matches));
    },
    setCached(matches) {
      batch(() => setPool(cached, matches));
    },
    removeCached(matchId) {
      if (!cached.delete(matchId)) {
        return;
      }
      refreshSnapshots();
      notify(matchId);
    },
    updateMatch(matchId, update) {
      const pool = [active, pending, cached].find((candidate) => candidate.has(matchId));
      const current = pool?.get(matchId);
      if (!pool || !current) {
        return false;
      }
      const next = update(current);
      if (next !== current) {
        pool.set(matchId, next);
        refreshSnapshots();
        notify(matchId);
      }
      return true;
    },
    invalidate(routeId) {
      batch(() => {
        for (const pool of [active, pending, cached]) {
          for (const [id, match] of pool) {
            if (routeId === undefined || match.routeId === routeId) {
              pool.set(id, {
                ...match,
                invalid: true,
                ...(match.status === "error" || match.status === "notFound"
                  ? { status: "pending" as const, error: undefined }
                  : {}),
              });
              notify(id);
            }
          }
        }
        refreshSnapshots();
      });
    },
    clear() {
      batch(() => {
        for (const pool of [active, pending, cached]) {
          for (const id of pool.keys()) {
            changedMatchIds.add(id);
          }
          pool.clear();
        }
        refreshSnapshots();
        location = locationForPath("/");
        resolvedLocation = null;
        status = "idle";
        notify();
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeSelector(selector, listener, equal = Object.is) {
      let previous = selector(readState());
      const selectedListener = (state: RouterState<TRouteId, TModule, TData>) => {
        const next = selector(state);
        if (equal(previous, next)) {
          return;
        }
        previous = next;
        listener(next);
      };
      listeners.add(selectedListener);
      return () => listeners.delete(selectedListener);
    },
    subscribeMatch(matchId, listener) {
      const current = matchListeners.get(matchId) ?? new Set();
      current.add(listener);
      matchListeners.set(matchId, current);
      return () => {
        current.delete(listener);
        if (current.size === 0) {
          matchListeners.delete(matchId);
        }
        return true;
      };
    },
  };
}

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

export function normalizeLocation(location: RouteLocation): RouteLocation {
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

export function compileRoutes<TRouteId extends string, TLoadContext, TModule, TData>(
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

export function locationForPath(path: string): RouteLocation {
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
