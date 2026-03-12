import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  sendGatewayAuthFailure,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  setSseHeaders,
} from "./http-common.js";
import { getBearerToken, getHeader } from "./http-utils.js";
import {
  readSessionMessages,
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
} from "./session-utils.js";

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

function resolveLimit(req: IncomingMessage): number | undefined {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const raw = url.searchParams.get("limit");
  if (raw == null || raw.trim() === "") {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.max(1, value);
}

function maybeLimitMessages(messages: unknown[], limit: number | undefined): unknown[] {
  if (limit === undefined || limit >= messages.length) {
    return messages;
  }
  return messages.slice(-limit);
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

  const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey });
  const store = loadSessionStore(target.storePath);
  const entry = target.storeKeys.map((key) => store[key]).find(Boolean);
  const limit = resolveLimit(req);
  const messages = entry?.sessionId
    ? maybeLimitMessages(
        readSessionMessages(entry.sessionId, target.storePath, entry.sessionFile),
        limit,
      )
    : [];

  if (!shouldStreamSse(req)) {
    sendJson(res, 200, {
      sessionKey: target.canonicalKey,
      messages,
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

  let sentMessages = messages;
  setSseHeaders(res);
  res.write("retry: 1000\n\n");
  sseWrite(res, "history", {
    sessionKey: target.canonicalKey,
    messages: sentMessages,
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
    const nextMessages = maybeLimitMessages(
      readSessionMessages(entry.sessionId, target.storePath, entry.sessionFile),
      limit,
    );
    if (nextMessages.length < sentMessages.length) {
      sentMessages = nextMessages;
      sseWrite(res, "history", {
        sessionKey: target.canonicalKey,
        messages: sentMessages,
      });
      return;
    }
    if (nextMessages.length === sentMessages.length) {
      return;
    }
    const appended = nextMessages.slice(sentMessages.length);
    sentMessages = nextMessages;
    for (const message of appended) {
      sseWrite(res, "message", {
        sessionKey: target.canonicalKey,
        message,
      });
    }
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
