// Session transcript facade appends mirror messages and reads tails.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
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
import {
  CRON_DIRECT_DELIVERY_CONTEXT_KIND,
  OPENCLAW_DELIVERY_MIRROR_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../../shared/transcript-only-openclaw-assistant.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "./legacy-sqlite-marker.js";
import { resolveDefaultSessionStorePath, resolveSessionStorePathCore } from "./paths.js";
import {
  loadSessionEntryReadOnly,
  isSessionTranscriptProjectionUnavailableError,
  persistSessionTranscriptTurn,
  readActiveTranscriptEntryAnchor,
  readLatestTranscriptAssistantText,
  readSessionTranscriptMessageEventPage,
  resolveSessionEntrySelection,
  updateSessionEntry,
  waitForSessionTranscriptProjection,
  type SessionTranscriptTurnPersistOptions,
  type SessionTranscriptTurnExpectedState,
  type TranscriptEntryAnchor,
  type TranscriptEvent,
} from "./session-accessor.js";
import type { LatestTranscriptAssistantText } from "./session-accessor.types.js";
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
  findLatestEquivalentAssistantMessageId,
  isRedundantDeliveryMirror,
} from "./transcript-mirror-dedup.js";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";
import {
  isWithinTranscriptWindow,
  normalizeRecentTranscriptLimit,
  normalizeTranscriptTimestamp,
  readPreferredUpstreamUserText,
} from "./transcript-recent-window.js";
import { streamSessionTranscriptLinesReverse } from "./transcript-stream.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

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
export type SessionTranscriptDeliveryMirror =
  | {
      kind: "channel-final";
      sourceMessageId?: string;
    }
  | {
      kind: "channel-final-suppressed";
      reason: "stale-foreground";
      sourceMessageId?: string;
    };

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
    };

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

function parseAssistantTranscriptText(
  line: string,
  options?: { excludeTranscriptOnlyOpenClawAssistant?: boolean },
): LatestAssistantTranscriptText | undefined {
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
  return projectAssistantTranscriptText(message, parsed.id);
}

type SessionConversationTranscriptTarget = {
  sqliteScope?: SqliteSessionFileMarker;
};

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

async function readRecentUserAssistantTextFromSqliteTranscript(
  scope: SqliteSessionFileMarker,
  options: ReadRecentSessionConversationTextOptions = {},
): Promise<SessionRecentConversationText[]> {
  const limit = normalizeRecentTranscriptLimit(options.limit);
  const pageSize = 250;
  try {
    const readScope = {
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      storePath: scope.storePath,
    };
    const { readRestoredSessionTranscript } = await import("./session-cold-storage-read.js");
    return await readRestoredSessionTranscript(readScope, () => {
      const recent: SessionRecentConversationText[] = [];
      for (let offset = 0; recent.length < limit; offset += pageSize) {
        const page = readSessionTranscriptMessageEventPage(readScope, {
          maxMessages: pageSize,
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
    });
  } catch (error) {
    if (isSessionTranscriptProjectionUnavailableError(error)) {
      return [];
    }
    throw error;
  }
}

function resolveSessionConversationTranscriptTarget(params: {
  agentId?: string;
  sessionKey: string;
  storePath?: string;
}): SessionConversationTranscriptTarget {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return {};
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
  const entry = loadSessionEntryReadOnly({ agentId, sessionKey: scopedSessionKey, storePath });
  if (!entry?.sessionId) {
    return {};
  }
  return {
    sqliteScope: {
      agentId,
      sessionId: entry.sessionId,
      storePath,
    },
  };
}

export async function readRecentUserAssistantTextForSession(
  params: ReadRecentSessionConversationTextParams,
): Promise<SessionRecentConversationText[]> {
  const target = resolveSessionConversationTranscriptTarget(params);
  if (target.sqliteScope) {
    return await readRecentUserAssistantTextFromSqliteTranscript(target.sqliteScope, params);
  }
  return [];
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
    const { readRestoredSessionTranscript } = await import("./session-cold-storage-read.js");
    return readRestoredSessionTranscript(sqliteScope, () =>
      readLatestTranscriptAssistantText(sqliteScope),
    );
  }
  const sessionFile = typeof target === "string" ? target : undefined;
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

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: SessionLifecycleRevisionExpectation;
  expectedWriterRunId?: string;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  text?: string;
  mediaUrls?: string[];
  content?: SessionTranscriptAssistantMessage["content"];
  displayContent?: Array<Record<string, unknown>>;
  /** Prepare display-only attachments under the writer queue; replay retains accepted IDs. */
  prepareDisplayContent?: () => Promise<Array<Record<string, unknown>> | undefined>;
  eventId?: string;
  idempotencyKey?: string;
  runId?: string;
  deliveryMirror?: InternalSessionTranscriptDeliveryMirror;
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
  beforeMessageWrite?: AssistantBeforeMessageWrite;
  onMessageCommitted?: SessionTranscriptTurnPersistOptions["onMessageCommitted"];
}): Promise<SessionTranscriptAppendResult> {
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
    agentId: params.agentId,
    sessionKey,
    ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
    ...(params.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: params.expectedLifecycleRevision }
      : {}),
    ...(params.expectedWriterRunId ? { expectedWriterRunId: params.expectedWriterRunId } : {}),
    ...(params.expectedSessionState ? { expectedSessionState: params.expectedSessionState } : {}),
    ...(params.sessionLifecyclePatch
      ? { sessionLifecyclePatch: params.sessionLifecyclePatch }
      : {}),
    storePath: params.storePath,
    ...(params.eventId ? { eventId: params.eventId } : {}),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    updateMode: params.updateMode,
    onMessageCommitted: params.onMessageCommitted,
    prepareDisplayContent: params.prepareDisplayContent,
    config: params.config,
    ...(params.beforeMessageWrite ? { beforeMessageWrite: params.beforeMessageWrite } : {}),
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
    },
  });
}

export async function appendExactAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: SessionLifecycleRevisionExpectation;
  expectedWriterRunId?: string;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  message: SessionTranscriptAssistantMessage;
  eventId?: string;
  idempotencyKey?: string;
  runId?: string;
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
  config?: OpenClawConfig;
  beforeMessageWrite?: AssistantBeforeMessageWrite;
  onMessageCommitted?: SessionTranscriptTurnPersistOptions["onMessageCommitted"];
  prepareDisplayContent?: () => Promise<Array<Record<string, unknown>> | undefined>;
}): Promise<SessionTranscriptAppendResult> {
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
  const storePath =
    params.storePath ??
    resolveSessionStorePathCore(params.config?.session?.store, { agentId: storeAgentId });
  const resolved = resolveSessionEntrySelection({
    ...(transcriptAgentId ? { agentId: transcriptAgentId } : {}),
    sessionKey,
    storePath,
  });
  const entry = resolved.existing;
  if (params.expectedSessionId && entry?.sessionId !== params.expectedSessionId) {
    return {
      ok: false,
      code: "session-rebound",
      reason: `session rebound for sessionKey: ${sessionKey}`,
    };
  }
  if (
    params.expectedLifecycleRevision !== undefined &&
    entry?.lifecycleRevision !== (params.expectedLifecycleRevision ?? undefined)
  ) {
    return {
      ok: false,
      code: "session-rebound",
      reason: `session rebound for sessionKey: ${sessionKey}`,
    };
  }
  if (
    params.expectedWriterRunId !== undefined &&
    (entry as SessionEntry | undefined)?.activeWriterRunId !== params.expectedWriterRunId
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

  const appendToSession = async (
    currentEntry: NonNullable<typeof entry>,
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
            agentId: transcriptAgentId,
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
    const target: SessionTranscriptAppendTarget = {
      ...(transcriptAgentId ? { agentId: transcriptAgentId } : {}),
      sessionId: currentEntry.sessionId,
      sessionKey: resolved.normalizedKey,
      storePath,
    };
    const deduplicateText =
      isRedundantDeliveryMirror(params.message) &&
      !explicitIdempotencyKey &&
      !params.prepareDisplayContent;
    if (deduplicateText) {
      // Reconciliation needs the writer queue. Wait before entering it, then
      // read the current projected tail again inside the guarded append.
      await waitForSessionTranscriptProjection(target);
    }
    let latestEquivalentAssistantId: string | undefined;
    // Keyed mirrors use strict replay identity; text-only suppression must not
    // hide conflicting media or collapse distinct source messages.
    const turn = await persistSessionTranscriptTurn(
      {
        sessionId: currentEntry.sessionId,
        sessionKey: resolved.normalizedKey,
        storePath,
        ...(transcriptAgentId ? { agentId: transcriptAgentId } : {}),
      },
      {
        cwd: currentEntry.spawnedCwd,
        ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
        ...(params.expectedLifecycleRevision !== undefined
          ? { expectedLifecycleRevision: params.expectedLifecycleRevision }
          : {}),
        ...(params.expectedWriterRunId !== undefined
          ? { expectedWriterRunId: params.expectedWriterRunId }
          : {}),
        ...(params.expectedSessionState
          ? { expectedSessionState: params.expectedSessionState }
          : {}),
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
                  prepareMessageAfterIdempotencyCheck: (candidate: unknown) =>
                    applyBeforeMessageWriteToAssistant({
                      message: candidate as Parameters<SessionManager["appendMessage"]>[0],
                      beforeMessageWrite: params.beforeMessageWrite,
                      explicitIdempotencyKey,
                      agentId: transcriptAgentId,
                      sessionKey: resolved.normalizedKey,
                    }),
                }
              : {}),
            shouldAppend: async (appendTarget) => {
              latestEquivalentAssistantId = deduplicateText
                ? await findLatestEquivalentAssistantMessageId(
                    appendTarget,
                    preparedUnkeyedMessage as SessionTranscriptAssistantMessage,
                    params.config,
                  )
                : undefined;
              if (!latestEquivalentAssistantId && params.prepareDisplayContent) {
                const facts = explicitIdempotencyKey
                  ? await import("./session-accessor.sqlite-transcript-mirror-read.js").then(
                      ({ readTranscriptMirrorFactsAsync }) =>
                        readTranscriptMirrorFactsAsync(
                          { ...appendTarget, sessionId: currentEntry.sessionId },
                          { idempotencyKeys: [explicitIdempotencyKey] },
                        ),
                    )
                  : undefined;
                const prior = explicitIdempotencyKey
                  ? facts?.messagesByIdempotencyKey.get(explicitIdempotencyKey)
                  : undefined;
                // Display IDs are derived custody, not a new replay identity. The
                // append transaction still compares the caller's text and media URLs.
                const displayContent = prior
                  ? asOptionalRecord(prior)?.[ASSISTANT_DISPLAY_CONTENT_FIELD]
                  : await params.prepareDisplayContent();
                if (displayContent) {
                  Object.assign(preparedUnkeyedMessage, {
                    [ASSISTANT_DISPLAY_CONTENT_FIELD]: displayContent,
                  });
                }
              }
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
      const anchor = readActiveTranscriptEntryAnchor({
        ...target,
        entryId: latestEquivalentAssistantId,
      });
      return {
        ok: true,
        target,
        messageId: latestEquivalentAssistantId,
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
        await touchSqliteAssistantAppendSessionEntry({
          agentId: transcriptAgentId,
          currentEntry,
          sessionKey: resolved.normalizedKey,
          storePath,
        });
      } catch (err) {
        return {
          ok: false,
          reason: formatErrorMessage(err),
        };
      }
    }
    return { ok: true, target, messageId, ...(anchor ? { anchor } : {}) };
  };
  return await appendToSession(entry);
}

async function touchSqliteAssistantAppendSessionEntry(params: {
  agentId?: string;
  currentEntry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const now = Date.now();
  const buildPatch = (entry: SessionEntry | undefined): Partial<SessionEntry> => ({
    updatedAt: Math.max(entry?.updatedAt ?? 0, now),
    sessionStartedAt: entry?.sessionStartedAt ?? params.currentEntry.sessionStartedAt ?? now,
  });
  await updateSessionEntry(
    {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    (entry) => {
      if (entry.sessionId !== params.currentEntry.sessionId) {
        return null;
      }
      return buildPatch(entry);
    },
  );
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
