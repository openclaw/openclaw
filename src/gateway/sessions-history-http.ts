import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  setSseHeaders,
} from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  getHeader,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS } from "./server-methods/chat.js";
import { buildSessionHistorySnapshot, SessionHistorySseState } from "./session-history-state.js";
import {
  readSessionMessages,
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
} from "./session-utils.js";

const MAX_SESSION_HISTORY_LIMIT = 1000;

function resolveSessionHistoryPath(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/history$/);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1] ?? "").trim() || null;
  } catch {
    return "";
  }
}

function shouldStreamSse(req: IncomingMessage): boolean {
  const accept = getHeader(req, "accept")?.toLowerCase() ?? "";
  return accept.includes("text/event-stream");
}

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

function resolveLimit(req: IncomingMessage): number | undefined {
  const raw = getRequestUrl(req).searchParams.get("limit");
  if (raw == null || raw.trim() === "") {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(MAX_SESSION_HISTORY_LIMIT, Math.max(1, value));
}

function resolveCursor(req: IncomingMessage): string | undefined {
  const raw = getRequestUrl(req).searchParams.get("cursor");
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function canonicalizePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function sseWrite(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function handleSessionHistoryHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const sessionKey = resolveSessionHistoryPath(req);
  if (sessionKey === null) {
    return false;
  }
  if (!sessionKey) {
    sendInvalidRequest(res, "invalid session key");
    return true;
  }
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const cfg = loadConfig();
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

  // HTTP callers must declare the same least-privilege operator scopes they
  // intend to use over WS so both transport surfaces enforce the same gate.
  const requestedScopes = resolveTrustedHttpOperatorScopes(req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod("chat.history", requestedScopes);
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

  const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey });
  const store = loadSessionStore(target.storePath);
  const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
  if (!entry?.sessionId) {
    sendJson(res, 404, {
      ok: false,
      error: {
        type: "not_found",
        message: `Session not found: ${sessionKey}`,
      },
    });
    return true;
  }
  const limit = resolveLimit(req);
  const cursor = resolveCursor(req);
  const effectiveMaxChars =
    typeof cfg.gateway?.webchat?.chatHistoryMaxChars === "number"
      ? cfg.gateway.webchat.chatHistoryMaxChars
      : DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
  // Read the transcript once and derive both sanitized and raw views from the
  // same snapshot, eliminating the theoretical race window where a concurrent
  // write between two separate reads could cause seq/content divergence.
  const rawSnapshot = entry?.sessionId
    ? readSessionMessages(entry.sessionId, target.storePath, entry.sessionFile)
    : [];
  const historySnapshot = buildSessionHistorySnapshot({
    rawMessages: rawSnapshot,
    maxChars: effectiveMaxChars,
    limit,
    cursor,
  });
  const history = historySnapshot.history;

  if (!shouldStreamSse(req)) {
    sendJson(res, 200, {
      sessionKey: target.canonicalKey,
      ...history,
    });
    return true;
  }

  const transcriptCandidates = entry?.sessionId
    ? new Set(
        resolveSessionTranscriptCandidates(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
        )
          .map((candidate) => canonicalizePath(candidate))
          .filter((candidate): candidate is string => typeof candidate === "string"),
      )
    : new Set<string>();

  let sentHistory = history;
  const sseState = SessionHistorySseState.fromRawSnapshot({
    target: {
      sessionId: entry.sessionId,
      storePath: target.storePath,
      sessionFile: entry.sessionFile,
    },
    rawMessages: rawSnapshot,
    maxChars: effectiveMaxChars,
    limit,
    cursor,
  });
  sentHistory = sseState.snapshot();
  setSseHeaders(res);
  res.write("retry: 1000\n\n");
  sseWrite(res, "history", {
    sessionKey: target.canonicalKey,
    ...sentHistory,
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": keepalive\n\n");
    }
  }, 15_000);

  const unsubscribe = onSessionTranscriptUpdate((update) => {
    if (res.writableEnded || !entry?.sessionId) {
      return;
    }
    const updatePath = canonicalizePath(update.sessionFile);
    if (!updatePath || !transcriptCandidates.has(updatePath)) {
      return;
    }
    if (update.message !== undefined) {
      if (limit === undefined && cursor === undefined) {
        const nextEvent = sseState.appendInlineMessage({
          message: update.message,
          messageId: update.messageId,
        });
        if (!nextEvent) {
          return;
        }
        sentHistory = sseState.snapshot();
        sseWrite(res, "message", {
          sessionKey: target.canonicalKey,
          message: nextEvent.message,
          ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
          messageSeq: nextEvent.messageSeq,
        });
        return;
      }
    }
    sentHistory = sseState.refresh();
    sseWrite(res, "history", {
      sessionKey: target.canonicalKey,
      ...sentHistory,
    });
  });

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("finish", cleanup);
  return true;
}
