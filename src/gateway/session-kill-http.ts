// Gateway HTTP session kill handler.
// Stops subagent runs through the admin-scoped HTTP control surface.
import type { IncomingMessage, ServerResponse } from "node:http";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { killSubagentRunAdmin } from "../agents/subagents/registry/subagent-control.js";
import { getRuntimeConfig } from "../config/io.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
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

  const capturedKey = normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
  let selected: Result<ReturnType<typeof captureIncognitoSessionSource>, unknown>;
  let assertSourceCurrent = () => {};
  try {
    const source = captureIncognitoSessionSource({ sessionKey: capturedKey });
    if (source && !("kind" in source)) {
      const claim = source.actor.sessions.captureCurrent(capturedKey);
      assertSourceCurrent = () => {
        source.admissionSignal?.throwIfAborted();
        source.actor.assertReadable();
        claim.assertCurrent();
      };
    }
    selected = ok(source);
  } catch (error) {
    selected = err(error);
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
  const kill = async (
    entry: SessionEntry | undefined,
    canonicalKey: string,
    assertCurrent: () => void,
  ) => {
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
      { assertCurrent },
    );

    assertCurrent();
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
  };
  if (!selected.ok) {
    throw selected.error;
  }
  const source = selected.value;
  if (source) {
    if ("kind" in source) {
      source.assertCurrent();
      return kill(undefined, sessionKey, requestAuth.assertCurrent);
    }
    const assertCurrent = () => {
      requestAuth.assertCurrent();
      assertSourceCurrent();
    };
    return source.actor.sessions.withSharedState(async () => {
      const { entry } = await source.actor.sessions.read(
        { assertCurrent },
        { sessionKey: capturedKey },
        source.admissionSignal,
      );
      assertCurrent();
      return kill(entry, capturedKey, assertCurrent);
    });
  }
  const { entry, canonicalKey } = loadSessionEntry(sessionKey, { agentId: requestedAgent.agentId });
  return kill(entry, canonicalKey, requestAuth.assertCurrent);
}
