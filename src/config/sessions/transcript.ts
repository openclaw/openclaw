// Session transcript facade resolves transcript files, appends mirror messages, and reads tails.
import path from "node:path";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  extractAssistantVisibleText,
  extractFirstTextBlock,
} from "../../shared/chat-message-content.js";
import { isTranscriptOnlyOpenClawAssistantModel } from "../../shared/transcript-only-openclaw-assistant.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveDefaultSessionStorePath, resolveSessionFilePath } from "./paths.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore, resolveSessionStoreEntry } from "./store.js";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";
import { streamSessionTranscriptLinesReverse } from "./transcript-stream.js";

export type SessionTranscriptAppendResult =
  | { ok: true; sessionFile: string; messageId: string }
  | {
      ok: false;
      reason: string;
      code?: "blocked" | "session-rebound";
    };

export type SessionTranscriptUpdateMode = "inline" | "file-only" | "none";
export type SessionTranscriptDeliveryMirror = {
  kind: "channel-final";
  sourceMessageId?: string;
};

export type SessionTranscriptAssistantMessage = Parameters<SessionManager["appendMessage"]>[0] & {
  role: "assistant";
};

type AssistantBeforeMessageWrite = (params: {
  message: AgentMessage;
  agentId?: string;
  sessionKey?: string;
}) => AgentMessage | null;

function applyBeforeMessageWriteToAssistant(params: {
  message: Parameters<SessionManager["appendMessage"]>[0];
  beforeMessageWrite?: AssistantBeforeMessageWrite;
  explicitIdempotencyKey?: string;
  agentId?: string;
  sessionKey: string;
}): Parameters<SessionManager["appendMessage"]>[0] | undefined {
  if (!params.beforeMessageWrite) {
    return params.message;
  }
  const nextMessage = params.beforeMessageWrite({
    message: params.message as AgentMessage,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.sessionKey,
  });
  if (nextMessage?.role !== "assistant") {
    return undefined;
  }
  return {
    ...nextMessage,
    ...(params.explicitIdempotencyKey ? { idempotencyKey: params.explicitIdempotencyKey } : {}),
  } as Parameters<SessionManager["appendMessage"]>[0];
}

type AssistantTranscriptText = {
  id?: string;
  text: string;
  timestamp?: number;
};

export type SessionRecentConversationText = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  sourceChannel?: string;
};

export type ReadRecentSessionConversationTextOptions = {
  beforeTimestampMs?: number;
  limit?: number;
  minTimestampMs?: number;
};

export type ReadRecentSessionConversationTextParams = ReadRecentSessionConversationTextOptions & {
  agentId?: string;
  sessionKey: string;
  storePath?: string;
};

export type LatestAssistantTranscriptText = AssistantTranscriptText;
export type TailAssistantTranscriptText = AssistantTranscriptText;

export { resolveSessionTranscriptFile } from "./transcript-file-resolve.js";

function parseAssistantTranscriptText(
  line: string,
  options?: { excludeTranscriptOnlyOpenClawAssistant?: boolean },
): AssistantTranscriptText | undefined {
  const parsed = JSON.parse(line) as {
    id?: unknown;
    message?: unknown;
  };
  const message = parsed.message as
    | { role?: unknown; timestamp?: unknown; provider?: unknown; model?: unknown }
    | undefined;
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  if (
    options?.excludeTranscriptOnlyOpenClawAssistant &&
    isTranscriptOnlyOpenClawAssistantMessage(message)
  ) {
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

function isTranscriptOnlyOpenClawAssistantMessage(message: {
  provider?: unknown;
  model?: unknown;
}): boolean {
  return isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model);
}

function normalizeTranscriptTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isBeforeTranscriptTimestamp(
  timestamp: number | undefined,
  beforeTimestampMs: number | undefined,
): boolean {
  return (
    beforeTimestampMs === undefined || timestamp === undefined || timestamp < beforeTimestampMs
  );
}

function isAtOrAfterTranscriptTimestamp(
  timestamp: number | undefined,
  minTimestampMs: number | undefined,
): boolean {
  return minTimestampMs === undefined || timestamp === undefined || timestamp >= minTimestampMs;
}

function normalizeRecentTranscriptLimit(limit: number | undefined): number {
  return Math.max(1, Math.floor(limit ?? 10));
}

function parseRecentConversationText(line: string): SessionRecentConversationText | undefined {
  const parsed = JSON.parse(line) as {
    id?: unknown;
    message?: unknown;
  };
  const message = parsed.message as
    | {
        role?: unknown;
        timestamp?: unknown;
        provenance?: unknown;
        provider?: unknown;
        model?: unknown;
      }
    | undefined;
  if (!message || (message.role !== "user" && message.role !== "assistant")) {
    return undefined;
  }
  if (message.role === "assistant" && isTranscriptOnlyOpenClawAssistantMessage(message)) {
    return undefined;
  }
  const text =
    message.role === "assistant"
      ? extractAssistantVisibleText(message)
      : extractFirstTextBlock(message)?.trim();
  if (!text) {
    return undefined;
  }
  const provenance =
    message.provenance && typeof message.provenance === "object"
      ? (message.provenance as { sourceChannel?: unknown })
      : undefined;
  return {
    ...(typeof parsed.id === "string" && parsed.id ? { id: parsed.id } : {}),
    role: message.role,
    text,
    ...(normalizeTranscriptTimestamp(message.timestamp) !== undefined
      ? { timestamp: normalizeTranscriptTimestamp(message.timestamp) }
      : {}),
    ...(typeof provenance?.sourceChannel === "string" && provenance.sourceChannel.trim()
      ? { sourceChannel: provenance.sourceChannel.trim() }
      : {}),
  };
}

function resolveSessionConversationTranscriptPath(params: {
  agentId?: string;
  sessionKey: string;
  storePath?: string;
}): string | undefined {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  const entry = resolved.existing;
  if (!entry?.sessionId) {
    return undefined;
  }
  return resolveSessionFilePath(entry.sessionId, entry, {
    sessionsDir: path.dirname(storePath),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
}

export async function readRecentUserAssistantTextFromSessionTranscript(
  sessionFile: string | undefined,
  options: ReadRecentSessionConversationTextOptions = {},
): Promise<SessionRecentConversationText[]> {
  if (!sessionFile?.trim()) {
    return [];
  }
  const limit = normalizeRecentTranscriptLimit(options.limit);
  const recent: SessionRecentConversationText[] = [];
  for await (const line of streamSessionTranscriptLinesReverse(sessionFile)) {
    try {
      const entry = parseRecentConversationText(line);
      if (!entry) {
        continue;
      }
      if (!isBeforeTranscriptTimestamp(entry.timestamp, options.beforeTimestampMs)) {
        continue;
      }
      if (!isAtOrAfterTranscriptTimestamp(entry.timestamp, options.minTimestampMs)) {
        continue;
      }
      recent.push(entry);
      if (recent.length >= limit) {
        break;
      }
    } catch {
      continue;
    }
  }
  return recent.toReversed();
}

export async function readRecentUserAssistantTextForSession(
  params: ReadRecentSessionConversationTextParams,
): Promise<SessionRecentConversationText[]> {
  const sessionFile = resolveSessionConversationTranscriptPath(params);
  return await readRecentUserAssistantTextFromSessionTranscript(sessionFile, params);
}

export async function readLatestAssistantTextFromSessionTranscript(
  sessionFile: string | undefined,
): Promise<LatestAssistantTranscriptText | undefined> {
  if (!sessionFile?.trim()) {
    return undefined;
  }

  for await (const line of streamSessionTranscriptLinesReverse(sessionFile)) {
    try {
      const assistantText = parseAssistantTranscriptText(line, {
        excludeTranscriptOnlyOpenClawAssistant: true,
      });
      if (assistantText) {
        return assistantText;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function readTailAssistantTextFromSessionTranscript(
  sessionFile: string | undefined,
): Promise<TailAssistantTranscriptText | undefined> {
  if (!sessionFile?.trim()) {
    return undefined;
  }

  for await (const line of streamSessionTranscriptLinesReverse(sessionFile)) {
    try {
      const parsed = JSON.parse(line) as { message?: unknown };
      // Skip non-message entries (e.g. `openclaw.cache-ttl` custom events) so
      // a metadata line emitted after the canonical assistant turn doesn't
      // make the tail reader fall through to "no assistant tail" and cause
      // persistTextTurnTranscript to append a duplicate. Stop at any real
      // message entry — a user turn means a new turn has started and a
      // matching reply is a legitimate repeat, not a gap-fill duplicate.
      if (!parsed.message || typeof parsed.message !== "object") {
        continue;
      }
      return parseAssistantTranscriptText(line);
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  expectedSessionId?: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
  beforeMessageWrite?: AssistantBeforeMessageWrite;
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
    ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
    storePath: params.storePath,
    idempotencyKey: params.idempotencyKey,
    updateMode: params.updateMode,
    config: params.config,
    ...(params.beforeMessageWrite ? { beforeMessageWrite: params.beforeMessageWrite } : {}),
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
      ...(params.deliveryMirror ? { openclawDeliveryMirror: params.deliveryMirror } : {}),
    } as SessionTranscriptAssistantMessage,
  });
}

export async function appendExactAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  expectedSessionId?: string;
  message: SessionTranscriptAssistantMessage;
  idempotencyKey?: string;
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
  beforeMessageWrite?: AssistantBeforeMessageWrite;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }
  if (params.message.role !== "assistant") {
    return { ok: false, reason: "message role must be assistant" };
  }

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  const entry = resolved.existing;
  if (params.expectedSessionId && entry?.sessionId !== params.expectedSessionId) {
    return {
      ok: false,
      code: "session-rebound",
      reason: `session rebound for sessionKey: ${sessionKey}`,
    };
  }
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  const appendToSessionFile = async (
    currentEntry: NonNullable<typeof entry>,
    sessionFile?: string,
  ): Promise<SessionTranscriptAppendResult> => {
    const explicitIdempotencyKey =
      params.idempotencyKey ??
      ((params.message as { idempotencyKey?: unknown }).idempotencyKey as string | undefined);
    const message = {
      ...params.message,
      ...(explicitIdempotencyKey ? { idempotencyKey: explicitIdempotencyKey } : {}),
    } as Parameters<SessionManager["appendMessage"]>[0];
    const preparedUnkeyedMessage =
      !explicitIdempotencyKey && params.beforeMessageWrite
        ? applyBeforeMessageWriteToAssistant({
            message,
            beforeMessageWrite: params.beforeMessageWrite,
            agentId: params.agentId,
            sessionKey: resolved.normalizedKey,
          })
        : message;
    if (!preparedUnkeyedMessage) {
      return {
        ok: false,
        code: "blocked",
        reason: "blocked by before_message_write",
      };
    }
    const identifiedChannelFinal =
      Boolean(explicitIdempotencyKey) && isChannelFinalDeliveryMirror(params.message);
    let latestEquivalentAssistantId: string | undefined;
    // Unidentified delivery mirrors dedupe by latest text. Identified channel finals use their
    // idempotency key so repeated replies on separate user turns remain distinct.
    const turn = await persistSessionTranscriptTurn(
      {
        sessionId: currentEntry.sessionId,
        sessionKey: resolved.normalizedKey,
        storePath,
        ...(sessionFile ? { sessionFile } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
      },
      {
        cwd: currentEntry.spawnedCwd,
        ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
        ...(params.config ? { config: params.config } : {}),
        updateMode: params.updateMode ?? "inline",
        touchSessionEntry: true,
        messages: [
          {
            message: preparedUnkeyedMessage,
            ...(explicitIdempotencyKey ? { idempotencyLookup: "scan" } : {}),
            ...(explicitIdempotencyKey && params.beforeMessageWrite
              ? {
                  prepareMessageAfterIdempotencyCheck: (candidate: unknown) =>
                    applyBeforeMessageWriteToAssistant({
                      message: candidate as Parameters<SessionManager["appendMessage"]>[0],
                      beforeMessageWrite: params.beforeMessageWrite,
                      explicitIdempotencyKey,
                      agentId: params.agentId,
                      sessionKey: resolved.normalizedKey,
                    }),
                }
              : {}),
            shouldAppend: async (target) => {
              latestEquivalentAssistantId =
                isRedundantDeliveryMirror(params.message) && !identifiedChannelFinal
                  ? await findLatestEquivalentAssistantMessageId(
                      target.sessionFile,
                      preparedUnkeyedMessage as SessionTranscriptAssistantMessage,
                      params.config,
                    )
                  : undefined;
              return !latestEquivalentAssistantId;
            },
          },
        ],
      },
    );
    if (turn.rejectedReason === "session-rebound") {
      return {
        ok: false,
        code: "session-rebound",
        reason: `session rebound for sessionKey: ${sessionKey}`,
      };
    }
    if (latestEquivalentAssistantId) {
      return { ok: true, sessionFile: turn.sessionFile, messageId: latestEquivalentAssistantId };
    }
    const appendedResult = turn.messages[0];
    if (!appendedResult) {
      return {
        ok: false,
        code: "blocked",
        reason: "blocked by before_message_write",
      };
    }
    const { messageId } = appendedResult;
    return { ok: true, sessionFile: turn.sessionFile, messageId };
  };

  let result: SessionTranscriptAppendResult;
  if (params.expectedSessionId) {
    result = await appendToSessionFile(entry);
  } else {
    let sessionFile: string;
    try {
      const resolvedSessionFile = await resolveAndPersistSessionFile({
        sessionId: entry.sessionId,
        sessionKey: resolved.normalizedKey,
        sessionStore: store,
        storePath,
        sessionEntry: entry,
        agentId: params.agentId,
        sessionsDir: path.dirname(storePath),
      });
      sessionFile = resolvedSessionFile.sessionFile;
    } catch (err) {
      return {
        ok: false,
        reason: formatErrorMessage(err),
      };
    }
    result = await appendToSessionFile(entry, sessionFile);
  }
  return result;
}

function isRedundantDeliveryMirror(message: SessionTranscriptAssistantMessage): boolean {
  return message.provider === "openclaw" && message.model === "delivery-mirror";
}

function isChannelFinalDeliveryMirror(message: SessionTranscriptAssistantMessage): boolean {
  const marker = (message as { openclawDeliveryMirror?: SessionTranscriptDeliveryMirror })
    .openclawDeliveryMirror;
  return isRedundantDeliveryMirror(message) && marker?.kind === "channel-final";
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
  config?: OpenClawConfig,
): Promise<string | undefined> {
  const expectedText = extractAssistantMessageText(
    redactTranscriptMessage(message, config) as unknown as SessionTranscriptAssistantMessage,
  );
  if (!expectedText) {
    return undefined;
  }

  for await (const line of streamSessionTranscriptLinesReverse(transcriptPath)) {
    try {
      const parsed = JSON.parse(line) as {
        id?: unknown;
        message?: SessionTranscriptAssistantMessage;
      };
      const candidate = parsed.message;
      if (!candidate || candidate.role !== "assistant") {
        continue;
      }
      // Stop at the first assistant message: only the tail can be a duplicate mirror replay.
      const candidateText = extractAssistantMessageText(
        redactTranscriptMessage(
          candidate as AgentMessage,
          config,
        ) as unknown as SessionTranscriptAssistantMessage,
      );
      if (candidateText !== expectedText) {
        return undefined;
      }
      if (typeof parsed.id === "string" && parsed.id) {
        return parsed.id;
      }
      return undefined;
    } catch {
      continue;
    }
  }

  return undefined;
}
