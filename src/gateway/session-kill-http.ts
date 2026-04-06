import type { IncomingMessage, ServerResponse } from "node:http";
import {
  killControlledSubagentRun,
  killSubagentRunAdmin,
  resolveSubagentController,
} from "../agents/subagent-control.js";
import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry.js";
import { loadConfig } from "../config/config.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  isLocalDirectRequest,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { getBearerToken, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { loadSessionEntry } from "./session-utils.js";

const REQUESTER_SESSION_KEY_HEADER = "x-openclaw-requester-session-key";
const OPENCLAW_SCOPES_HEADER = "x-openclaw-scopes";

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

/**
 * Get scopes from HTTP request header.
 * For shared-secret auth (token/password), trust the scopes header since
 * the caller already proved possession of the gateway secret.
 */
function resolveHttpOperatorScopes(req: IncomingMessage): string[] {
  const scopesHeader = req.headers[OPENCLAW_SCOPES_HEADER];
  if (!scopesHeader) {
    return [];
  }
  const raw = Array.isArray(scopesHeader) ? scopesHeader[0] : scopesHeader;
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Handle HTTP POST /sessions/:sessionKey/kill requests with proper scope authorization.
 * 
 * Security fix for GHSA-9p93-7j67-5pc2: Gateway HTTP /sessions/:sessionKey/kill 
 * reaches admin kill path without caller scope binding.
 * 
 * This ensures:
 * 1. Local direct requests (loopback) can kill sessions if they have admin access
 * 2. Remote requests must provide requester session key header
 * 3. Scope authorization is enforced before any session lookup
 */
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

  // Authorize the request - validate gateway auth token/password
  const bearerToken = getBearerToken(req);
  const authResult = await authorizeHttpGatewayConnect({
    auth: opts.auth,
    token: bearerToken,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  
  if (!authResult.authorized) {
    sendJson(res, 401, {
      ok: false,
      error: {
        type: "unauthorized",
        message: "Invalid or missing gateway credentials",
      },
    });
    return true;
  }

  const trustedProxies = opts.trustedProxies ?? cfg.gateway?.trustedProxies;
  const allowRealIpFallback = opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback;
  
  // Get requester session key from header (for ownership-based kills)
  const requesterSessionKey = req.headers[REQUESTER_SESSION_KEY_HEADER]?.toString().trim();
  
  // Check if this is a local direct request (loopback)
  const allowLocalAdminKill = isLocalDirectRequest(req, trustedProxies, allowRealIpFallback);
  
  // Resolve the caller's scopes from the HTTP auth
  // For shared-secret auth, trust declared scopes from header
  const requestedScopes = resolveHttpOperatorScopes(req);

  // Require either local admin kill OR a requester session key
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

  // Determine required method and enforce scope authorization
  // - If requesterSessionKey provided: require sessions.abort (can abort own/child sessions)
  // - If local admin kill: require sessions.delete (full delete permissions)
  const requiredOperatorMethod =
    requesterSessionKey && !allowLocalAdminKill ? "sessions.abort" : "sessions.delete";
  
  const scopeAuth = authorizeOperatorScopesForMethod(requiredOperatorMethod, requestedScopes);
  if (!scopeAuth.allowed) {
    sendJson(res, 403, {
      ok: false,
      error: {
        type: "forbidden",
        message: `missing scope: ${scopeAuth.missingScope}`,
      },
    });
    return true;
  }

  // Now perform session lookup (after auth check to avoid info leakage)
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
  // If not local admin kill, use session ownership based kill
  if (!allowLocalAdminKill && requesterSessionKey) {
    const runEntry = getLatestSubagentRunByChildSessionKey(canonicalKey);
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
    // Admin kill path - used for local direct requests
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
