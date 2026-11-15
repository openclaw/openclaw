import { getPluginHttpRouteCanonicalPath, prefixMatchPath } from "../../../plugins/http-path.js";
import type {
  PluginHttpRouteRegistration,
  PluginRegistry,
} from "../../../plugins/registry-types.js";
import { resolvePluginRoutePathContext, type PluginRoutePathContext } from "./path-context.js";

/** Finds matching plugin routes with exact matches ordered before prefix matches. */
export function findMatchingPluginHttpRoutes(
  registry: PluginRegistry,
  context: PluginRoutePathContext,
): PluginHttpRouteRegistration[] {
  const routes = registry.httpRoutes ?? [];
  if (routes.length === 0) {
    return [];
  }
  const exactMatches: PluginHttpRouteRegistration[] = [];
  const prefixMatches: PluginHttpRouteRegistration[] = [];
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

export function findRegisteredPluginHttpRoute(
  registry: PluginRegistry,
  pathname: string,
): PluginHttpRouteRegistration | undefined {
  const pathContext = resolvePluginRoutePathContext(pathname);
  return findMatchingPluginHttpRoutes(registry, pathContext)[0];
}
