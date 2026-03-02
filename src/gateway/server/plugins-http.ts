import type { IncomingMessage, ServerResponse } from "node:http";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { canonicalizePathVariant } from "../security-path.js";
import { isProtectedPluginRoutePath } from "../security-path.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

type PluginHttpRouteEntry = NonNullable<PluginRegistry["httpRoutes"]>[number];

export function findRegisteredPluginHttpRoute(
  registry: PluginRegistry,
  pathname: string,
): PluginHttpRouteEntry | undefined {
  const canonicalPath = canonicalizePathVariant(pathname);
  const routes = registry.httpRoutes ?? [];
  return routes.find((entry) => canonicalizePathVariant(entry.path) === canonicalPath);
}

// Only checks specific routes registered via registerHttpRoute, not wildcard handlers
// registered via registerHttpHandler. Wildcard handlers (e.g., webhooks) implement
// their own signature-based auth and are handled separately in the auth enforcement logic.
export function isRegisteredPluginHttpRoutePath(
  registry: PluginRegistry,
  pathname: string,
): boolean {
  return findRegisteredPluginHttpRoute(registry, pathname) !== undefined;
}

export function shouldEnforceGatewayAuthForPluginPath(
  registry: PluginRegistry,
  pathname: string,
): boolean {
  return (
    isProtectedPluginRoutePath(pathname) || isRegisteredPluginHttpRoutePath(registry, pathname)
  );
}

export function createGatewayPluginRequestHandler(params: {
  registry: PluginRegistry;
  log: SubsystemLogger;
}): PluginHttpRequestHandler {
  const { registry, log } = params;
  return async (req, res) => {
    const routes = registry.httpRoutes ?? [];
    const handlers = registry.httpHandlers ?? [];
    if (routes.length === 0 && handlers.length === 0) {
      return false;
    }

    if (routes.length > 0) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = findRegisteredPluginHttpRoute(registry, url.pathname);
      if (route) {
        try {
          await route.handler(req, res);
          return true;
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
    }

    for (const entry of handlers) {
      try {
        const handled = await entry.handler(req, res);
        if (handled) {
          return true;
        }
      } catch (err) {
        log.warn(`plugin http handler failed (${entry.pluginId}): ${String(err)}`);
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
