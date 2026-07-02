// Dispatches reply turns through ACP runtimes and projects their events.
import { formatAcpRuntimeErrorText } from "@openclaw/acp-core/runtime/error-text";
import { resolveAcpThreadSessionDetailLines } from "@openclaw/acp-core/runtime/session-identifiers";
import {
  isSessionIdentityPending,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { AcpTurnAttachment } from "../../acp/control-plane/manager.types.js";
import { resolveAcpAgentPolicyError, resolveAcpDispatchPolicyError } from "../../acp/policy.js";
import { AcpRuntimeError, toAcpRuntimeError } from "../../acp/runtime/errors.js";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { sessionFileHasMemoryBoundaryContent } from "../../agents/command/attempt-execution.helpers.js";
import type { ChatType } from "../../channels/chat-type.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
  updateSessionStore,
  type SessionEntry,
} from "../../config/sessions.js";
import { resolveSessionTranscriptFile } from "../../config/sessions/transcript-resolve.runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { revokeAttachGrantsForSession } from "../../gateway/mcp-grant-store.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { markDiagnosticSessionProgress } from "../../logging/diagnostic.js";
import {
  stripExtractedFileImageMetadata,
  type ExtractedFileImage,
} from "../../media-understanding/extracted-file-images.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveSessionEntryChatType } from "../../sessions/session-chat-type-shared.js";
import {
  resolveLongTermMemoryRuntimePolicyContext,
  resolveSessionMemoryBoundaryPlan,
  type LongTermMemoryRuntimePolicyContext,
} from "../../sessions/session-memory-policy.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveStatusTtsSnapshot } from "../../tts/status-config.js";
import { resolveConfiguredTtsMode } from "../../tts/tts-config.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { markReplyPayloadAsTtsSupplement } from "../reply-payload.js";
import type { FinalizedMsgContext } from "../templating.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import {
  loadAgentTurnMediaRuntime,
  resolveAgentTurnAttachments,
  resolveInlineAgentImageAttachments,
} from "./agent-turn-attachments.js";
import { resolveFirstContextText } from "./context-text.js";
import {
  createAcpDispatchDeliveryCoordinator,
  type AcpDispatchDeliveryCoordinator,
} from "./dispatch-acp-delivery.js";
import { appendRecentHistoryImageContext } from "./history-media.js";
import { hasInboundMediaForUnderstanding } from "./inbound-media.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

const dispatchAcpManagerRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-manager.runtime.js"),
);

type OrderedAcpAttachment = {
  attachment: AcpTurnAttachment;
  sourceIndex?: number;
  sequence: number;
};

function appendOrderedAcpAttachments(params: {
  entries: OrderedAcpAttachment[];
  attachments: AcpTurnAttachment[];
  sourceIndexes?: number[];
}) {
  for (const [index, attachment] of params.attachments.entries()) {
    params.entries.push({
      attachment,
      sourceIndex: params.sourceIndexes?.[index],
      sequence: params.entries.length,
    });
  }
}

function resolveMergedAcpAttachments(entries: OrderedAcpAttachment[]): AcpTurnAttachment[] {
  return entries
    .toSorted((left, right) => {
      if (left.sourceIndex !== undefined && right.sourceIndex !== undefined) {
        return left.sourceIndex - right.sourceIndex || left.sequence - right.sequence;
      }
      if (left.sourceIndex !== undefined || right.sourceIndex !== undefined) {
        return left.sequence - right.sequence;
      }
      return left.sequence - right.sequence;
    })
    .map((entry) => entry.attachment);
}
const dispatchAcpSessionRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-session.runtime.js"),
);
const dispatchAcpTtsRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-tts.runtime.js"),
);
const dispatchAcpTranscriptRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-transcript.runtime.js"),
);

function loadDispatchAcpManagerRuntime() {
  return dispatchAcpManagerRuntimeLoader.load();
}

function loadDispatchAcpSessionRuntime() {
  return dispatchAcpSessionRuntimeLoader.load();
}

function loadDispatchAcpTtsRuntime() {
  return dispatchAcpTtsRuntimeLoader.load();
}

function loadDispatchAcpTranscriptRuntime() {
  return dispatchAcpTranscriptRuntimeLoader.load();
}

type DispatchProcessedRecorder = (
  outcome: "completed" | "skipped" | "error",
  opts?: {
    reason?: string;
    error?: string;
  },
) => void;

function resolveAcpPromptText(ctx: FinalizedMsgContext): string {
  return resolveFirstContextText(ctx, [
    "BodyForAgent",
    "BodyForCommands",
    "CommandBody",
    "RawBody",
    "Body",
  ]).trim();
}

function resolveAcpRequestId(ctx: FinalizedMsgContext): string {
  const id = ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  if (typeof id === "string") {
    const normalizedId = normalizeOptionalString(id);
    if (normalizedId) {
      return normalizedId;
    }
  }
  if (typeof id === "number" || typeof id === "bigint") {
    return String(id);
  }
  return generateSecureUuid();
}

function resolveAcpTurnText(params: {
  promptText: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): string {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return params.promptText;
  }
  const guidance = prefixSystemMessage(
    [
      "Source channel delivery is private by default for this turn.",
      "Normal ACP final output will not be automatically posted to the source channel.",
      "To send visible output, use message(action=send). The target defaults to the current source channel.",
    ].join(" "),
  );
  return params.promptText ? `${guidance}\n\n${params.promptText}` : guidance;
}

function isRestrictiveRuntimeToolsAllow(toolsAllow: string[] | undefined): boolean {
  if (toolsAllow === undefined) {
    return false;
  }
  return !toolsAllow.some((entry) => normalizeLowercaseStringOrEmpty(entry) === "*");
}

async function hasBoundConversationForSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  channelRaw: string | undefined;
  accountIdRaw: string | undefined;
}): Promise<boolean> {
  const channel = normalizeOptionalLowercaseString(params.channelRaw) ?? "";
  if (!channel) {
    return false;
  }
  const accountId = normalizeOptionalLowercaseString(params.accountIdRaw) ?? "";
  const channels = params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>;
  const configuredDefaultAccountId = channels?.[channel]?.defaultAccount;
  const normalizedAccountId =
    accountId || normalizeOptionalLowercaseString(configuredDefaultAccountId) || "default";
  const { getSessionBindingService } = await loadDispatchAcpManagerRuntime();
  const bindingService = getSessionBindingService();
  const bindings = bindingService.listBySession(params.sessionKey);
  return bindings.some((binding) => {
    const bindingChannel = normalizeOptionalLowercaseString(binding.conversation.channel) ?? "";
    const bindingAccountId = normalizeOptionalLowercaseString(binding.conversation.accountId) ?? "";
    const conversationId = normalizeOptionalString(binding.conversation.conversationId) ?? "";
    return (
      bindingChannel === channel &&
      (bindingAccountId || "default") === normalizedAccountId &&
      conversationId.length > 0
    );
  });
}

async function prepareAcpDispatchSessionMemoryBoundary(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storeEntry: AcpSessionStoreEntry | null;
  memoryPolicy: LongTermMemoryRuntimePolicyContext;
}): Promise<void> {
  if (!params.storeEntry?.entry?.sessionId) {
    return;
  }
  const sessionAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const storePath =
    params.storeEntry.storePath ??
    resolveStorePath(params.cfg.session?.store, {
      agentId: sessionAgentId,
    });
  const sessionStore = loadSessionStore(storePath, { skipCache: true });
  const currentEntry = resolveSessionStoreEntry({
    store: sessionStore,
    sessionKey: params.sessionKey,
  }).existing;
  if (!currentEntry) {
    throw new Error("Session memory boundary changed during ACP setup; retry the request.");
  }
  const resolvedTranscript = await resolveSessionTranscriptFile({
    sessionId: currentEntry.sessionId,
    sessionKey: params.sessionKey,
    sessionStore,
    storePath,
    sessionEntry: currentEntry,
    agentId: sessionAgentId,
  });
  const resolvedEntry = resolvedTranscript.sessionEntry;
  if (!resolvedEntry) {
    throw new Error("Session memory boundary changed during ACP setup; retry the request.");
  }
  const plan = resolveSessionMemoryBoundaryPlan({
    currentEntry: resolvedEntry,
    sessionKey: params.sessionKey,
    sessionFile: resolvedTranscript.sessionFile,
    storedChatType: resolveSessionEntryChatType(resolvedEntry),
    hasPersistedTranscriptContent: await sessionFileHasMemoryBoundaryContent(
      resolvedTranscript.sessionFile,
    ),
    runMemoryPolicy: params.memoryPolicy.longTermMemoryDefaultPolicy,
    runMemoryChatType: params.memoryPolicy.chatType,
  });
  if (!plan) {
    return;
  }

  const now = Date.now();
  const updateResult = await updateSessionStore(
    storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
      const writerEntry = resolved.existing;
      if (
        !writerEntry ||
        writerEntry.sessionId !== plan.currentEntry.sessionId ||
        writerEntry.sessionFile !== plan.expectedSessionFile ||
        writerEntry.longTermMemoryDefaultPolicy !== plan.expectedPolicy
      ) {
        return null;
      }
      const nextEntry: SessionEntry = {
        ...writerEntry,
        sessionId: plan.nextSessionId,
        sessionFile: plan.nextSessionFile,
        longTermMemoryDefaultPolicy: plan.runMemoryPolicy,
        updatedAt: now,
        sessionStartedAt: writerEntry.sessionStartedAt ?? now,
      };
      store[resolved.normalizedKey] = nextEntry;
      return { entry: nextEntry, sessionKey: resolved.normalizedKey };
    },
    {
      skipSaveWhenResult: (result) => result === null,
      resolveSingleEntryPersistence: (result) =>
        result
          ? {
              sessionKey: result.sessionKey,
              entry: result.entry,
            }
          : undefined,
    },
  );
  const updateMatchesMemoryBoundary =
    updateResult?.entry.sessionId === plan.nextSessionId &&
    updateResult?.entry.sessionFile === plan.nextSessionFile &&
    updateResult?.entry.longTermMemoryDefaultPolicy === plan.runMemoryPolicy;
  if (!updateMatchesMemoryBoundary) {
    throw new Error("Session memory boundary changed during ACP setup; retry the request.");
  }
  const localResolved = resolveSessionStoreEntry({
    store: sessionStore,
    sessionKey: params.sessionKey,
  });
  sessionStore[localResolved.normalizedKey] = updateResult.entry;
  revokeAttachGrantsForSession(params.sessionKey);
}

export type AcpDispatchAttemptResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

type AcpDispatchStatsSnapshot = {
  turns: { queueDepth: number };
  runtimeCache: { activeSessions: number };
};
type AcpDispatchOutcome = { kind: "ok" } | { kind: "error"; error: AcpRuntimeError };

function finishAcpDispatchAttempt(params: {
  queuedFinal: boolean;
  dispatcher: ReplyDispatcher;
  delivery: AcpDispatchDeliveryCoordinator;
  getStats: () => AcpDispatchStatsSnapshot;
  sessionKey: string;
  runId?: string;
  startedAt: number;
  outcome: AcpDispatchOutcome;
  lifecyclePhase?: "end" | "error";
  recordProcessed: DispatchProcessedRecorder;
  markIdle: (reason: string) => void;
}): AcpDispatchAttemptResult {
  const counts = params.dispatcher.getQueuedCounts();
  params.delivery.applyRoutedCounts(counts);
  const acpStats = params.getStats();
  const runId = normalizeOptionalString(params.runId);
  if (runId && params.lifecyclePhase) {
    emitAgentEvent({
      runId,
      sessionKey: params.sessionKey,
      stream: "lifecycle",
      data: {
        phase: params.lifecyclePhase,
        startedAt: params.startedAt,
        endedAt: Date.now(),
        ...(params.outcome.kind === "error" ? { error: params.outcome.error.message } : {}),
      },
    });
  }
  if (params.outcome.kind === "ok") {
    logVerbose(
      `acp-dispatch: session=${params.sessionKey} outcome=ok latencyMs=${Date.now() - params.startedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`,
    );
    params.recordProcessed("completed", { reason: "acp_dispatch" });
  } else {
    logVerbose(
      `acp-dispatch: session=${params.sessionKey} outcome=error code=${params.outcome.error.code} latencyMs=${Date.now() - params.startedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`,
    );
    params.recordProcessed("completed", {
      reason: `acp_error:${normalizeLowercaseStringOrEmpty(params.outcome.error.code)}`,
    });
  }
  params.markIdle("message_completed");
  return { queuedFinal: params.queuedFinal, counts };
}

const ACP_STALE_BINDING_UNBIND_REASON = "acp-session-init-failed";

function isStaleSessionInitError(params: { code: string; message: string }): boolean {
  if (params.code !== "ACP_SESSION_INIT_FAILED") {
    return false;
  }
  return /(ACP (session )?metadata is missing|missing ACP metadata|Session is not ACP-enabled|Resource not found)/i.test(
    params.message,
  );
}

async function maybeUnbindStaleBoundConversations(params: {
  targetSessionKey: string;
  error: { code: string; message: string };
}): Promise<void> {
  if (!isStaleSessionInitError(params.error)) {
    return;
  }
  try {
    const { getSessionBindingService } = await loadDispatchAcpManagerRuntime();
    const removed = await getSessionBindingService().unbind({
      targetSessionKey: params.targetSessionKey,
      reason: ACP_STALE_BINDING_UNBIND_REASON,
    });
    if (removed.length > 0) {
      logVerbose(
        `dispatch-acp: removed ${removed.length} stale bound conversation(s) for ${params.targetSessionKey} after ${params.error.code}: ${params.error.message}`,
      );
    }
  } catch (error) {
    logVerbose(
      `dispatch-acp: failed to unbind stale bound conversations for ${params.targetSessionKey}: ${formatErrorMessage(error)}`,
    );
  }
}

async function finalizeAcpTurnOutput(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  delivery: AcpDispatchDeliveryCoordinator;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  ttsAccountId?: string;
  shouldEmitResolvedIdentityNotice: boolean;
}): Promise<boolean> {
  await params.delivery.settleVisibleText();
  let queuedFinal =
    params.delivery.hasDeliveredVisibleText() && !params.delivery.hasFailedVisibleTextDelivery();
  const ttsMode = resolveConfiguredTtsMode(params.cfg, {
    agentId: params.agentId,
    channelId: params.ttsChannel,
    accountId: params.ttsAccountId,
  });
  const accumulatedVisibleBlockText = params.delivery.getAccumulatedVisibleBlockText();
  const accumulatedBlockTtsText = params.delivery.getAccumulatedBlockTtsText();
  const hasAccumulatedBlockText = accumulatedBlockTtsText.trim().length > 0;
  const ttsStatus = resolveStatusTtsSnapshot({
    cfg: params.cfg,
    sessionAuto: params.sessionTtsAuto,
    agentId: params.agentId,
    channelId: params.ttsChannel,
    accountId: params.ttsAccountId,
  });
  const canAttemptFinalTts =
    ttsStatus != null && !(ttsStatus.autoMode === "inbound" && !params.inboundAudio);

  let finalMediaDelivered = false;
  if (ttsMode === "final" && hasAccumulatedBlockText && canAttemptFinalTts) {
    try {
      const { maybeApplyTtsToPayload } = await loadDispatchAcpTtsRuntime();
      const ttsSyntheticReply = await maybeApplyTtsToPayload({
        payload: { text: accumulatedBlockTtsText },
        cfg: params.cfg,
        channel: params.ttsChannel,
        kind: "final",
        inboundAudio: params.inboundAudio,
        ttsAuto: params.sessionTtsAuto,
        agentId: params.agentId,
        accountId: params.ttsAccountId,
      });
      if (ttsSyntheticReply.mediaUrl) {
        const delivered = await params.delivery.deliver(
          "final",
          markReplyPayloadAsTtsSupplement(
            {
              mediaUrl: ttsSyntheticReply.mediaUrl,
              audioAsVoice: ttsSyntheticReply.audioAsVoice,
              spokenText: accumulatedBlockTtsText,
              trustedLocalMedia: true,
            },
            accumulatedBlockTtsText,
            { visibleTextAlreadyDelivered: true },
          ),
        );
        queuedFinal = queuedFinal || delivered;
        finalMediaDelivered = delivered;
      }
    } catch (err) {
      logVerbose(`dispatch-acp: accumulated ACP block TTS failed: ${formatErrorMessage(err)}`);
    }
  }

  // Some ACP parent surfaces only expose terminal replies, so block routing alone is not enough
  // to prove the final result was visible to the user.
  const shouldDeliverTextFallback =
    ttsMode !== "all" &&
    accumulatedVisibleBlockText.trim().length > 0 &&
    !finalMediaDelivered &&
    !params.delivery.hasDeliveredFinalReply() &&
    (!params.delivery.hasDeliveredVisibleText() || params.delivery.hasFailedVisibleTextDelivery());
  if (shouldDeliverTextFallback) {
    const delivered = await params.delivery.deliver(
      "final",
      { text: accumulatedVisibleBlockText },
      { skipTts: true },
    );
    queuedFinal = queuedFinal || delivered;
  }

  if (params.shouldEmitResolvedIdentityNotice) {
    const { readAcpSessionEntry } = await loadDispatchAcpSessionRuntime();
    const currentMeta = readAcpSessionEntry({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    })?.acp;
    const identityAfterTurn = resolveSessionIdentityFromMeta(currentMeta);
    if (!isSessionIdentityPending(identityAfterTurn)) {
      const resolvedDetails = resolveAcpThreadSessionDetailLines({
        sessionKey: params.sessionKey,
        meta: currentMeta,
      });
      if (resolvedDetails.length > 0) {
        const delivered = await params.delivery.deliver("final", {
          text: prefixSystemMessage(["Session ids resolved.", ...resolvedDetails].join("\n")),
        });
        queuedFinal = queuedFinal || delivered;
      }
    }
  }

  return queuedFinal;
}

export async function tryDispatchAcpReply(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  runId?: string;
  sessionKey?: string;
  toolsAllow?: string[];
  images?: Array<{ data: string; mimeType: string }>;
  extractedFileImages?: ExtractedFileImage[];
  abortSignal?: AbortSignal;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  suppressUserDelivery?: boolean;
  suppressReplyLifecycle?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
  originatingChatType?: ChatType;
  shouldSendToolSummaries: boolean;
  shouldSendToolSummariesNow?: () => boolean;
  bypassForCommand: boolean;
  onReplyStart?: () => Promise<void> | void;
  recordProcessed: DispatchProcessedRecorder;
  markIdle: (reason: string) => void;
}): Promise<AcpDispatchAttemptResult | null> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey || params.bypassForCommand) {
    return null;
  }

  const { getAcpSessionManager } = await loadDispatchAcpManagerRuntime();
  const acpManager = getAcpSessionManager();
  const acpResolution = acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey,
  });
  if (acpResolution.kind === "none") {
    return null;
  }
  const canonicalSessionKey = acpResolution.sessionKey;
  const acpAgentId = resolveAgentIdFromSessionKey(canonicalSessionKey);
  const progressSessionKeys = isDiagnosticsEnabled(params.cfg)
    ? Array.from(
        new Set(
          [params.ctx.SessionKey, sessionKey, canonicalSessionKey]
            .map((key) => normalizeOptionalString(key))
            .filter((key): key is string => Boolean(key)),
        ),
      )
    : [];
  const markAcpProgress =
    progressSessionKeys.length > 0
      ? () => {
          for (const key of progressSessionKeys) {
            markDiagnosticSessionProgress({ sessionKey: key });
          }
        }
      : undefined;

  let queuedFinal = false;
  const delivery = createAcpDispatchDeliveryCoordinator({
    cfg: params.cfg,
    agentId: acpAgentId,
    ctx: params.ctx,
    dispatcher: params.dispatcher,
    inboundAudio: params.inboundAudio,
    sessionKey: canonicalSessionKey,
    sessionTtsAuto: params.sessionTtsAuto,
    ttsChannel: params.ttsChannel,
    suppressUserDelivery: params.suppressUserDelivery,
    suppressReplyLifecycle: params.suppressReplyLifecycle,
    shouldRouteToOriginating: params.shouldRouteToOriginating,
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    originatingAccountId: params.originatingAccountId,
    originatingThreadId: params.originatingThreadId,
    originatingChatType: params.originatingChatType,
    onReplyStart: params.onReplyStart,
    abortSignal: params.abortSignal,
    runId: params.runId,
  });

  const identityPendingBeforeTurn = isSessionIdentityPending(
    resolveSessionIdentityFromMeta(acpResolution.kind === "ready" ? acpResolution.meta : undefined),
  );
  const shouldEmitResolvedIdentityNotice =
    !params.suppressUserDelivery &&
    identityPendingBeforeTurn &&
    (Boolean(
      params.ctx.MessageThreadId != null &&
      (normalizeOptionalString(String(params.ctx.MessageThreadId)) ?? ""),
    ) ||
      (await hasBoundConversationForSession({
        cfg: params.cfg,
        sessionKey: canonicalSessionKey,
        channelRaw: params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
        accountIdRaw: params.ctx.AccountId,
      })));

  const resolvedAcpAgent =
    acpResolution.kind === "ready"
      ? (normalizeOptionalString(acpResolution.meta.agent) ??
        normalizeOptionalString(params.cfg.acp?.defaultAgent) ??
        resolveAgentIdFromSessionKey(canonicalSessionKey))
      : resolveAgentIdFromSessionKey(canonicalSessionKey);
  const normalizedDispatchChannel = normalizeOptionalLowercaseString(
    params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
  );
  const explicitDispatchAccountId = normalizeOptionalString(params.ctx.AccountId);
  const dispatchChannels = params.cfg.channels as
    | Record<string, { defaultAccount?: unknown } | undefined>
    | undefined;
  const defaultDispatchAccount =
    normalizedDispatchChannel == null
      ? undefined
      : dispatchChannels?.[normalizedDispatchChannel]?.defaultAccount;
  const effectiveDispatchAccountId =
    explicitDispatchAccountId ?? normalizeOptionalString(defaultDispatchAccount);
  const projector = createAcpReplyProjector({
    cfg: params.cfg,
    shouldSendToolSummaries: params.shouldSendToolSummaries,
    shouldSendToolSummariesNow: params.shouldSendToolSummariesNow,
    deliver: delivery.deliver,
    onProgress: markAcpProgress,
    provider: params.ctx.Surface ?? params.ctx.Provider,
    accountId: effectiveDispatchAccountId,
  });

  const acpDispatchStartedAt = Date.now();
  const finishAttempt = (options: {
    queuedFinal: boolean;
    outcome: AcpDispatchOutcome;
    lifecyclePhase?: "end" | "error";
  }) =>
    finishAcpDispatchAttempt({
      ...options,
      dispatcher: params.dispatcher,
      delivery,
      getStats: () => acpManager.getObservabilitySnapshot(params.cfg),
      sessionKey,
      runId: params.runId,
      startedAt: acpDispatchStartedAt,
      recordProcessed: params.recordProcessed,
      markIdle: params.markIdle,
    });
  try {
    const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
    if (dispatchPolicyError) {
      throw dispatchPolicyError;
    }
    if (isRestrictiveRuntimeToolsAllow(params.toolsAllow)) {
      throw new AcpRuntimeError(
        "ACP_DISPATCH_DISABLED",
        "ACP dispatch cannot enforce runtime toolsAllow for this session; use an embedded runtime for restricted tool policy.",
      );
    }
    if (acpResolution.kind === "stale") {
      await maybeUnbindStaleBoundConversations({
        targetSessionKey: canonicalSessionKey,
        error: acpResolution.error,
      });
      const delivered = await delivery.deliver("final", {
        text: formatAcpRuntimeErrorText(acpResolution.error),
        isError: true,
      });
      return finishAttempt({
        queuedFinal: delivered,
        outcome: { kind: "error", error: acpResolution.error },
      });
    }
    const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, resolvedAcpAgent);
    if (agentPolicyError) {
      throw agentPolicyError;
    }
    let extractedFileImages = params.extractedFileImages ?? [];
    if (hasInboundMediaForUnderstanding(params.ctx) && !params.ctx.MediaUnderstanding?.length) {
      try {
        const { applyMediaUnderstanding } = await loadAgentTurnMediaRuntime();
        const mediaResult = await applyMediaUnderstanding({
          ctx: params.ctx,
          cfg: params.cfg,
          agentId: acpAgentId,
          agentDir: resolveAgentDir(params.cfg, acpAgentId),
          workspaceDir: resolveAgentWorkspaceDir(params.cfg, acpAgentId),
        });
        if (mediaResult.extractedFileImages.length > 0) {
          extractedFileImages = [...extractedFileImages, ...mediaResult.extractedFileImages];
        }
      } catch (err) {
        logVerbose(
          `dispatch-acp: media understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
        );
      }
    }

    const promptText = resolveAcpPromptText(params.ctx);
    const resolvedTurnAttachments = await resolveAgentTurnAttachments({
      ctx: params.ctx,
      cfg: params.cfg,
      includeAttachmentIndexes: true,
    });
    const mediaAttachments = resolvedTurnAttachments.attachments;
    const inlineAttachments = resolveInlineAgentImageAttachments(params.images);
    const extractedAttachments = resolveInlineAgentImageAttachments(
      extractedFileImages.map(stripExtractedFileImageMetadata),
    );
    const mediaAttachmentsAreOnlyRecentHistory =
      mediaAttachments.length > 0 &&
      mediaAttachments.length === resolvedTurnAttachments.recentHistoryImages.length;
    const useMediaAttachments =
      mediaAttachments.length > 0 &&
      !(
        mediaAttachmentsAreOnlyRecentHistory &&
        (inlineAttachments.length > 0 || extractedAttachments.length > 0)
      );
    const attachmentEntries: OrderedAcpAttachment[] = [];
    if (useMediaAttachments) {
      appendOrderedAcpAttachments({
        entries: attachmentEntries,
        attachments: mediaAttachments,
        sourceIndexes: resolvedTurnAttachments.attachmentIndexes,
      });
    } else {
      appendOrderedAcpAttachments({
        entries: attachmentEntries,
        attachments: inlineAttachments,
      });
    }
    appendOrderedAcpAttachments({
      entries: attachmentEntries,
      attachments: extractedAttachments,
      sourceIndexes: extractedFileImages.map((image) => image.attachmentIndex),
    });
    const attachments = resolveMergedAcpAttachments(attachmentEntries);
    const turnPromptText = useMediaAttachments
      ? appendRecentHistoryImageContext({
          promptText,
          images: resolvedTurnAttachments.recentHistoryImages,
        })
      : promptText;
    if (!turnPromptText && attachments.length === 0) {
      const counts = params.dispatcher.getQueuedCounts();
      delivery.applyRoutedCounts(counts);
      params.recordProcessed("completed", { reason: "acp_empty_prompt" });
      params.markIdle("message_completed");
      return { queuedFinal: false, counts };
    }

    try {
      await delivery.startReplyLifecycle();
    } catch (error) {
      logVerbose(`dispatch-acp: start reply lifecycle failed: ${formatErrorMessage(error)}`);
    }

    const { readAcpSessionEntry } = await loadDispatchAcpSessionRuntime();
    const acpSessionStoreEntry = readAcpSessionEntry({
      cfg: params.cfg,
      sessionKey: canonicalSessionKey,
    });
    if (acpSessionStoreEntry?.storeReadFailed) {
      throw new Error("ACP session memory boundary could not be read; retry the request.");
    }
    const memoryPolicy = resolveLongTermMemoryRuntimePolicyContext({
      sessionKey: canonicalSessionKey,
      liveChatType: params.originatingChatType ?? params.ctx.ChatType,
      storedChatType: resolveSessionEntryChatType(acpSessionStoreEntry?.entry),
      longTermMemoryDefaultPolicy: acpSessionStoreEntry?.entry?.longTermMemoryDefaultPolicy,
    });
    await prepareAcpDispatchSessionMemoryBoundary({
      cfg: params.cfg,
      sessionKey: canonicalSessionKey,
      storeEntry: acpSessionStoreEntry,
      memoryPolicy,
    });

    await acpManager.runTurn({
      cfg: params.cfg,
      sessionKey: canonicalSessionKey,
      text: resolveAcpTurnText({
        promptText: turnPromptText,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      }),
      attachments: attachments.length > 0 ? attachments : undefined,
      mode: "prompt",
      requestId: resolveAcpRequestId(params.ctx),
      ...(params.abortSignal ? { signal: params.abortSignal } : {}),
      memoryPolicy,
      onEvent: async (event) => await projector.onEvent(event),
    });

    await projector.flush(true);
    if (params.abortSignal?.aborted) {
      const counts = params.dispatcher.getQueuedCounts();
      delivery.applyRoutedCounts(counts);
      params.recordProcessed("completed", { reason: "acp_aborted" });
      params.markIdle("message_aborted");
      return { queuedFinal, counts };
    }
    try {
      const { persistAcpDispatchTranscript } = await loadDispatchAcpTranscriptRuntime();
      await persistAcpDispatchTranscript({
        cfg: params.cfg,
        sessionKey: canonicalSessionKey,
        promptText: turnPromptText,
        finalText: delivery.getAccumulatedFinalText() || delivery.getAccumulatedBlockText(),
        meta: acpResolution.meta,
        threadId: params.ctx.MessageThreadId,
      });
    } catch (error) {
      logVerbose(
        `dispatch-acp: transcript persistence failed for ${canonicalSessionKey}: ${formatErrorMessage(
          error,
        )}`,
      );
    }
    queuedFinal =
      (await finalizeAcpTurnOutput({
        cfg: params.cfg,
        sessionKey: canonicalSessionKey,
        agentId: acpAgentId,
        delivery,
        inboundAudio: params.inboundAudio,
        sessionTtsAuto: params.sessionTtsAuto,
        ttsChannel: params.ttsChannel,
        ttsAccountId: effectiveDispatchAccountId,
        shouldEmitResolvedIdentityNotice,
      })) || queuedFinal;

    return finishAttempt({
      queuedFinal,
      outcome: { kind: "ok" },
      lifecyclePhase: "end",
    });
  } catch (err) {
    await projector.flush(true);
    const acpError = toAcpRuntimeError({
      error: err,
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "ACP turn failed before completion.",
    });
    await maybeUnbindStaleBoundConversations({
      targetSessionKey: canonicalSessionKey,
      error: acpError,
    });
    const delivered = await delivery.deliver("final", {
      text: formatAcpRuntimeErrorText(acpError),
      isError: true,
    });
    queuedFinal = queuedFinal || delivered;
    return finishAttempt({
      queuedFinal,
      outcome: { kind: "error", error: acpError },
      lifecyclePhase: "error",
    });
  }
}
