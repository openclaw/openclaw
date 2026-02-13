import type { IncomingMessage, ServerResponse } from "node:http";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "../auth.js";
import { sendUnauthorized } from "../http-common.js";
import { getBearerToken } from "../http-utils.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export type PluginHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

export function createGatewayPluginRequestHandler(params: {
  registry: PluginRegistry;
  log: SubsystemLogger;
  auth?: ResolvedGatewayAuth;
  trustedProxies?: string[];
}): PluginHttpRequestHandler {
  const { registry, log, auth, trustedProxies } = params;
  return async (req, res) => {
    const routes = registry.httpRoutes ?? [];
    const handlers = registry.httpHandlers ?? [];
    if (routes.length === 0 && handlers.length === 0) {
      return false;
    }

    let authOk: boolean | undefined;
    const authorize = async (respond: boolean): Promise<boolean> => {
      if (!auth) {
        return true;
      }
      if (authOk === true) {
        return true;
      }
      if (authOk === false) {
        if (respond) {
          sendUnauthorized(res);
        }
        return false;
      }
      const token = getBearerToken(req);
      const authResult = await authorizeGatewayConnect({
        auth,
        connectAuth: token ? { token, password: token } : null,
        req,
        trustedProxies,
      });
      authOk = authResult.ok;
      if (authResult.ok) {
        return true;
      }
      if (respond) {
        sendUnauthorized(res);
      }
      return false;
    };

    if (routes.length > 0) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = routes.find((entry) => entry.path === url.pathname);
      if (route) {
        if (route.requireAuth !== false && !(await authorize(true))) {
          return true;
        }
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
      if (entry.requireAuth !== false && !(await authorize(false))) {
        return false;
      }
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
