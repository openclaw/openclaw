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
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  sanitizeChatHistoryMessages,
} from "./server-methods/chat.js";
import {
  attachOpenClawTranscriptMeta,
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

type PaginatedSessionHistory = {
  items: unknown[];
  messages: unknown[];
  nextCursor?: string;
  hasMore: boolean;
};

function resolveCursorSeq(cursor: string | undefined): number | undefined {
  if (!cursor) {
    return undefined;
  }
  const normalized = cursor.startsWith("seq:") ? cursor.slice(4) : cursor;
  const value = Number.parseInt(normalized, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveMessageSeq(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const meta = (message as { __openclaw?: unknown }).__openclaw;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const seq = (meta as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) && seq > 0 ? seq : undefined;
}

function paginateSessionMessages(
  messages: unknown[],
  limit: number | undefined,
  cursor: string | undefined,
): PaginatedSessionHistory {
  const cursorSeq = resolveCursorSeq(cursor);
  let endExclusive = messages.length;
  if (typeof cursorSeq === "number") {
    endExclusive = messages.findIndex((message, index) => {
      const seq = resolveMessageSeq(message);
      if (typeof seq === "number") {
        return seq >= cursorSeq;
      }
      return index + 1 >= cursorSeq;
    });
    if (endExclusive < 0) {
      endExclusive = messages.length;
    }
  }
  const start = typeof limit === "number" && limit > 0 ? Math.max(0, endExclusive - limit) : 0;
  const items = messages.slice(start, endExclusive);
  const firstSeq = resolveMessageSeq(items[0]);
  return {
    items,
    messages: items,
    hasMore: start > 0,
    ...(start > 0 && typeof firstSeq === "number" ? { nextCursor: String(firstSeq) } : {}),
  };
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
  const sanitizedMessages = sanitizeChatHistoryMessages(
    entry?.sessionId
      ? readSessionMessages(entry.sessionId, target.storePath, entry.sessionFile)
      : [],
    effectiveMaxChars,
  );
  const history = paginateSessionMessages(sanitizedMessages, limit, cursor);

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
  // Initialize rawTranscriptSeq from the raw transcript's last __openclaw.seq
  // value, not the sanitized history tail, so seq numbering stays correct even
  // when sanitization drops messages (e.g. silent replies).
  const rawMessages = entry?.sessionId
    ? readSessionMessages(entry.sessionId, target.storePath, entry.sessionFile)
    : [];
  let rawTranscriptSeq = resolveMessageSeq(rawMessages.at(-1)) ?? rawMessages.length;
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
      rawTranscriptSeq += 1;
      const nextMessage = attachOpenClawTranscriptMeta(update.message, {
        ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
        seq: rawTranscriptSeq,
      });
      if (limit === undefined && cursor === undefined) {
        const sanitized = sanitizeChatHistoryMessages([nextMessage], effectiveMaxChars);
        if (sanitized.length === 0) {
          return;
        }
        const sanitizedMsg = sanitized[0];
        sentHistory = {
          items: [...sentHistory.items, sanitizedMsg],
          messages: [...sentHistory.items, sanitizedMsg],
          hasMore: false,
        };
        sseWrite(res, "message", {
          sessionKey: target.canonicalKey,
          message: sanitizedMsg,
          ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
          messageSeq: resolveMessageSeq(sanitizedMsg),
        });
        return;
      }
    }
    // Transcript-only updates can advance the raw transcript without carrying
    // an inline message payload. Resync the raw seq counter before the next
    // fast-path append so later messageSeq values stay monotonic.
    const refreshedRawMessages = readSessionMessages(
      entry.sessionId,
      target.storePath,
      entry.sessionFile,
    );
    rawTranscriptSeq =
      resolveMessageSeq(refreshedRawMessages.at(-1)) ?? refreshedRawMessages.length;
    // Bounded SSE history refreshes: apply sanitizeChatHistoryMessages before
    // pagination, consistent with the unbounded path.
    sentHistory = paginateSessionMessages(
      sanitizeChatHistoryMessages(refreshedRawMessages, effectiveMaxChars),
      limit,
      cursor,
    );
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
