import path from "node:path";
import type { SessionWriteLockAcquireTimeoutConfig } from "../../agents/session-write-lock.js";
import type { SessionManager } from "../../agents/transcript/session-transcript-contract.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { extractAssistantVisibleText } from "../../shared/chat-message-content.js";
import {
  resolveDefaultSessionStorePath,
  resolveAgentIdFromSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
} from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore, normalizeStoreSessionKey } from "./store.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";
import {
  hasSqliteSessionTranscriptEvents,
  loadSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScopeForPath,
} from "./transcript-store.sqlite.js";
import type { SessionEntry } from "./types.js";

export type SessionTranscriptAppendResult =
  | { ok: true; sessionFile: string; messageId: string }
  | { ok: false; reason: string };

export type SessionTranscriptUpdateMode = "inline" | "file-only" | "none";

export type SessionTranscriptAssistantMessage = Parameters<SessionManager["appendMessage"]>[0] & {
  role: "assistant";
};

type AssistantTranscriptText = {
  id?: string;
  text: string;
  timestamp?: number;
};

export type LatestAssistantTranscriptText = AssistantTranscriptText;
export type TailAssistantTranscriptText = AssistantTranscriptText;

type TranscriptQueryScope = {
  agentId?: string;
  sessionId?: string;
};

function hasTranscriptQueryScope(scope?: TranscriptQueryScope): scope is {
  agentId: string;
  sessionId: string;
} {
  return Boolean(scope?.agentId?.trim() && scope.sessionId?.trim());
}

function loadScopedSqliteTranscriptEvents(
  scope?: TranscriptQueryScope,
  transcriptPath?: string,
): unknown[] | undefined {
  const resolvedScope = hasTranscriptQueryScope(scope)
    ? scope
    : transcriptPath?.trim()
      ? resolveSqliteSessionTranscriptScopeForPath({ transcriptPath })
      : undefined;
  if (!resolvedScope) {
    return undefined;
  }
  try {
    if (!hasSqliteSessionTranscriptEvents(resolvedScope)) {
      return undefined;
    }
    return loadSqliteSessionTranscriptEvents(resolvedScope).map((entry) => entry.event);
  } catch {
    return undefined;
  }
}

function parseAssistantTranscriptEventText(event: unknown): AssistantTranscriptText | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const parsed = event as {
    id?: unknown;
    message?: unknown;
  };
  const message = parsed.message as { role?: unknown; timestamp?: unknown } | undefined;
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  const text = extractAssistantVisibleText(message)?.trim();
  if (!text) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id ? { id: parsed.id } : {}),
    text,
    ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { timestamp: message.timestamp }
      : {}),
  };
}

export async function resolveSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry | undefined }> {
  const sessionPathOpts = resolveSessionFilePathOptions({
    agentId: params.agentId,
    storePath: params.storePath,
  });
  let sessionFile = resolveSessionFilePath(params.sessionId, params.sessionEntry, sessionPathOpts);
  let sessionEntry = params.sessionEntry;

  if (params.sessionStore && params.storePath) {
    const threadIdFromSessionKey = parseSessionThreadInfo(params.sessionKey).threadId;
    const fallbackSessionFile = !sessionEntry?.sessionFile
      ? resolveSessionTranscriptPath(
          params.sessionId,
          params.agentId,
          params.threadId ?? threadIdFromSessionKey,
        )
      : undefined;
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      sessionEntry,
      agentId: sessionPathOpts?.agentId,
      sessionsDir: sessionPathOpts?.sessionsDir,
      fallbackSessionFile,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }

  return {
    sessionFile,
    sessionEntry,
  };
}

export async function readLatestAssistantTextFromSessionTranscript(
  sessionFile: string | undefined,
  scope?: TranscriptQueryScope,
): Promise<LatestAssistantTranscriptText | undefined> {
  const scopedEvents = loadScopedSqliteTranscriptEvents(scope, sessionFile);
  if (scopedEvents) {
    for (const event of scopedEvents.toReversed()) {
      const assistantText = parseAssistantTranscriptEventText(event);
      if (assistantText) {
        return assistantText;
      }
    }
    return undefined;
  }

  return undefined;
}

export async function readTailAssistantTextFromSessionTranscript(
  sessionFile: string | undefined,
  scope?: TranscriptQueryScope,
): Promise<TailAssistantTranscriptText | undefined> {
  const scopedEvents = loadScopedSqliteTranscriptEvents(scope, sessionFile);
  if (scopedEvents) {
    const tail = scopedEvents.at(-1);
    return tail === undefined ? undefined : parseAssistantTranscriptEventText(tail);
  }

  return undefined;
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) {
    return { ok: false, reason: "empty text" };
  }

  return appendExactAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey,
    storePath: params.storePath,
    idempotencyKey: params.idempotencyKey,
    updateMode: params.updateMode,
    config: params.config,
    message: {
      role: "assistant" as const,
      content: [{ type: "text", text: mirrorText }],
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    },
  });
}

export async function appendExactAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  message: SessionTranscriptAssistantMessage;
  idempotencyKey?: string;
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }
  if (params.message.role !== "assistant") {
    return { ok: false, reason: "message role must be assistant" };
  }

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const agentId = normalizeAgentId(
    params.agentId ?? resolveAgentIdFromSessionStorePath(storePath) ?? DEFAULT_AGENT_ID,
  );
  const store = loadSessionStore(storePath);
  const normalizedKey = normalizeStoreSessionKey(sessionKey);
  const entry = (store[normalizedKey] ?? store[sessionKey]) as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  let sessionFile: string;
  try {
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: entry.sessionId,
      sessionKey,
      sessionStore: store,
      storePath,
      sessionEntry: entry,
      agentId,
      sessionsDir: path.dirname(storePath),
    });
    sessionFile = resolvedSessionFile.sessionFile;
  } catch (err) {
    return {
      ok: false,
      reason: formatErrorMessage(err),
    };
  }

  const explicitIdempotencyKey =
    params.idempotencyKey ??
    ((params.message as { idempotencyKey?: unknown }).idempotencyKey as string | undefined);
  const transcriptScope = {
    agentId,
    sessionId: entry.sessionId,
  };
  const existingMessageId = explicitIdempotencyKey
    ? await transcriptHasIdempotencyKey(sessionFile, explicitIdempotencyKey, transcriptScope)
    : undefined;
  if (existingMessageId) {
    return {
      ok: true,
      sessionFile,
      messageId: existingMessageId === true ? (explicitIdempotencyKey ?? "") : existingMessageId,
    };
  }

  const latestEquivalentAssistantId = isRedundantDeliveryMirror(params.message)
    ? await findLatestEquivalentAssistantMessageId(sessionFile, params.message, transcriptScope)
    : undefined;
  if (latestEquivalentAssistantId) {
    return { ok: true, sessionFile, messageId: latestEquivalentAssistantId };
  }

  const message = {
    ...params.message,
    ...(explicitIdempotencyKey ? { idempotencyKey: explicitIdempotencyKey } : {}),
  };
  const { messageId } = await appendSessionTranscriptMessage({
    transcriptPath: sessionFile,
    agentId,
    message,
    sessionId: entry.sessionId,
    config: params.config,
  });

  switch (params.updateMode ?? "inline") {
    case "inline":
      emitSessionTranscriptUpdate({ sessionFile, sessionKey, message, messageId });
      break;
    case "file-only":
      emitSessionTranscriptUpdate({ sessionFile, sessionKey });
      break;
    case "none":
      break;
  }
  return { ok: true, sessionFile, messageId };
}

async function transcriptHasIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
  scope?: TranscriptQueryScope,
): Promise<string | true | undefined> {
  const scopedEvents = loadScopedSqliteTranscriptEvents(scope, transcriptPath);
  if (scopedEvents) {
    return findIdempotencyKeyInTranscriptEvents(scopedEvents, idempotencyKey);
  }
  return undefined;
}

function findIdempotencyKeyInTranscriptEvents(
  events: unknown[],
  idempotencyKey: string,
): string | true | undefined {
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const parsed = event as {
      id?: unknown;
      message?: { idempotencyKey?: unknown };
    };
    if (
      parsed.message?.idempotencyKey === idempotencyKey &&
      typeof parsed.id === "string" &&
      parsed.id
    ) {
      return parsed.id;
    }
    if (parsed.message?.idempotencyKey === idempotencyKey) {
      return true;
    }
  }
  return undefined;
}

function isRedundantDeliveryMirror(message: SessionTranscriptAssistantMessage): boolean {
  return message.provider === "openclaw" && message.model === "delivery-mirror";
}

function extractAssistantMessageText(message: SessionTranscriptAssistantMessage): string | null {
  if (!Array.isArray(message.content)) {
    return null;
  }

  const parts = message.content
    .filter(
      (
        part,
      ): part is {
        type: "text";
        text: string;
      } => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
    )
    .map((part) => part.text.trim());

  return parts.length > 0 ? parts.join("\n").trim() : null;
}

async function findLatestEquivalentAssistantMessageId(
  transcriptPath: string,
  message: SessionTranscriptAssistantMessage,
  scope?: TranscriptQueryScope,
): Promise<string | undefined> {
  const expectedText = extractAssistantMessageText(message);
  if (!expectedText) {
    return undefined;
  }

  const scopedEvents = loadScopedSqliteTranscriptEvents(scope, transcriptPath);
  if (scopedEvents) {
    return findLatestEquivalentAssistantMessageIdInEvents(scopedEvents, expectedText);
  }

  return undefined;
}

function findLatestEquivalentAssistantMessageIdInEvents(
  events: unknown[],
  expectedText: string,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const parsed = event as {
      id?: unknown;
      message?: SessionTranscriptAssistantMessage;
    };
    const candidate = parsed.message;
    if (!candidate || candidate.role !== "assistant") {
      continue;
    }
    const candidateText = extractAssistantMessageText(candidate);
    if (candidateText !== expectedText) {
      return undefined;
    }
    if (typeof parsed.id === "string" && parsed.id) {
      return parsed.id;
    }
    return undefined;
  }
  return undefined;
}
