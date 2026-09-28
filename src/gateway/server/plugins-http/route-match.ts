import { getPluginHttpRouteCanonicalPath, prefixMatchPath } from "../../../plugins/http-path.js";
import type { PluginRegistry } from "../../../plugins/registry.js";
import { resolvePluginRoutePathContext, type PluginRoutePathContext } from "./path-context.js";

type PluginHttpRouteEntry = NonNullable<PluginRegistry["httpRoutes"]>[number];

/** Finds matching plugin routes with exact matches ordered before prefix matches. */
export function findMatchingPluginHttpRoutes(
  registry: PluginRegistry,
  context: PluginRoutePathContext,
): PluginHttpRouteEntry[] {
  const routes = registry.httpRoutes ?? [];
  if (routes.length === 0) {
    return [];
  }
  const exactMatches: PluginHttpRouteEntry[] = [];
  const prefixMatches: PluginHttpRouteEntry[] = [];
  for (const route of routes) {
    const routePath = getPluginHttpRouteCanonicalPath(route);
    const prefix = route.match === "prefix";
    if (
      context.candidates.some((candidate) =>
        prefix ? prefixMatchPath(candidate, routePath) : candidate === routePath,
      )
    ) {
      (prefix ? prefixMatches : exactMatches).push(route);
    }
  }
  exactMatches.sort((a, b) => b.path.length - a.path.length);
  prefixMatches.sort((a, b) => b.path.length - a.path.length);
  return [...exactMatches, ...prefixMatches];
}

/** Returns the first registered plugin HTTP route for a raw request path. */
export function findRegisteredPluginHttpRoute(
  registry: PluginRegistry,
  pathname: string,
): PluginHttpRouteEntry | undefined {
  const pathContext = resolvePluginRoutePathContext(pathname);
  return findMatchingPluginHttpRoutes(registry, pathContext)[0];
}

/** Convenience predicate for checking whether a raw path is a plugin HTTP route. */
export function isRegisteredPluginHttpRoutePath(
  registry: PluginRegistry,
  pathname: string,
): boolean {
  return findRegisteredPluginHttpRoute(registry, pathname) !== undefined;
}
