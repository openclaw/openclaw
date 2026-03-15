import type { IncomingMessage, ServerResponse } from "node:http";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginHttpRouteRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE, PAIRING_SCOPE, WRITE_SCOPE } from "../method-scopes.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../protocol/client-info.js";
import { PROTOCOL_VERSION } from "../protocol/index.js";
import type { GatewayRequestOptions } from "../server-methods/types.js";
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

function createPluginRouteRuntimeClient(params: {
  requiresGatewayAuth: boolean;
  gatewayAuthSatisfied?: boolean;
}): GatewayRequestOptions["client"] {
  // Plugin-authenticated webhooks can still use non-admin subagent helpers,
  // but they must not inherit admin-only gateway methods by default.
  const scopes =
    params.requiresGatewayAuth && params.gatewayAuthSatisfied !== false
      ? [ADMIN_SCOPE, APPROVALS_SCOPE, PAIRING_SCOPE]
      : [WRITE_SCOPE];
  return {
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        version: "internal",
        platform: "node",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
      role: "operator",
      scopes,
    },
  };
}

export type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: { gatewayAuthSatisfied?: boolean },
) => Promise<boolean>;

function resolveCurrentPluginRegistry(fallback: PluginRegistry): PluginRegistry {
  const routeRegistry = getActivePluginHttpRouteRegistry();
  if (!routeRegistry) {
    return fallback;
  }
  const routeCount = routeRegistry.httpRoutes?.length ?? 0;
  const fallbackRouteCount = fallback.httpRoutes?.length ?? 0;
  if (routeCount === 0 && fallbackRouteCount > 0) {
    return fallback;
  }
  return routeRegistry;
}

export function createGatewayPluginRequestHandler(params: {
  registry: PluginRegistry;
  log: SubsystemLogger;
}): PluginHttpRequestHandler {
  const { log } = params;
  return async (req, res, providedPathContext, dispatchContext) => {
    const registry = resolveCurrentPluginRegistry(params.registry);
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
    const requiresGatewayAuth = matchedPluginRoutesRequireGatewayAuth(matchedRoutes);
    if (requiresGatewayAuth && dispatchContext?.gatewayAuthSatisfied === false) {
      log.warn(`plugin http route blocked without gateway auth (${pathContext.canonicalPath})`);
      return false;
    }
    const runtimeClient = createPluginRouteRuntimeClient({
      requiresGatewayAuth,
      gatewayAuthSatisfied: dispatchContext?.gatewayAuthSatisfied,
    });

    return await withPluginRuntimeGatewayRequestScope(
      {
        client: runtimeClient,
        isWebchatConnect: () => false,
      },
      async () => {
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
      },
    );
  };
}
