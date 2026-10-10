import type {
  PluginHttpRouteRegistration,
  PluginRegistry,
} from "../../../plugins/registry-types.js";
import {
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./path-context.js";
import { findMatchingPluginHttpRoutes } from "./route-match.js";

export function matchedPluginRoutesRequireGatewayAuth(
  routes: readonly Pick<PluginHttpRouteRegistration, "auth">[],
): boolean {
  return routes.some((route) => route.auth === "gateway");
}

function findRoutesOutsideProtectedPaths(
  registry: PluginRegistry,
  pathnameOrContext: string | PluginRoutePathContext,
) {
  const pathContext =
    typeof pathnameOrContext === "string"
      ? resolvePluginRoutePathContext(pathnameOrContext)
      : pathnameOrContext;
  if (
    pathContext.malformedEncoding ||
    pathContext.decodePassLimitReached ||
    isProtectedPluginRoutePathFromContext(pathContext)
  ) {
    return undefined;
  }
  return findMatchingPluginHttpRoutes(registry, pathContext);
}

/** Returns true when a plugin path must pass gateway auth before routing. */
export function shouldEnforceGatewayAuthForPluginPath(
  registry: PluginRegistry,
  pathnameOrContext: string | PluginRoutePathContext,
): boolean {
  const routes = findRoutesOutsideProtectedPaths(registry, pathnameOrContext);
  return routes === undefined || matchedPluginRoutesRequireGatewayAuth(routes);
}

/** Returns true only when an existing route owns authentication entirely inside its plugin. */
export function isPluginAuthenticatedRoutePath(
  registry: PluginRegistry,
  pathnameOrContext: string | PluginRoutePathContext,
): boolean {
  const routes = findRoutesOutsideProtectedPaths(registry, pathnameOrContext);
  return Boolean(routes?.length && routes.every((route) => route.auth === "plugin"));
}
