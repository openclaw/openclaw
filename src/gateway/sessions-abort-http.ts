import type { IncomingMessage, ServerResponse } from "node:http";
import { killSubagentRunAdmin } from "../agents/subagent-control.js";
import {
  normalizeStoreSessionKey,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { diagnosticSessionStates, type SessionState } from "../logging/diagnostic-session-state.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { isLocalDirectRequest, type ResolvedGatewayAuth } from "./auth.js";
import { readJsonBodyOrError, sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod, CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { loadSessionEntry } from "./session-utils.js";

const MAX_ABORT_BODY_BYTES = 16 * 1024;
const DEFAULT_ABORT_REASON = "manual";

function resolveSessionKeyFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
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

function asAbortBody(value: unknown): { force: boolean; reason: string } {
  if (!value || typeof value !== "object") {
    return { force: false, reason: DEFAULT_ABORT_REASON };
  }
  const record = value as { force?: unknown; reason?: unknown };
  return {
    force: record.force === true,
    reason: normalizeOptionalString(record.reason) ?? DEFAULT_ABORT_REASON,
  };
}

function findDiagnosticSessionEntry(
  sessionKey: string,
  sessionId?: string,
): [string, SessionState] | null {
  const direct = diagnosticSessionStates.get(sessionKey);
  if (direct) {
    return [sessionKey, direct];
  }
  if (!sessionId) {
    return null;
  }
  for (const entry of diagnosticSessionStates.entries()) {
    if (entry[1].sessionId === sessionId) {
      return entry;
    }
  }
  return null;
}

function resolvePreviousStatus(entry: SessionEntry | undefined, state: SessionState | undefined) {
  return entry?.status ?? state?.state ?? "unknown";
}

async function markSessionAborted(params: {
  storePath: string;
  canonicalKey: string;
  endedAt: number;
  reason: string;
}): Promise<void> {
  await updateSessionStore(params.storePath, (store) => {
    const normalized = normalizeStoreSessionKey(params.canonicalKey);
    const storeKey =
      store[params.canonicalKey] !== undefined
        ? params.canonicalKey
        : Object.keys(store).find((key) => normalizeStoreSessionKey(key) === normalized);
    if (!storeKey) {
      return;
    }
    const entry = store[storeKey];
    if (!entry) {
      return;
    }
    store[storeKey] = {
      ...entry,
      status: "failed",
      endedAt: params.endedAt,
      updatedAt: Math.max(entry.updatedAt ?? 0, params.endedAt),
      abortedBy: "admin_cli",
      abortReason: params.reason,
    };
  });
}

export async function handleSessionAbortHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const sessionKey = resolveSessionKeyFromPath(url.pathname);
  if (!sessionKey) {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }

  const allowLocalAdminAbort = isLocalDirectRequest(
    req,
    opts.trustedProxies,
    opts.allowRealIpFallback,
  );
  const requestedScopes = allowLocalAdminAbort
    ? CLI_DEFAULT_OPERATOR_SCOPES
    : resolveTrustedHttpOperatorScopes(req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod("sessions.delete", requestedScopes);
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

  const body = await readJsonBodyOrError(req, res, MAX_ABORT_BODY_BYTES);
  if (body === undefined) {
    return true;
  }
  const abortBody = asAbortBody(body);

  const loaded = loadSessionEntry(sessionKey);
  const canonicalKey = loaded.canonicalKey ?? sessionKey;
  const inMemoryEntry = findDiagnosticSessionEntry(canonicalKey, loaded.entry?.sessionId);
  if (!loaded.entry && !inMemoryEntry) {
    sendJson(res, 404, {
      ok: false,
      error: {
        type: "not_found",
        message: `session not found: ${sessionKey}`,
      },
    });
    return true;
  }

  const previousStatus = resolvePreviousStatus(loaded.entry, inMemoryEntry?.[1]);
  const wasInMemory = Boolean(inMemoryEntry);
  if (inMemoryEntry) {
    diagnosticSessionStates.delete(inMemoryEntry[0]);
  }

  const endedAt = Date.now();
  if (loaded.entry && loaded.storePath) {
    await markSessionAborted({
      storePath: loaded.storePath,
      canonicalKey,
      endedAt,
      reason: abortBody.reason,
    });
  }

  let forceKilled = false;
  if (abortBody.force) {
    const result = await killSubagentRunAdmin({
      cfg: loaded.cfg,
      sessionKey: canonicalKey,
    });
    forceKilled = result.killed;
  }

  emitDiagnosticEvent({
    type: "session.aborted_by_admin",
    sessionKey: canonicalKey,
    sessionId: loaded.entry?.sessionId ?? inMemoryEntry?.[1].sessionId,
    previousStatus,
    wasInMemory,
    force: abortBody.force,
    forceKilled,
    reason: abortBody.reason,
  });

  sendJson(res, 200, {
    aborted: true,
    previousStatus,
    wasInMemory,
    ...(abortBody.force ? { forceKilled } : {}),
  });
  return true;
}
