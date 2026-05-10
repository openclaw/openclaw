import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import type { PersistableSessionMessage } from "../../agents/transcript/session-transcript-types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { extractAssistantVisibleText } from "../../shared/chat-message-content.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAndPersistSessionTranscriptScope } from "./session-scope.js";
import { getSessionEntry, normalizeSessionRowKey } from "./store.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";
import {
  hasSqliteSessionTranscriptEvents,
  loadSqliteSessionTranscriptEvents,
} from "./transcript-store.sqlite.js";
import type { SessionEntry } from "./types.js";

export type SessionTranscriptAppendResult =
  | { ok: true; messageId: string }
  | { ok: false; reason: string };

export type SessionTranscriptUpdateMode = "inline" | "signal-only" | "none";

export type SessionTranscriptAssistantMessage = PersistableSessionMessage & {
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

function loadScopedSqliteTranscriptEvents(scope?: TranscriptQueryScope): unknown[] | undefined {
  if (!hasTranscriptQueryScope(scope)) {
    return undefined;
  }
  try {
    if (!hasSqliteSessionTranscriptEvents(scope)) {
      return undefined;
    }
    return loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
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

export async function resolveSessionTranscriptTarget(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  agentId: string;
  threadId?: string | number;
}): Promise<{ agentId: string; sessionId: string; sessionEntry: SessionEntry | undefined }> {
  let sessionEntry = params.sessionEntry;

  const resolvedTranscript = await resolveAndPersistSessionTranscriptScope({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry,
    agentId: params.agentId,
  });
  sessionEntry = resolvedTranscript.sessionEntry;

  return {
    agentId: resolvedTranscript.agentId,
    sessionId: resolvedTranscript.sessionId,
    sessionEntry,
  };
}

export async function readLatestAssistantTextFromSessionTranscript(
  scope: TranscriptQueryScope,
): Promise<LatestAssistantTranscriptText | undefined> {
  const scopedEvents = loadScopedSqliteTranscriptEvents(scope);
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
  scope: TranscriptQueryScope,
): Promise<TailAssistantTranscriptText | undefined> {
  const scopedEvents = loadScopedSqliteTranscriptEvents(scope);
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
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
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
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }
  if (params.message.role !== "assistant") {
    return { ok: false, reason: "message role must be assistant" };
  }

  const agentId = normalizeAgentId(
    params.agentId ?? resolveAgentIdFromSessionKey(sessionKey) ?? DEFAULT_AGENT_ID,
  );
  const normalizedKey = normalizeSessionRowKey(sessionKey);
  const entry = getSessionEntry({ agentId, sessionKey: normalizedKey });
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  try {
    await resolveAndPersistSessionTranscriptScope({
      sessionId: entry.sessionId,
      sessionKey: normalizedKey,
      sessionEntry: entry,
      agentId,
    });
  } catch (err) {
    return {
      ok: false,
      reason: formatErrorMessage(err),
    };
  }

  const explicitIdempotencyKey =
    params.idempotencyKey ??
    ((params.message as { idempotencyKey?: unknown }).idempotencyKey as string | undefined);
  const message = {
    ...params.message,
    ...(explicitIdempotencyKey ? { idempotencyKey: explicitIdempotencyKey } : {}),
  };
  const dedupeLatestAssistantText = isRedundantDeliveryMirror(params.message)
    ? extractAssistantMessageText(
        redactTranscriptMessage(
          message,
          params.config,
        ) as unknown as SessionTranscriptAssistantMessage,
      )
    : null;
  const { messageId, message: appendedMessage } = await appendSessionTranscriptMessage({
    agentId,
    ...(dedupeLatestAssistantText ? { dedupeLatestAssistantText } : {}),
    message,
    sessionId: entry.sessionId,
    config: params.config,
  });

  switch (params.updateMode ?? "inline") {
    case "inline":
      emitSessionTranscriptUpdate({
        agentId,
        sessionId: entry.sessionId,
        sessionKey,
        message: appendedMessage,
        messageId,
      });
      break;
    case "signal-only":
      emitSessionTranscriptUpdate({
        agentId,
        sessionId: entry.sessionId,
        sessionKey,
      });
      break;
    case "none":
      break;
  }
  return { ok: true, messageId };
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
