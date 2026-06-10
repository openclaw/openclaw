// Gateway HTTP handler for operator-authenticated MCP server catalog reload.
// POST /api/mcp/servers/:serverId/reload
//
// Disposes the transport session for a named MCP server within one or all
// active session runtimes and invalidates their tool catalog caches.  The next
// getCatalog() call on each affected runtime will reconnect and re-fetch the
// tool list from the upstream server.
//
// Useful when the upstream MCP server's tool list changes but the server does
// not emit notifications/tools/list_changed (e.g. after a new Composio
// integration is connected via an OAuth callback).
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getSessionMcpRuntimeManager } from "../agents/agent-bundle-mcp-runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-utils.js";

/** Regex for `/api/mcp/servers/:serverId/reload`. */
const MCP_RELOAD_PATH_RE = /^\/api\/mcp\/servers\/([^/]+)\/reload$/;

/** The gateway method used to derive the required operator scope. */
const REQUIRED_METHOD = "mcp.server.reload";

type McpReloadPathResolution =
  | { matched: false }
  | { matched: true; serverId: string }
  | { error: "invalid-server-id"; matched: true };

function resolveServerIdFromPath(pathname: string): McpReloadPathResolution {
  const match = pathname.match(MCP_RELOAD_PATH_RE);
  if (!match) {
    return { matched: false };
  }
  try {
    const decoded = decodeURIComponent(match[1] ?? "").trim();
    if (!decoded) {
      return { error: "invalid-server-id", matched: true };
    }
    return { matched: true, serverId: decoded };
  } catch {
    return { error: "invalid-server-id", matched: true };
  }
}

/**
 * Handle `POST /api/mcp/servers/:serverId/reload` requests.
 *
 * Returns `false` when the path does not match so the caller can try the next
 * stage (same contract as all other HTTP route handlers in the gateway).
 *
 * Query parameter `sessionId` (or header `X-OpenClaw-Session-Id`): when
 * provided, only the runtime for that session is reloaded.  When absent, the
 * reload is applied to every active session runtime on this gateway instance.
 *
 * Auth: `operator.write` scope — same bar as `tools.invoke` and consistent
 * with write-level control-plane operations.
 */
export async function handleMcpReloadHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { type: "bad_request", message: "Invalid request URL" } }));
    return true;
  }

  const serverIdResolution = resolveServerIdFromPath(url.pathname);
  if (!serverIdResolution.matched) {
    return false;
  }
  if ("error" in serverIdResolution) {
    sendInvalidRequest(res, "invalid or empty MCP server id in URL");
    return true;
  }
  const { serverId } = serverIdResolution;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  // /api/mcp/servers/:id/reload uses the same shared-secret HTTP trust model
  // as /tools/invoke: token/password bearer auth is full operator access, not
  // a narrower per-request scope boundary. Operators that need finer-grained
  // scope control can use trusted-proxy auth with explicit x-openclaw-scopes.
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    operatorMethod: REQUIRED_METHOD,
    resolveOperatorScopes: resolveSharedSecretHttpOperatorScopes,
  });
  if (!authResult) {
    // authorizeScopedGatewayHttpRequestOrReply already sent a 401 or 403 response.
    return true;
  }

  // Resolve optional session targeting: header takes precedence over query param.
  const sessionIdHeader = normalizeOptionalString(
    req.headers["x-openclaw-session-id"]?.toString(),
  );
  const sessionIdQuery = normalizeOptionalString(url.searchParams.get("sessionId") ?? "");
  const targetSessionId = sessionIdHeader ?? sessionIdQuery ?? null;

  const manager = getSessionMcpRuntimeManager();

  let reloadedCount = 0;
  const errors: string[] = [];

  const sessionIds = targetSessionId
    ? manager.listSessionIds().filter((id) => id === targetSessionId)
    : manager.listSessionIds();

  if (targetSessionId && sessionIds.length === 0) {
    sendJson(res, 404, {
      ok: false,
      error: {
        type: "not_found",
        message: `No active MCP runtime found for session "${targetSessionId}"`,
      },
    });
    return true;
  }

  for (const sessionId of sessionIds) {
    const runtime = manager.peekSession({ sessionId });
    if (!runtime) {
      continue;
    }
    if (typeof runtime.reloadServer !== "function") {
      // Runtime was created before this feature; skip gracefully.
      continue;
    }
    try {
      await runtime.reloadServer(serverId);
      reloadedCount += 1;
    } catch (err: unknown) {
      errors.push(
        `session "${sessionId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (errors.length > 0 && reloadedCount === 0) {
    sendJson(res, 500, {
      ok: false,
      error: {
        type: "reload_failed",
        message: `MCP server reload failed for all targeted sessions`,
        details: errors,
      },
    });
    return true;
  }

  sendJson(res, 200, {
    ok: true,
    serverName: serverId,
    sessionCount: reloadedCount,
    ...(errors.length > 0 ? { partialErrors: errors } : {}),
  });
  return true;
}
