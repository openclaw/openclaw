import type { IncomingMessage, ServerResponse } from "node:http";
import { killSubagentRunAdmin } from "../agents/subagent-control.js";
import { loadConfig } from "../config/config.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  sendGatewayAuthFailure,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import { getBearerToken } from "./http-utils.js";
import { loadSessionEntry } from "./session-utils.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";

function resolveSessionKeyFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/kill$/);
  if (!match) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(match[1] ?? "").trim();
    return decoded || null;
  } catch {
    return null;
  }
}

export async function handleSessionKillHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const cfg = loadConfig();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const sessionKey = resolveSessionKeyFromPath(url.pathname);
  if (!sessionKey) {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeHttpGatewayConnect({
    auth: opts.auth,
    connectAuth: token ? { token, password: token } : null,
    req,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(res, authResult);
    return true;
  }

  const { entry } = loadSessionEntry(sessionKey);
  if (!entry) {
    sendJson(res, 404, {
      ok: false,
      error: {
        type: "not_found",
        message: `Session not found: ${sessionKey}`,
      },
    });
    return true;
  }

  const result = await killSubagentRunAdmin({
    cfg,
    sessionKey,
  });

  sendJson(res, 200, {
    ok: true,
    killed: result.killed,
  });
  return true;
}
