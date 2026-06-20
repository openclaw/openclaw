import type { PageDefinition, RouteLocation, RouterOptions } from "./types.ts";

export type CompiledRoutes<TRouteId extends string, TLoadContext, TModule, TData> = {
  byId: Map<TRouteId, PageDefinition<TRouteId, TLoadContext, TModule, TData>>;
  byPath: Map<string, TRouteId>;
  pathForRoute: (routeId: TRouteId, basePath?: string) => string;
  routeIdFromPath: (pathname: string, basePath?: string) => TRouteId | null;
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

export function locationsEqual(left: RouteLocation | null, right: RouteLocation): boolean {
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
