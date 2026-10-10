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

/** Returns true when a plugin path must pass gateway auth before routing. */
export function shouldEnforceGatewayAuthForPluginPath(
  registry: PluginRegistry,
  pathnameOrContext: string | PluginRoutePathContext,
): boolean {
  const pathContext =
    typeof pathnameOrContext === "string"
      ? resolvePluginRoutePathContext(pathnameOrContext)
      : pathnameOrContext;
  if (pathContext.malformedEncoding || pathContext.decodePassLimitReached) {
    return true;
  }
  if (isProtectedPluginRoutePathFromContext(pathContext)) {
    return true;
  }
  return matchedPluginRoutesRequireGatewayAuth(findMatchingPluginHttpRoutes(registry, pathContext));
}

/** Returns true only when an existing route owns authentication entirely inside its plugin. */
export function isPluginAuthenticatedRoutePath(
  registry: PluginRegistry,
  pathnameOrContext: string | PluginRoutePathContext,
): boolean {
  const pathContext =
    typeof pathnameOrContext === "string"
      ? resolvePluginRoutePathContext(pathnameOrContext)
      : pathnameOrContext;
  if (
    pathContext.malformedEncoding ||
    pathContext.decodePassLimitReached ||
    isProtectedPluginRoutePathFromContext(pathContext)
  ) {
    return false;
  }
  const matchedRoutes = findMatchingPluginHttpRoutes(registry, pathContext);
  return matchedRoutes.length > 0 && matchedRoutes.every((route) => route.auth === "plugin");
}
