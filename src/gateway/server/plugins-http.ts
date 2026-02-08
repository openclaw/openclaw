import type { IncomingMessage, ServerResponse } from "node:http";
import type { HitlApprovalDecision } from "../../infra/hitl/approval-manager.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { loadConfig } from "../../config/config.js";
import {
  addHitlAllowlistEntry,
  loadHitlAllowlist,
  matchesHitlAllowlist,
} from "../../infra/hitl/allowlist.js";
import { createHitlRequest } from "../../infra/hitl/client.js";
import { hitlApprovalManager } from "../../infra/hitl/state.js";
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
  auth: ResolvedGatewayAuth;
}): PluginHttpRequestHandler {
  const { registry, log, auth } = params;
  return async (req, res) => {
    const routes = registry.httpRoutes ?? [];
    const handlers = registry.httpHandlers ?? [];
    if (routes.length === 0 && handlers.length === 0) {
      return false;
    }

    if (routes.length > 0) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = routes.find((entry) => entry.path === url.pathname);
      if (route) {
        if (!route.public) {
          const cfg = loadConfig();
          const token = getBearerToken(req);
          const authResult = await authorizeGatewayConnect({
            auth,
            connectAuth: token ? { token, password: token } : null,
            req,
            trustedProxies: cfg.gateway?.trustedProxies,
          });
          if (!authResult.ok) {
            sendUnauthorized(res);
            return true;
          }
        }
        if (route.requireHitlApproval) {
          const cfg = loadConfig();
          const hitl = cfg.approvals?.hitl;
          const mode = hitl?.pluginHttp?.mode ?? "off";
          const enabled = hitl?.enabled === true && mode !== "off";
          if (enabled) {
            const method = (req.method ?? "GET").toUpperCase();
            const allowKey = [
              "plugin-http",
              method,
              `path=${route.path}`,
              `plugin=${route.pluginId ?? "unknown"}`,
            ].join(":");
            const persisted = loadHitlAllowlist();
            const allowPatterns = [
              ...(hitl?.pluginHttp?.allowlist ?? []),
              ...(persisted.entries.map((e) => e.pattern) ?? []),
            ];
            const allowlisted = matchesHitlAllowlist(allowPatterns, allowKey);
            const requiresApproval = !allowlisted && (mode === "always" || mode === "on-miss");
            if (requiresApproval) {
              const defaultDecision: HitlApprovalDecision = hitl?.defaultDecision ?? "deny";
              const timeoutSecondsRaw = hitl?.timeoutSeconds ?? 120;
              const timeoutSeconds = Math.min(86_400, Math.max(60, Math.floor(timeoutSecondsRaw)));
              const timeoutMs = timeoutSeconds * 1000;
              const callbackUrl =
                typeof hitl?.callbackUrl === "string" && hitl.callbackUrl.trim()
                  ? hitl.callbackUrl.trim()
                  : undefined;

              const requestText = [
                "Plugin HTTP route approval required.",
                "",
                `Plugin: ${route.pluginId ?? "unknown"}`,
                `Method: ${method}`,
                `Path: ${route.path}`,
              ].join("\n");

              const record = hitlApprovalManager.create({
                kind: "plugin-http",
                timeoutMs,
                defaultDecision,
                summary: { pluginId: route.pluginId ?? null, method, path: route.path },
                id: null,
              });
              const decisionPromise = hitlApprovalManager.waitForDecision(record, timeoutMs);

              const created = await createHitlRequest({
                apiKey: hitl?.apiKey ?? "",
                loopId: hitl?.loopId ?? "",
                request: {
                  processing_type: "time-sensitive",
                  type: "markdown",
                  priority: "high",
                  request_text: requestText,
                  timeout_seconds: timeoutSeconds,
                  response_type: "single_select",
                  response_config: {
                    options: [
                      { value: "allow-once", label: "Allow once" },
                      { value: "allow-always", label: "Allow always" },
                      { value: "deny", label: "Deny" },
                    ],
                    required: true,
                  },
                  default_response: defaultDecision,
                  ...(callbackUrl ? { callback_url: callbackUrl } : {}),
                  platform: "api",
                  context: {
                    kind: "plugin-http",
                    pluginId: route.pluginId ?? "unknown",
                    method,
                    path: route.path,
                    key: allowKey,
                  },
                },
              });
              if (!created.ok) {
                res.statusCode = 503;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end("Service Unavailable");
                return true;
              }
              hitlApprovalManager.attachHitlRequestId(record.id, created.requestId);

              const decision = (await decisionPromise) ?? defaultDecision;
              if (decision === "deny") {
                res.statusCode = 403;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end("Forbidden");
                return true;
              }
              if (decision === "allow-always") {
                const pattern = `plugin-http:${method}:path=${route.path}:plugin=${route.pluginId ?? "unknown"}:**`;
                addHitlAllowlistEntry(pattern);
              }
            }
          }
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
