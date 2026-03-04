import type { IncomingMessage, ServerResponse } from "node:http";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import {
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./plugins-http/path-context.js";
import { findMatchingPluginHttpRoutes } from "./plugins-http/route-match.js";

export {
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./plugins-http/path-context.js";
export {
  findRegisteredPluginHttpRoute,
  isRegisteredPluginHttpRoutePath,
} from "./plugins-http/route-match.js";
export { shouldEnforceGatewayAuthForPluginPath } from "./plugins-http/route-auth.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
) => Promise<boolean>;

export function createGatewayPluginRequestHandler(params: {
  /**
   * Callback that returns the current active plugin registry.
   * Called on every request so that routes registered after a plugin config
   * change (which replaces the active registry via setActivePluginRegistry)
   * are always visible to the HTTP handler without a gateway restart.
   */
  getRegistry: () => PluginRegistry;
  log: SubsystemLogger;
}): PluginHttpRequestHandler {
  const { getRegistry, log } = params;
  return async (req, res, providedPathContext) => {
    const registry = getRegistry();
    const routes = registry.httpRoutes ?? [];
    if (routes.length === 0) {
      return false;
    }

    const pathContext =
      providedPathContext ??
      (() => {
        const url = new URL(req.url ?? "/", "http://localhost");
        return resolvePluginRoutePathContext(url.pathname);
      })();
    const matchedRoutes = findMatchingPluginHttpRoutes(registry, pathContext);
    if (matchedRoutes.length === 0) {
      return false;
    }

    for (const route of matchedRoutes) {
      try {
        const handled = await route.handler(req, res);
        if (handled !== false) {
          return true;
        }
      } catch (err) {
        log.warn(`plugin http route failed (${route.pluginId ?? "unknown"}): ${String(err)}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Internal Server Error");
        }
        return true;
      }
    }
    return false;
  };
}
