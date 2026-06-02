import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  killControlledSubagentRun,
  killSubagentRunAdmin,
  resolveSubagentController,
} from "../agents/subagent-control.js";
import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry.js";
import { getRuntimeConfig } from "../config/io.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { isLocalDirectRequest, type ResolvedGatewayAuth } from "./auth.js";
import {
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendMissingScopeForbidden,
} from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { loadSessionEntry } from "./session-utils.js";

const REQUESTER_SESSION_KEY_HEADER = "x-openclaw-requester-session-key";

type SessionKeyPathResolution =
  | {
      /** Request path is not owned by the session kill endpoint. */
      matched: false;
    }
  | {
      /** Request path matched and yielded a decoded session key. */
      matched: true;
      /** Decoded target session key from `/sessions/{sessionKey}/kill`. */
      sessionKey: string;
    }
  | {
      /** Request path matched but the session key segment was missing or malformed. */
      error: "invalid-session-key";
      matched: true;
    };

function resolveSessionKeyFromPath(pathname: string): SessionKeyPathResolution {
  const match = pathname.match(/^\/sessions\/([^/]+)\/kill$/);
  if (!match) {
    return { matched: false };
  }
  try {
    const decoded = decodeURIComponent(match[1] ?? "").trim();
    if (!decoded) {
      return { error: "invalid-session-key", matched: true };
    }
    return { matched: true, sessionKey: decoded };
  } catch {
    return { error: "invalid-session-key", matched: true };
  }
}

/** Handles authenticated `/sessions/{sessionKey}/kill` HTTP requests. */
export async function handleSessionKillHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    /** Gateway auth policy used before any session or run lookup occurs. */
    auth: ResolvedGatewayAuth;
    /** Trusted proxy CIDRs for classifying local/direct admin requests. */
    trustedProxies?: string[];
    /** Whether proxy headers may fall back to the socket remote address. */
    allowRealIpFallback?: boolean;
    /** Optional auth limiter shared with the surrounding Gateway HTTP server. */
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const cfg = getRuntimeConfig();
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionKeyResolution = resolveSessionKeyFromPath(url.pathname);
  if (!sessionKeyResolution.matched) {
    return false;
  }
  if ("error" in sessionKeyResolution) {
    sendInvalidRequest(res, "invalid session key");
    return true;
  }
  const { sessionKey } = sessionKeyResolution;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }

  const trustedProxies = opts.trustedProxies ?? cfg.gateway?.trustedProxies;
  const allowRealIpFallback = opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback;
  const requesterSessionKey = normalizeOptionalString(
    req.headers[REQUESTER_SESSION_KEY_HEADER]?.toString(),
  );
  const allowLocalAdminKill = isLocalDirectRequest(req, trustedProxies, allowRealIpFallback);
  const requestedScopes = resolveTrustedHttpOperatorScopes(req, requestAuth);

  if (!requesterSessionKey && !allowLocalAdminKill) {
    // Remote kills need an owning requester session; without one they would be
    // indistinguishable from arbitrary cross-session abort requests.
    sendJson(res, 403, {
      ok: false,
      error: {
        type: "forbidden",
        message: "Session kills require a local admin request or requester session ownership.",
      },
    });
    return true;
  }

  const requiredOperatorMethod =
    requesterSessionKey && !allowLocalAdminKill ? "sessions.abort" : "sessions.delete";
  const scopeAuth = authorizeOperatorScopesForMethod(requiredOperatorMethod, requestedScopes);
  if (!scopeAuth.allowed) {
    sendMissingScopeForbidden(res, scopeAuth.missingScope);
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

  let killed = false;
  if (!allowLocalAdminKill && requesterSessionKey) {
    const runEntry = getLatestSubagentRunByChildSessionKey(canonicalKey);
    if (runEntry) {
      // Requester-scoped kills go through subagent control so parent/child
      // ownership is enforced before the run receives a stop signal.
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
