import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import { makeZeroUsageSnapshot } from "../../agents/usage.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../../routing/session-key.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../../shared/assistant-display-content.js";
import {
  extractAssistantPhaseText,
  extractFirstTextBlock,
} from "../../shared/chat-message-content.js";
import type { SkillWorkshopChangeNotice } from "../../shared/skill-workshop-change-notice.js";
import {
  CRON_DIRECT_DELIVERY_CONTEXT_KIND,
  OPENCLAW_DELIVERY_MIRROR_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../../shared/transcript-only-openclaw-assistant.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { parseSqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import { resolveDefaultSessionStorePath, resolveSessionStorePathCore } from "./paths.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  persistSessionTranscriptTurn,
  updateSessionEntry,
  waitForSessionTranscriptProjection,
  type SessionTranscriptTurnPersistOptions,
  type SessionTranscriptTurnWriteContext,
  type SessionTranscriptTurnExpectedState,
  type TranscriptEntryAnchor,
  type TranscriptEvent,
} from "./session-accessor.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import type {
  LatestTranscriptAssistantText,
  SessionTranscriptReadScope,
} from "./session-accessor.types.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import {
  readSessionEntryReadOnlyInWorker,
  withSessionEntryReadOnlyInWorker,
} from "./session-entry-read-runtime.js";
import { readActiveTranscriptEntryAnchorAsync } from "./session-transcript-anchor-read.js";
import { readLatestTranscriptAssistantTextAsync } from "./session-transcript-assistant-read.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import type {
  SessionLifecycleRevisionExpectation,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import {
  projectAssistantTranscriptText,
  recordAssistantManagedMediaUrls,
} from "./transcript-assistant-delivery.js";
import {
  applyBeforeMessageWriteToAssistant,
  type AssistantBeforeMessageWrite,
} from "./transcript-assistant-message.js";
import {
  resolveMirroredTranscriptText,
  type SessionTranscriptDeliveryMirror,
} from "./transcript-mirror.js";
import {
  isWithinTranscriptWindow,
  normalizeRecentTranscriptLimit,
  normalizeTranscriptTimestamp,
  readPreferredUpstreamUserText,
} from "./transcript-recent-window.js";
import { streamSessionTranscriptLinesReverse } from "./transcript-stream.js";
import { captureOwnedTranscriptWriteAssertion } from "./transcript-write-context.js";

type SessionTranscriptAppendTarget = {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

export type SessionTranscriptAppendResult =
  | {
      ok: true;
      target: SessionTranscriptAppendTarget;
      messageId: string;
      anchor?: TranscriptEntryAnchor;
    }
  | {
      ok: false;
      reason: string;
      code?: "blocked" | "session-rebound";
    };

export type SessionTranscriptUpdateMode = "inline" | "file-only" | "none";
type InternalSessionTranscriptDeliveryMirror =
  | SessionTranscriptDeliveryMirror
  | {
      kind: "message-tool-source-reply";
      final: boolean;
      sourceTurnId?: string;
      toolCallId?: string;
    }
  | {
      kind: typeof CRON_DIRECT_DELIVERY_CONTEXT_KIND;
    }
  | SkillWorkshopChangeNotice;

export type SessionTranscriptAssistantMessage = Parameters<SessionManager["appendMessage"]>[0] & {
  role: "assistant";
  [ASSISTANT_DISPLAY_CONTENT_FIELD]?: Array<Record<string, unknown>>;
};

export type SessionRecentConversationText = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  sourceChannel?: string;
};

type ReadRecentSessionConversationTextOptions = {
  beforeTimestampMs?: number;
  includeCronDirectDeliveryContext?: boolean;
  limit?: number;
  minTimestampMs?: number;
  role?: "user" | "assistant";
  preferUpstreamUserText?: boolean;
};

type ReadRecentSessionConversationTextParams = ReadRecentSessionConversationTextOptions & {
  agentId: string;
  sessionKey: string;
  storePath?: string;
};

class SessionTranscriptAgentScopeMismatchError extends Error {
  readonly code = "SESSION_TRANSCRIPT_AGENT_SCOPE_MISMATCH";

  constructor(
    readonly agentId: string,
    readonly sessionKeyAgentId: string,
  ) {
    super(
      `Session transcript agent scope mismatch: explicit agent "${agentId}" does not match session key agent "${sessionKeyAgentId}".`,
    );
    this.name = "SessionTranscriptAgentScopeMismatchError";
  }
}

export type LatestAssistantTranscriptText = LatestTranscriptAssistantText;

function parseAssistantTranscriptText(line: string): LatestAssistantTranscriptText | undefined {
  const { id, message } = JSON.parse(line) as {
    id?: unknown;
    message?: unknown;
  };
  if (isTranscriptOnlyOpenClawAssistantMessage(message)) {
    return undefined;
  }
  return projectAssistantTranscriptText(message, id);
}

function extractRecentConversationText(
  event: TranscriptEvent,
  options: ReadRecentSessionConversationTextOptions = {},
): SessionRecentConversationText | undefined {
  const parsed = event as {
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
        openclawDeliveryMirror?: unknown;
        __openclaw?: unknown;
      }
    | undefined;
  if (
    !message ||
    (message.role !== "user" && message.role !== "assistant") ||
    (options.role && message.role !== options.role)
  ) {
    return undefined;
  }
  const deliveryMirror = message.openclawDeliveryMirror;
  const includeCronDirectDeliveryContext =
    options.includeCronDirectDeliveryContext === true &&
    deliveryMirror !== null &&
    typeof deliveryMirror === "object" &&
    !Array.isArray(deliveryMirror) &&
    "kind" in deliveryMirror &&
    deliveryMirror.kind === CRON_DIRECT_DELIVERY_CONTEXT_KIND;
  if (
    message.role === "assistant" &&
    isTranscriptOnlyOpenClawAssistantMessage(message) &&
    !includeCronDirectDeliveryContext
  ) {
    return undefined;
  }
  const upstreamUserText =
    options.preferUpstreamUserText && message.role === "user"
      ? readPreferredUpstreamUserText(message)
      : undefined;
  if (upstreamUserText === null) {
    return undefined;
  }
  const text =
    message.role === "assistant"
      ? extractAssistantPhaseText(message)
      : (upstreamUserText ?? extractFirstTextBlock(message)?.trim());
  if (!text) {
    return undefined;
  }
  const provenance =
    message.provenance && typeof message.provenance === "object"
      ? (message.provenance as { sourceChannel?: unknown })
      : undefined;
  const timestamp = normalizeTranscriptTimestamp(message.timestamp);
  return {
    ...(typeof parsed.id === "string" && parsed.id ? { id: parsed.id } : {}),
    role: message.role,
    text,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(typeof provenance?.sourceChannel === "string" && provenance.sourceChannel.trim()
      ? { sourceChannel: provenance.sourceChannel.trim() }
      : {}),
  };
}

async function readRecentUserAssistantTextFromSqliteTranscript(
  scope: SessionTranscriptReadScope,
  assertCurrent: () => void,
  options: ReadRecentSessionConversationTextOptions = {},
): Promise<SessionRecentConversationText[]> {
  const limit = normalizeRecentTranscriptLimit(options.limit);
  const pageSize = 250;
  try {
    const { readSessionTranscriptBoundedMessageTailPageAsync } =
      await import("../../gateway/session-transcript-readers.js");
    const { readRestoredSessionTranscript } = await import("./session-cold-storage-read.js");
    return await readRestoredSessionTranscript(
      scope,
      async () => {
        const recent: SessionRecentConversationText[] = [];
        for (let offset = 0; recent.length < limit; offset += pageSize) {
          const page = await readSessionTranscriptBoundedMessageTailPageAsync(scope, {
            maxMessages: pageSize,
            // Preserve the existing message-count-only bound for this text projection.
            maxBytes: Number.MAX_SAFE_INTEGER,
            offset,
          });
          if (page.events.length === 0) {
            break;
          }
          for (const event of page.events.toReversed()) {
            const entry = extractRecentConversationText(event.event, options);
            if (entry && isWithinTranscriptWindow(entry.timestamp, options)) {
              recent.push(entry);
              if (recent.length >= limit) {
                break;
              }
            }
          }
        }
        return recent.toReversed();
      },
      { assertCurrent },
    );
  } catch (error) {
    if (isSessionTranscriptProjectionUnavailableError(error)) {
      return [];
    }
    throw error;
  }
}

export async function readRecentUserAssistantTextForSession(
  params: ReadRecentSessionConversationTextParams,
): Promise<SessionRecentConversationText[]> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return [];
  }
  const explicitAgentId = params.agentId?.trim() ? normalizeAgentId(params.agentId) : undefined;
  const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (
    explicitAgentId &&
    sessionKeyAgentId &&
    explicitAgentId !== normalizeAgentId(sessionKeyAgentId)
  ) {
    throw new SessionTranscriptAgentScopeMismatchError(explicitAgentId, sessionKeyAgentId);
  }
  const agentId = explicitAgentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const scopedSessionKey = scopeLegacySessionKeyToAgent({ agentId, sessionKey }) ?? sessionKey;
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(agentId);
  return withSessionEntryReadOnlyInWorker(
    { agentId, sessionKey: scopedSessionKey, storePath },
    () => {},
    async (read, owner) => {
      if (!read.ok) {
        throw read.error;
      }
      if (!read.value?.sessionId) {
        return [];
      }
      const result = await readRecentUserAssistantTextFromSqliteTranscript(
        {
          agentId,
          sessionKey: scopedSessionKey,
          sessionId: read.value.sessionId,
          storePath: owner.source?.path ?? owner.scope?.storePath ?? storePath,
          env: owner.scope?.env,
        },
        owner.assertCurrent,
        params,
      );
      owner.assertCurrent();
      return result;
    },
  );
}

export async function readLatestAssistantTextFromSessionTranscript(
  target:
    | string
    | {
        agentId?: string;
        sessionId: string;
        sessionKey?: string;
        storePath?: string;
      }
    | undefined,
): Promise<LatestAssistantTranscriptText | undefined> {
  const sqliteScope =
    target && typeof target === "object" ? target : parseSqliteSessionFileMarker(target);
  if (sqliteScope) {
    return readLatestTranscriptAssistantTextAsync(sqliteScope);
  }
  const sessionFile = typeof target === "string" ? target : undefined;
  if (!sessionFile?.trim()) {
    return undefined;
  }

  for await (const line of streamSessionTranscriptLinesReverse(sessionFile)) {
    try {
      const assistantText = parseAssistantTranscriptText(line);
      if (assistantText) {
        return assistantText;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

type SessionTranscriptAssistantAppendOptions = {
  agentId?: string;
  sessionKey: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: SessionLifecycleRevisionExpectation;
  expectedWriterRunId?: string;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  eventId?: string;
  idempotencyKey?: string;
  runId?: string;
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
  beforeMessageWrite?: AssistantBeforeMessageWrite;
  assertCurrent?: () => void;
  onMessageCommitted?: SessionTranscriptTurnPersistOptions["onMessageCommitted"];
};

export async function appendAssistantMessageToSessionTranscript(
  params: SessionTranscriptAssistantAppendOptions & {
    text?: string;
    mediaUrls?: string[];
    content?: SessionTranscriptAssistantMessage["content"];
    displayContent?: Array<Record<string, unknown>>;
    deliveryMirror?: InternalSessionTranscriptDeliveryMirror;
  },
): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const mirrorText = params.content
    ? null
    : resolveMirroredTranscriptText({
        text: params.text,
        mediaUrls: params.mediaUrls,
      });
  const content =
    params.content ?? (mirrorText ? [{ type: "text" as const, text: mirrorText }] : []);
  const displayContent = params.displayContent?.map((block) => Object.assign({}, block));
  if (content.length === 0 && !displayContent?.length) {
    return { ok: false, reason: "empty text" };
  }

  return appendExactAssistantMessageToSessionTranscript({
    ...params,
    sessionKey,
    expectedWriterRunId: params.expectedWriterRunId || undefined,
    message: {
      ...recordAssistantManagedMediaUrls(
        { role: "assistant" as const, openclawDelivery: { mediaUrls: [] } },
        params.mediaUrls,
      ),
      content,
      ...(displayContent ? { [ASSISTANT_DISPLAY_CONTENT_FIELD]: displayContent } : {}),
      api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
      provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
      model: OPENCLAW_DELIVERY_MIRROR_MODEL,
      usage: makeZeroUsageSnapshot(),
      stopReason: "stop" as const,
      timestamp: Date.now(),
      ...(params.deliveryMirror ? { openclawDeliveryMirror: params.deliveryMirror } : {}),
    },
  });
}

export async function appendExactAssistantMessageToSessionTranscript(
  params: SessionTranscriptAssistantAppendOptions & {
    message: SessionTranscriptAssistantMessage;
  },
): Promise<SessionTranscriptAppendResult> {
  const assertCurrent = () => params.assertCurrent?.();
  const authority = { assertCurrent, authorize: assertCurrent };
  if (captureSessionActorStorageOwner(params, authority)) {
    return (
      (await withSessionActorStorage(
        params,
        { authority, lifetime: { assertCurrent, assertReadable: assertCurrent } },
        () => appendExactAssistantMessageWithSource(params),
      )) ?? {
        ok: false,
        ...(params.expectedSessionId ? { code: "session-rebound" as const } : {}),
        reason: `unknown sessionKey: ${params.sessionKey}`,
      }
    );
  }
  return appendExactAssistantMessageWithSource(params);
}

async function appendExactAssistantMessageWithSource(
  params: Parameters<typeof appendExactAssistantMessageToSessionTranscript>[0],
): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }
  if (params.message.role !== "assistant") {
    return { ok: false, reason: "message role must be assistant" };
  }

  const explicitAgentId = params.agentId?.trim() || undefined;
  const sessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const transcriptAgentId = explicitAgentId ?? sessionAgentId;
  const configuredDefaultAgentId =
    !transcriptAgentId && params.config ? resolveDefaultAgentId(params.config) : undefined;
  const storeAgentId =
    transcriptAgentId ?? resolveAgentIdFromSessionKey(sessionKey, configuredDefaultAgentId);
  const memory = getSessionActorStorageBinding(params);
  const storePath =
    memory?.path ??
    params.storePath ??
    resolveSessionStorePathCore(params.config?.session?.store, { agentId: storeAgentId });
  const normalizedKey = resolveSqliteSessionKey(sessionKey, storeAgentId);
  const readScope = { agentId: transcriptAgentId, sessionKey: normalizedKey, storePath };
  const entry = memory
    ? memory.actor.storage.readCurrent(
        { type: "session.entry.read", input: { sessionKey: normalizedKey } },
        memory.authority,
      )
    : await readSessionEntryReadOnlyInWorker(readScope, params.assertCurrent);
  if (
    (params.expectedSessionId && entry?.sessionId !== params.expectedSessionId) ||
    (params.expectedLifecycleRevision !== undefined &&
      entry?.lifecycleRevision !== (params.expectedLifecycleRevision ?? undefined)) ||
    (params.expectedWriterRunId !== undefined &&
      entry?.activeWriterRunId !== params.expectedWriterRunId)
  ) {
    return {
      ok: false,
      code: "session-rebound",
      reason: `session rebound for sessionKey: ${sessionKey}`,
    };
  }
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

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
          agentId: transcriptAgentId,
          sessionKey: normalizedKey,
        })
      : message;
  if (!preparedUnkeyedMessage) {
    return {
      ok: false,
      code: "blocked",
      reason: "blocked by before_message_write",
    };
  }
  const target: SessionTranscriptAppendTarget = {
    ...(transcriptAgentId ? { agentId: transcriptAgentId } : {}),
    sessionId: entry.sessionId,
    sessionKey: normalizedKey,
    storePath,
  };
  if (isRedundantDeliveryMirror(params.message) && !explicitIdempotencyKey) {
    // Reconciliation needs the writer queue. Wait before entering it, then
    // read the current projected tail again inside the guarded append.
    await waitForSessionTranscriptProjection(target);
  }
  let equivalentAssistant: { messageId: string; assertCurrent: () => void } | undefined;
  // Keyed mirrors use strict replay identity; text-only suppression must not
  // hide conflicting media or collapse distinct source messages.
  const turn = await persistSessionTranscriptTurn(target, {
    assertCurrent: params.assertCurrent,
    cwd: entry.spawnedCwd,
    ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
    ...(params.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: params.expectedLifecycleRevision }
      : {}),
    ...(params.expectedWriterRunId !== undefined
      ? { expectedWriterRunId: params.expectedWriterRunId }
      : {}),
    ...(params.expectedSessionState ? { expectedSessionState: params.expectedSessionState } : {}),
    ...(params.sessionLifecyclePatch
      ? { sessionLifecyclePatch: params.sessionLifecyclePatch }
      : {}),
    ...(params.config ? { config: params.config } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    updateMode: params.updateMode ?? "inline",
    onMessageCommitted: params.onMessageCommitted,
    touchSessionEntry: true,
    messages: [
      {
        message: preparedUnkeyedMessage,
        ...(params.eventId ? { eventId: params.eventId } : {}),
        ...(explicitIdempotencyKey ? { idempotencyLookup: "scan" } : {}),
        ...(explicitIdempotencyKey && params.beforeMessageWrite
          ? {
              workerPreparation: {
                prepareMessageAfterIdempotencyCheck: (candidate: unknown) =>
                  applyBeforeMessageWriteToAssistant({
                    message: candidate as Parameters<SessionManager["appendMessage"]>[0],
                    beforeMessageWrite: params.beforeMessageWrite,
                    explicitIdempotencyKey,
                    agentId: transcriptAgentId,
                    sessionKey: normalizedKey,
                  }),
              },
            }
          : {}),
        shouldAppend: async (appendTarget) => {
          const messageId =
            isRedundantDeliveryMirror(params.message) && !explicitIdempotencyKey
              ? await findLatestEquivalentAssistantMessageId(
                  appendTarget,
                  preparedUnkeyedMessage as SessionTranscriptAssistantMessage,
                  params.config,
                )
              : undefined;
          equivalentAssistant = messageId
            ? { messageId, assertCurrent: captureOwnedTranscriptWriteAssertion(appendTarget) }
            : undefined;
          return !equivalentAssistant;
        },
      },
    ],
  });
  if (turn.rejectedReason === "session-rebound") {
    return {
      ok: false,
      code: "session-rebound",
      reason: `session rebound for sessionKey: ${sessionKey}`,
    };
  }
  if (equivalentAssistant) {
    const anchor = await readActiveTranscriptEntryAnchorAsync({
      ...target,
      entryId: equivalentAssistant.messageId,
    });
    equivalentAssistant.assertCurrent();
    params.assertCurrent?.();
    return {
      ok: true,
      target,
      messageId: equivalentAssistant.messageId,
      ...(anchor ? { anchor } : {}),
    };
  }
  const appendedResult = turn.messages[0];
  if (!appendedResult) {
    return {
      ok: false,
      code: "blocked",
      reason: "blocked by before_message_write",
    };
  }
  const { anchor, messageId } = appendedResult;
  if (!params.expectedSessionId) {
    try {
      const now = Date.now();
      await updateSessionEntry(
        { agentId: transcriptAgentId, sessionKey: normalizedKey, storePath },
        (current) =>
          current.sessionId !== entry.sessionId
            ? null
            : {
                updatedAt: Math.max(current.updatedAt ?? 0, now),
                sessionStartedAt: current.sessionStartedAt ?? entry.sessionStartedAt ?? now,
              },
      );
    } catch (err) {
      rethrowIncognitoSessionError(err);
      return {
        ok: false,
        reason: formatErrorMessage(err),
      };
    }
  }
  return { ok: true, target, messageId, ...(anchor ? { anchor } : {}) };
}

function isRedundantDeliveryMirror(message: SessionTranscriptAssistantMessage): boolean {
  return (
    message.provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
    message.model === OPENCLAW_DELIVERY_MIRROR_MODEL
  );
}

async function readLatestVisibleTranscriptMessage(scope: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<{ id?: string; message: unknown } | undefined> {
  try {
    const event = (await prepareSessionTranscriptHydration(scope).readLatestActiveMessage())?.event;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return undefined;
    }
    const record = event as { id?: unknown; message?: unknown };
    if (record.message === undefined) {
      return undefined;
    }
    return {
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      message: record.message,
    };
  } catch (error) {
    rethrowIncognitoSessionError(error);
    // Mirror deduplication remains best-effort when transcript reads are unavailable.
    return undefined;
  }
}

function extractAssistantMessageText(message: AgentMessage): string | null {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
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
  target: SessionTranscriptTurnWriteContext,
  message: SessionTranscriptAssistantMessage,
  config?: OpenClawConfig,
): Promise<string | undefined> {
  const expectedText = extractAssistantMessageText(redactTranscriptMessage(message, config));
  if (!expectedText) {
    return undefined;
  }

  if (target.storePath && target.sessionId && target.agentId && target.sessionKey) {
    const latest = await readLatestVisibleTranscriptMessage({
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
    });
    const latestMessage = latest?.message as { role?: unknown } | undefined;
    if (latestMessage?.role !== "assistant") {
      return undefined;
    }
    const candidateText = latest
      ? extractAssistantMessageText(redactTranscriptMessage(latest.message as AgentMessage, config))
      : undefined;
    return candidateText === expectedText ? latest?.id : undefined;
  }

  return undefined;
}
