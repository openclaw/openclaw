import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntimeConfig } from "../config/io.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { isLocalDirectRequest } from "./auth.js";
import { sendGatewayAuthFailure, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { authorizeGatewayHttpRequestOrReply } from "./http-utils.js";

export async function handleOcHeartbeatAgentsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    heartbeatRunner: HeartbeatRunner;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/oc/heartbeat/agents") {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const cfg = getRuntimeConfig();
  const trustedProxies = opts.trustedProxies ?? cfg.gateway?.trustedProxies;
  const allowRealIpFallback = opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback;
  const isLocal = isLocalDirectRequest(req, trustedProxies, allowRealIpFallback);
  if (!isLocal) {
    if (opts.auth.mode === "none") {
      sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
      return true;
    }
    const requestAuth = await authorizeGatewayHttpRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies,
      allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    });
    if (!requestAuth) {
      return true;
    }
  }

  const agents = opts.heartbeatRunner
    .getAgentSnapshots()
    .toSorted((a, b) => a.agentId.localeCompare(b.agentId))
    .map((agent) => ({
      agentId: agent.agentId,
      lastSeenAt:
        agent.lastRunStartedAtMs === undefined
          ? null
          : new Date(agent.lastRunStartedAtMs).toISOString(),
    }));
  sendJson(res, 200, { agents });
  return true;
}
