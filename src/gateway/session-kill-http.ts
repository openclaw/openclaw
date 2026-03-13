import type { IncomingMessage, ServerResponse } from "node:http";
import {
  killControlledSubagentRun,
  killSubagentRunAdmin,
  resolveSubagentController,
} from "../agents/subagent-control.js";
import { getSubagentRunByChildSessionKey } from "../agents/subagent-registry.js";
import { loadConfig } from "../config/config.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  isLocalDirectRequest,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { sendGatewayAuthFailure, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";
import { loadSessionEntry } from "./session-utils.js";

const REQUESTER_SESSION_KEY_HEADER = "x-openclaw-requester-session-key";

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

  const { entry, canonicalKey } = loadSessionEntry(sessionKey);
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

  const trustedProxies = opts.trustedProxies ?? cfg.gateway?.trustedProxies;
  const allowRealIpFallback = opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback;
  const requesterSessionKey = req.headers[REQUESTER_SESSION_KEY_HEADER]?.toString().trim();
  const allowLocalAdminKill = isLocalDirectRequest(req, trustedProxies, allowRealIpFallback);

  if (!requesterSessionKey && !allowLocalAdminKill) {
    sendJson(res, 403, {
      ok: false,
      error: {
        type: "forbidden",
        message: "Session kills require a local admin request or requester session ownership.",
      },
    });
    return true;
  }

  let killed = false;
  if (requesterSessionKey) {
    const runEntry = getSubagentRunByChildSessionKey(canonicalKey);
    if (runEntry) {
      const result = await killControlledSubagentRun({
        cfg,
        controller: resolveSubagentController({ cfg, agentSessionKey: requesterSessionKey }),
        entry: runEntry,
      });
      if (result.status === "forbidden") {
        sendJson(res, 403, {
          ok: false,
          error: {
            type: "forbidden",
            message: result.error,
          },
        });
        return true;
      }
      killed = result.status === "ok";
    }
  } else {
    const result = await killSubagentRunAdmin({
      cfg,
      sessionKey: canonicalKey,
    });
    killed = result.killed;
  }

  sendJson(res, 200, {
    ok: true,
    killed,
  });
  return true;
}
