import { redactTranscriptMessage } from "../agents/transcript-redact.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  publishTranscriptUpdate,
  readLatestTranscriptAssistantText,
  resolveSessionTranscriptRuntimeReadTarget,
  resolveSessionTranscriptRuntimeTarget,
  withTranscriptWriteLock,
  type TranscriptMessageAppendOptions,
  type TranscriptMessageAppendResult,
  type TranscriptUpdatePayload,
} from "../config/sessions/session-accessor.js";
import { runSessionTranscriptAppendTransaction } from "../config/sessions/transcript-append.js";
import { resolveMirroredTranscriptText } from "../config/sessions/transcript-mirror.js";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import {
  type LatestAssistantTranscriptText,
  type SessionTranscriptAppendResult,
  type SessionTranscriptAssistantMessage,
  type SessionTranscriptDeliveryMirror,
  type SessionTranscriptUpdateMode,
} from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import {
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  type ResolveSessionTranscriptMemoryHitKeyParams,
  type SessionTranscriptIdentity,
  type SessionTranscriptMemoryHitIdentity,
  type SessionTranscriptMemoryHitKey,
  type SessionTranscriptMemoryHitKeyParams,
  type SessionTranscriptReadParams,
} from "./session-transcript-memory-hit.js";

export {
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
};
export type {
  ResolveSessionTranscriptMemoryHitKeyParams,
  SessionTranscriptIdentity,
  SessionTranscriptMemoryHitIdentity,
  SessionTranscriptMemoryHitKey,
  SessionTranscriptMemoryHitKeyParams,
  SessionTranscriptReadParams,
};

export type SessionTranscriptEvent = unknown;

export type SessionTranscriptTargetParams = SessionTranscriptReadParams & {
  /**
   * @deprecated Prefer `{ agentId, sessionKey, sessionId }`. Runtime helpers
   * use the canonical SQLite transcript identity; this field is accepted only
   * while older command payloads still carry a transcript locator.
   */
  sessionFile?: string;
};

export type SessionTranscriptTarget = SessionTranscriptIdentity & {
  targetKind: "legacy-transcript-locator" | "runtime-session";
};

/**
 * @deprecated Use SessionTranscriptTarget with `{ agentId, sessionKey,
 * sessionId }`. Active transcript file targets are transitional only and will
 * be removed with the SQLite session/transcript storage flip.
 */
export type SessionTranscriptLegacyFileTarget = SessionTranscriptTarget & {
  /**
   * @deprecated Use SessionTranscriptTarget with `{ agentId, sessionKey,
   * sessionId }`. This is a transitional locator for callers that still pass
   * `sessionFile` through plugin command handlers. SQLite-backed sessions
   * return an opaque locator, not a readable JSONL file path.
   */
  sessionFile: string;
};

export type SessionTranscriptAppendMessageParams<TMessage> = SessionTranscriptTargetParams &
  TranscriptMessageAppendOptions<TMessage>;

export type SessionTranscriptAssistantMirrorAppendParams = SessionTranscriptReadParams & {
  config?: OpenClawConfig;
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  idempotencyKey?: string;
  mediaUrls?: string[];
  text?: string;
  updateMode?: SessionTranscriptUpdateMode;
};

export type SessionTranscriptWriteLockParams = SessionTranscriptTargetParams & {
  config?: TranscriptMessageAppendOptions<unknown>["config"];
};

export type SessionTranscriptWriteLockContext = {
  appendMessage: <TMessage>(
    options: Omit<TranscriptMessageAppendOptions<TMessage>, "config">,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  publishUpdate: (update?: TranscriptUpdatePayload) => Promise<void>;
  readEvents: () => Promise<SessionTranscriptEvent[]>;
  target: SessionTranscriptTarget;
};

/**
 * Resolves the public identity for a transcript without returning its file path.
 */
export async function resolveSessionTranscriptIdentity(
  params: SessionTranscriptReadParams,
): Promise<SessionTranscriptIdentity> {
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
  const agentId = normalizeAgentId(target.agentId);
  return {
    agentId,
    memoryKey: formatSessionTranscriptMemoryHitKey({ agentId, sessionId: target.sessionId }),
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
  };
}

/**
 * Resolves the public target for transcript operations without exposing the
 * current storage path as identity.
 */
export async function resolveSessionTranscriptTarget(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptTarget> {
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
  return projectPublicTarget({
    ...target,
    targetKind: params.sessionFile?.trim() ? "legacy-transcript-locator" : "runtime-session",
  });
}

/**
 * @deprecated Use resolveSessionTranscriptTarget with `{ agentId, sessionKey,
 * sessionId }`. This resolves the current opaque transcript locator for
 * legacy plugin command calls that still require `sessionFile`.
 */
export async function resolveSessionTranscriptLegacyFileTarget(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptLegacyFileTarget> {
  const target = await resolveSessionTranscriptRuntimeTarget(params);
  return {
    ...projectPublicTarget({
      ...target,
      targetKind: params.sessionFile?.trim() ? "legacy-transcript-locator" : "runtime-session",
    }),
    sessionFile: target.sessionFile,
  };
}

/**
 * Reads transcript events by public session identity instead of file path.
 */
export async function readSessionTranscriptEvents(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptEvent[]> {
  return await loadTranscriptEvents(params);
}

/**
 * Reads the latest visible assistant text by scoped identity.
 */
export async function readLatestAssistantTextByIdentity(
  params: SessionTranscriptTargetParams,
): Promise<LatestAssistantTranscriptText | undefined> {
  return readLatestTranscriptAssistantText(params);
}

/**
 * Appends a delivery-mirror assistant message through the SQLite transcript accessor.
 */
export async function appendAssistantMirrorMessageByIdentity(
  params: SessionTranscriptAssistantMirrorAppendParams,
): Promise<SessionTranscriptAppendResult> {
  const text = resolveMirroredTranscriptText({
    ...(params.mediaUrls !== undefined ? { mediaUrls: params.mediaUrls } : {}),
    ...(params.text !== undefined ? { text: params.text } : {}),
  });
  if (!text) {
    return { ok: false, reason: "empty message" };
  }
  const message = createAssistantMirrorMessage({
    ...(params.deliveryMirror !== undefined ? { deliveryMirror: params.deliveryMirror } : {}),
    ...(params.idempotencyKey !== undefined ? { idempotencyKey: params.idempotencyKey } : {}),
    text,
  });
  return await withTranscriptWriteLock(params, async (locked) => {
    const currentEntry = loadSessionEntry(params);
    if (!currentEntry?.sessionId) {
      return { ok: false, reason: "missing active session", code: "blocked" };
    }
    if (params.sessionId && currentEntry.sessionId !== params.sessionId) {
      return { ok: false, reason: "session changed", code: "session-rebound" };
    }
    const scope = {
      ...params,
      sessionId: currentEntry.sessionId,
    };
    const target = await resolveSessionTranscriptRuntimeReadTarget(scope);
    const latestEquivalentAssistantId =
      !params.idempotencyKey && isDeliveryMirrorAssistantMessage(message)
        ? findLatestEquivalentAssistantMessageId(await locked.readEvents(), message, params.config)
        : undefined;
    if (latestEquivalentAssistantId) {
      return {
        ok: true,
        messageId: latestEquivalentAssistantId,
        sessionFile: target.sessionFile,
      };
    }
    const appendResult = await locked.appendMessage({
      ...(params.config !== undefined ? { config: params.config } : {}),
      ...(params.idempotencyKey ? { idempotencyLookup: "scan" as const } : {}),
      message,
    });
    if (!appendResult) {
      return { ok: false, reason: "message skipped", code: "blocked" };
    }
    if (params.updateMode !== "none" && appendResult.appended) {
      await publishTranscriptUpdate(scope, {
        agentId: target.agentId,
        messageId: appendResult.messageId,
        sessionKey: target.sessionKey,
        target: {
          agentId: target.agentId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
        },
      });
    }
    return {
      ok: true,
      messageId: appendResult.messageId,
      sessionFile: target.sessionFile,
    };
  });
}

/**
 * Appends a transcript message by scoped transcript target.
 */
export async function appendSessionTranscriptMessageByIdentity<TMessage>(
  params: SessionTranscriptAppendMessageParams<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage> | undefined> {
  return await appendTranscriptMessage(params, params);
}

/**
 * Publishes a transcript update by scoped transcript target.
 */
export async function publishSessionTranscriptUpdateByIdentity(
  params: SessionTranscriptTargetParams & { update?: TranscriptUpdatePayload },
): Promise<void> {
  const target = await resolveSessionTranscriptRuntimeTarget(params);
  await publishTranscriptUpdate(
    {
      ...params,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
    },
    {
      ...params.update,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      target: {
        agentId: target.agentId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
      },
    },
  );
}

/**
 * Runs transcript work under the write lock for the resolved scoped target.
 */
export async function withSessionTranscriptWriteLock<T>(
  params: SessionTranscriptWriteLockParams,
  run: (context: SessionTranscriptWriteLockContext) => Promise<T> | T,
): Promise<T> {
  const legacyExplicitSessionFile = params.sessionFile?.trim();
  if (legacyExplicitSessionFile && !params.sessionKey.trim()) {
    return await withLegacySessionTranscriptFileWriteLock(params, legacyExplicitSessionFile, run);
  }
  const storageTarget = await resolveSessionTranscriptRuntimeTarget(params);
  const target = projectPublicTarget({
    ...storageTarget,
    targetKind: params.sessionFile?.trim() ? "legacy-transcript-locator" : "runtime-session",
  });
  const boundScope = {
    ...params,
    sessionId: storageTarget.sessionId,
    sessionKey: storageTarget.sessionKey,
  };
  // Treat publishUpdate as a post-commit callback: future transactional stores
  // must not expose updates when the scoped write callback fails.
  const queuedUpdates: Array<TranscriptUpdatePayload | undefined> = [];
  const result = await withTranscriptWriteLock(
    boundScope,
    async (locked) =>
      await run({
        target,
        readEvents: locked.readEvents,
        appendMessage: (options) =>
          locked.appendMessage({
            ...options,
            ...(params.config !== undefined ? { config: params.config } : {}),
          }),
        publishUpdate: async (update) => {
          queuedUpdates.push(update ? { ...update } : undefined);
        },
      }),
  );
  for (const update of queuedUpdates) {
    await publishSessionTranscriptUpdateByIdentity({
      ...boundScope,
      update,
    });
  }
  return result;
}

async function withLegacySessionTranscriptFileWriteLock<T>(
  params: SessionTranscriptWriteLockParams,
  sessionFile: string,
  run: (context: SessionTranscriptWriteLockContext) => Promise<T> | T,
): Promise<T> {
  const agentId = normalizeAgentId(params.agentId);
  const target = projectPublicTarget({
    agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    targetKind: "legacy-transcript-locator",
  });
  const queuedUpdates: Array<TranscriptUpdatePayload | undefined> = [];
  const result = await runSessionTranscriptAppendTransaction(
    {
      config: params.config,
      transcriptPath: sessionFile,
    },
    (transaction) =>
      run({
        target,
        readEvents: () => readLegacySessionTranscriptEvents(sessionFile),
        appendMessage: (options) =>
          transaction.appendMessage({
            ...options,
            sessionId: params.sessionId,
          }),
        publishUpdate: async (update) => {
          queuedUpdates.push(update ? { ...update } : undefined);
        },
      }),
  );
  for (const update of queuedUpdates) {
    emitSessionTranscriptUpdate({
      ...update,
      agentId,
      sessionFile,
      sessionKey: params.sessionKey,
      target: {
        agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      },
    });
  }
  return result;
}

async function readLegacySessionTranscriptEvents(
  sessionFile: string,
): Promise<SessionTranscriptEvent[]> {
  const events: SessionTranscriptEvent[] = [];
  for await (const line of streamSessionTranscriptLines(sessionFile)) {
    try {
      events.push(JSON.parse(line) as SessionTranscriptEvent);
    } catch {
      continue;
    }
  }
  return events;
}

function createAssistantMirrorMessage(params: {
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  idempotencyKey?: string;
  text: string;
}): SessionTranscriptAssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: "openai-responses",
    provider: "openclaw",
    model: "delivery-mirror",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.deliveryMirror ? { openclawDeliveryMirror: params.deliveryMirror } : {}),
  };
}

function findLatestEquivalentAssistantMessageId(
  events: readonly SessionTranscriptEvent[],
  message: SessionTranscriptAssistantMessage,
  config: OpenClawConfig | undefined,
): string | undefined {
  const expectedText = extractAssistantMirrorComparableText(message, config);
  if (!expectedText) {
    return undefined;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== "object") {
      continue;
    }
    const record = event as { id?: unknown; message?: unknown };
    const candidate = record.message as SessionTranscriptAssistantMessage | undefined;
    if (!candidate || candidate.role !== "assistant") {
      continue;
    }
    return extractAssistantMirrorComparableText(candidate, config) === expectedText &&
      typeof record.id === "string" &&
      record.id
      ? record.id
      : undefined;
  }
  return undefined;
}

function extractAssistantMirrorComparableText(
  message: SessionTranscriptAssistantMessage,
  config: OpenClawConfig | undefined,
): string | undefined {
  const redacted = redactTranscriptMessage(
    message as Parameters<typeof redactTranscriptMessage>[0],
    config,
  ) as SessionTranscriptAssistantMessage;
  return extractAssistantVisibleText(redacted)?.trim() || undefined;
}

function isDeliveryMirrorAssistantMessage(message: SessionTranscriptAssistantMessage): boolean {
  return message.provider === "openclaw" && message.model === "delivery-mirror";
}

function projectPublicTarget(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  targetKind: SessionTranscriptTarget["targetKind"];
}): SessionTranscriptTarget {
  const agentId = normalizeAgentId(target.agentId);
  return {
    agentId,
    memoryKey: formatSessionTranscriptMemoryHitKey({ agentId, sessionId: target.sessionId }),
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    targetKind: target.targetKind,
  };
}
