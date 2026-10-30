import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import { sanitizeTranscriptMessage } from "../../agents/transcript-sanitize.js";
import { makeZeroUsageSnapshot } from "../../agents/usage.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../../routing/session-key.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../../shared/assistant-display-content.js";
import type { ModelFallbackNotice } from "../../shared/model-fallback-notice.js";
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
  createSessionEntryWithTranscript,
  isSessionTranscriptProjectionUnavailableError,
  persistSessionTranscriptTurn,
  updateSessionEntry,
  waitForSessionTranscriptProjection,
  type SessionTranscriptTurnPersistOptions,
  type SessionTranscriptTurnWriteContext,
  type SessionTranscriptTurnExpectedState,
  type TranscriptEntryAnchor,
} from "./session-accessor.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import type {
  LatestTranscriptAssistantText,
  SessionTranscriptReadScope,
} from "./session-accessor.types.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { readActiveTranscriptEntryAnchorAsync } from "./session-transcript-anchor-read.js";
import { readLatestTranscriptAssistantTextAsync } from "./session-transcript-assistant-read.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import type {
  SessionLifecycleRevisionExpectation,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import { projectAssistantTranscriptMirrorIdentity } from "./transcript-assistant-delivery-read.js";
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
  type SubagentCompletionDirectDeliveryMirror,
} from "./transcript-mirror.js";
import type {
  ReadRecentSessionConversationTextOptions,
  ReadRecentSessionConversationTurnOptions,
  SessionRecentConversationTurn,
  SessionRecentConversationText,
} from "./transcript-recent-text.js";
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
  | SubagentCompletionDirectDeliveryMirror
  | {
      kind: "message-tool-source-reply";
      final: boolean;
      sourceTurnId?: string;
      toolCallId?: string;
    }
  | {
      kind: typeof CRON_DIRECT_DELIVERY_CONTEXT_KIND;
    }
  | SkillWorkshopChangeNotice
  | ModelFallbackNotice;

export type SessionTranscriptAssistantMessage = Parameters<SessionManager["appendMessage"]>[0] & {
  role: "assistant";
  [ASSISTANT_DISPLAY_CONTENT_FIELD]?: Array<Record<string, unknown>>;
};

export type { SessionRecentConversationText } from "./transcript-recent-text.js";

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

async function readRecentUserAssistantTextFromSqliteTranscript(
  scope: SessionTranscriptReadScope,
  assertCurrent: () => void,
  options: ReadRecentSessionConversationTurnOptions = {},
): Promise<SessionRecentConversationTurn[]> {
  try {
    const { readRecentSessionConversationTextAsync } =
      await import("../../gateway/session-transcript-readers.js");
    const { readRestoredSessionTranscript } = await import("./session-cold-storage-read.js");
    return await readRestoredSessionTranscript(
      scope,
      () => readRecentSessionConversationTextAsync(scope, options),
      { assertCurrent },
    );
  } catch (error) {
    if (isSessionTranscriptProjectionUnavailableError(error)) {
      return [];
    }
    throw error;
  }
}

export function readRecentUserAssistantTextForSession(
  params: ReadRecentSessionConversationTextParams,
): Promise<SessionRecentConversationText[]> {
  return readRecentUserAssistantTurnsForSession(params, false);
}

/** Internal channel reconciliation projection; the SDK reader above stays text-only. */
export async function readRecentUserAssistantTurnsForSession(
  params: ReadRecentSessionConversationTextParams,
  includeTurnIdentity = true,
): Promise<SessionRecentConversationTurn[]> {
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
        { ...params, includeTurnIdentity },
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
  /** Delivered command exchanges are replayable conversation, not delivery bookkeeping. */
  command?: { text: string; idempotencyKey: string };
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
      model: params.command ? "command" : OPENCLAW_DELIVERY_MIRROR_MODEL,
      usage: makeZeroUsageSnapshot(),
      stopReason: "stop" as const,
      timestamp: Date.now(),
      ...(!params.command && params.deliveryMirror
        ? { openclawDeliveryMirror: params.deliveryMirror }
        : {}),
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
        {
          authority,
          lifetime: { assertCurrent, assertReadable: assertCurrent },
          create: Boolean(params.command),
        },
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
  const resolved = memory
    ? {
        existing: memory.actor.storage.readCurrent(
          {
            type: "session.entry.read",
            input: { sessionKey: resolveSqliteSessionKey(sessionKey, memory.agentId) },
          },
          memory.authority,
        ),
        normalizedKey: resolveSqliteSessionKey(sessionKey, memory.agentId),
      }
    : await withSessionEntryReadOnlyInWorker(
        { ...(transcriptAgentId ? { agentId: transcriptAgentId } : {}), sessionKey, storePath },
        () => params.assertCurrent?.(),
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          return {
            existing: read.value,
            normalizedKey: resolveSqliteSessionKey(
              sessionKey,
              owner.scope?.agentId ?? storeAgentId,
            ),
          };
        },
      );
  const { normalizedKey } = resolved;
  let entry = resolved.existing;
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
  if (!entry && params.command) {
    const created = await createSessionEntryWithTranscript(
      { agentId: storeAgentId, sessionKey: resolved.normalizedKey, storePath },
      ({ existingEntry }) => ({
        ok: true,
        entry: existingEntry ?? { sessionId: randomUUID(), updatedAt: Date.now() },
      }),
      { commitGuard: params.assertCurrent },
    );
    if (!created.ok) {
      return { ok: false, reason: created.error };
    }
    entry = created.entry;
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
      ...(params.command
        ? [
            {
              message: {
                role: "user" as const,
                content: [{ type: "text" as const, text: params.command.text }],
                timestamp: Date.now(),
                idempotencyKey: params.command.idempotencyKey,
              },
              idempotencyLookup: "scan" as const,
            },
          ]
        : []),
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
  const appendedResult = turn.messages.find(
    ({ message: persistedMessage }) =>
      typeof persistedMessage === "object" &&
      persistedMessage !== null &&
      "role" in persistedMessage &&
      persistedMessage.role === "assistant",
  );
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

async function findLatestEquivalentAssistantMessageId(
  target: SessionTranscriptTurnWriteContext,
  message: SessionTranscriptAssistantMessage,
): Promise<string | undefined> {
  const expected = projectAssistantTranscriptMirrorIdentity(sanitizeTranscriptMessage(message));
  if (!expected) {
    return undefined;
  }

  if (target.storePath && target.sessionId && target.agentId && target.sessionKey) {
    const latest = await readLatestVisibleTranscriptMessage({
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
    });
    const candidate = latest
      ? projectAssistantTranscriptMirrorIdentity(
          sanitizeTranscriptMessage(latest.message as AgentMessage),
        )
      : undefined;
    return isDeepStrictEqual(candidate, expected) ? latest?.id : undefined;
  }

  return undefined;
}
