import type { IncomingMessage, ServerResponse } from "node:http";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import {
  resolvePluginRoutePathContext,
  type PluginRoutePathContext,
} from "./plugins-http/path-context.js";
import { matchedPluginRoutesRequireGatewayAuth } from "./plugins-http/route-auth.js";
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
  dispatchContext?: { gatewayAuthSatisfied?: boolean },
) => Promise<boolean>;

export function createGatewayPluginRequestHandler(params: {
  registry: PluginRegistry;
  log: SubsystemLogger;
}): PluginHttpRequestHandler {
  const { registry, log } = params;
  return async (req, res, providedPathContext, dispatchContext) => {
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
    if (
      matchedPluginRoutesRequireGatewayAuth(matchedRoutes) &&
      dispatchContext?.gatewayAuthSatisfied === false
    ) {
      log.warn(`plugin http route blocked without gateway auth (${pathContext.canonicalPath})`);
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
