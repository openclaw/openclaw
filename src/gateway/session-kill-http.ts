// Gateway HTTP session kill handler.
// Stops subagent runs through the admin-scoped HTTP control surface.
import type { IncomingMessage, ServerResponse } from "node:http";
import { killSubagentRunAdmin } from "../agents/subagents/registry/subagent-control.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendMissingScopeForbidden,
} from "./http-common.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "./method-scopes.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { loadSessionEntry } from "./session-utils.js";

export async function handleSessionKillHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GatewayHttpRequestAuthOptions,
): Promise<boolean> {
  const cfg = opts.cfg ?? getRuntimeConfig();
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/kill$/);
  if (!match) {
    return false;
  }
  let sessionKey: string;
  try {
    sessionKey = decodeURIComponent(match[1] ?? "").trim();
  } catch {
    sendInvalidRequest(res, "invalid session key");
    return true;
  }
  if (!sessionKey) {
    sendInvalidRequest(res, "invalid session key");
    return true;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    ...opts,
    req,
    res,
    cfg,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
  });
  if (!requestAuth) {
    return true;
  }

  const requestedScopes = resolveTrustedHttpOperatorScopes(req, requestAuth);
  // Run kills stay admin-only: sessions.delete is dynamic (write may delete
  // archived sessions via RPC), but this endpoint terminates live runs.
  const scopeAuth = authorizeOperatorScopesForRequiredScope(ADMIN_SCOPE, requestedScopes);
  if (!scopeAuth.allowed) {
    sendMissingScopeForbidden(res, scopeAuth.missingScope);
    return true;
  }

  const requestedAgent = resolveRequestedSessionAgentId(
    cfg,
    sessionKey,
    url.searchParams.get("agentId") ?? undefined,
  );
  if (!requestedAgent.ok) {
    sendInvalidRequest(res, requestedAgent.error.message);
    return true;
  }
  const { entry, canonicalKey } = loadSessionEntry(sessionKey, {
    agentId: requestedAgent.agentId,
  });
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

  const result = await killSubagentRunAdmin(
    {
      cfg,
      sessionKey: canonicalKey,
      agentId: requestedAgent.agentId,
    },
    { assertCurrent: requestAuth.assertCurrent },
  );

  if (result.found && result.error) {
    sendJson(res, 503, {
      ok: false,
      error: { type: "unavailable", message: result.error },
    });
    return true;
  }

  sendJson(res, 200, {
    ok: true,
    killed: result.killed,
  });
  return true;
}
