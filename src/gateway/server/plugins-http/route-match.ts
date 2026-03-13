import type { PluginRegistry } from "../../../plugins/registry.js";
import { canonicalizePathVariant } from "../../security-path.js";
import {
  prefixMatchPath,
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./path-context.js";

type PluginHttpRouteEntry = NonNullable<PluginRegistry["httpRoutes"]>[number];

export function doesPluginRouteMatchPath(
  route: PluginHttpRouteEntry,
  context: PluginRoutePathContext,
): boolean {
  const routeCanonicalPath = canonicalizePathVariant(route.path);
  if (route.match === "prefix") {
    return context.candidates.some((candidate) => prefixMatchPath(candidate, routeCanonicalPath));
  }
  return context.candidates.some((candidate) => candidate === routeCanonicalPath);
}

export function findMatchingPluginHttpRoutes(
  registry: PluginRegistry,
  context: PluginRoutePathContext,
): PluginHttpRouteEntry[] {
  // When plugins are loaded through jiti, the registry passed here may come
  // from a different VM realm than the one that owns the HTTP routes.  Fall
  // back to the authoritative registry stored on process by
  // createGatewayPluginRequestHandler.
  const liveRegistry = (process as unknown as { __openclawPluginRegistry?: PluginRegistry })
    .__openclawPluginRegistry;
  const ownRoutes = registry.httpRoutes ?? [];
  const liveRoutes =
    liveRegistry && liveRegistry !== registry ? (liveRegistry.httpRoutes ?? []) : [];
  // NOTE: liveRoutes is only non-empty when registry is a jiti-realm stub
  // with an empty httpRoutes array.  If ownRoutes is also non-empty, both
  // sets are merged; callers must not register routes in both realms for the
  // same path, or they will be dispatched twice.
  const routes = liveRoutes.length > 0 ? [...ownRoutes, ...liveRoutes] : ownRoutes;
  if (routes.length === 0) {
    return [];
  }
  const exactMatches: PluginHttpRouteEntry[] = [];
  const prefixMatches: PluginHttpRouteEntry[] = [];
  for (const route of routes) {
    if (!doesPluginRouteMatchPath(route, context)) {
      continue;
    }
    if (route.match === "prefix") {
      prefixMatches.push(route);
    } else {
      exactMatches.push(route);
    }
  }
  exactMatches.sort((a, b) => b.path.length - a.path.length);
  prefixMatches.sort((a, b) => b.path.length - a.path.length);
  return [...exactMatches, ...prefixMatches];
}

export function findRegisteredPluginHttpRoute(
  registry: PluginRegistry,
  pathname: string,
): PluginHttpRouteEntry | undefined {
  const pathContext = resolvePluginRoutePathContext(pathname);
  return findMatchingPluginHttpRoutes(registry, pathContext)[0];
}

export function isRegisteredPluginHttpRoutePath(
  registry: PluginRegistry,
  pathname: string,
): boolean {
  return findRegisteredPluginHttpRoute(registry, pathname) !== undefined;
}
