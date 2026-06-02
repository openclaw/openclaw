import type { PluginRegistry } from "../../../plugins/registry.js";
import {
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./path-context.js";
import { findMatchingPluginHttpRoutes } from "./route-match.js";

/** Returns true when any matched plugin route opted into Gateway auth. */
export function matchedPluginRoutesRequireGatewayAuth(
  routes: readonly Pick<NonNullable<PluginRegistry["httpRoutes"]>[number], "auth">[],
): boolean {
  return routes.some((route) => route.auth === "gateway");
}

/** Decides whether a plugin HTTP path must be protected before runtime dispatch. */
export function shouldEnforceGatewayAuthForPluginPath(
  registry: PluginRegistry,
  pathnameOrContext: string | PluginRoutePathContext,
): boolean {
  const pathContext =
    typeof pathnameOrContext === "string"
      ? resolvePluginRoutePathContext(pathnameOrContext)
      : pathnameOrContext;
  if (pathContext.malformedEncoding || pathContext.decodePassLimitReached) {
    // Ambiguous paths fail closed before checking plugin declarations.
    return true;
  }
  if (isProtectedPluginRoutePathFromContext(pathContext)) {
    return true;
  }
  return matchedPluginRoutesRequireGatewayAuth(findMatchingPluginHttpRoutes(registry, pathContext));
}
