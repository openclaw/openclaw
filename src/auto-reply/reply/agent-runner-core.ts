import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasSessionAutoModelFallbackProvenance } from "../../agents/agent-scope.js";
import { hasVisibleCommittedMessagingToolDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { MODEL_FALLBACK_SKIPPED_CODE } from "../../agents/model-fallback.types.js";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import { areRuntimeModelRefsEquivalent } from "../../agents/model-runtime-aliases.js";
import {
  observeReplyDelivery,
  type ReplyCompletion,
  type ReplyDeliveryObserver,
  type ReplyDeliveryState,
  type ReplyExpectation,
} from "../../agents/reply-completion.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { isRestartRecoveryClaimChangedError } from "../../infra/agent-lifecycle-error.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import {
  type DeliveryContext,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { resolveFallbackTransition } from "../fallback-state.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type {
  ReplyAgentTurnContext,
  RuntimeFallbackAttempt,
} from "./agent-runner-execution.types.js";
import {
  buildKnownAgentRunFailureReplyPayload,
  buildTerminalAgentRunFailureReplyPayload,
} from "./agent-runner-failure-reply.js";
import { hasBlockReplyDeliveryCustody } from "./block-reply-delivery.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";
import { sanitizePendingFinalDeliveryText } from "./pending-final-delivery-state.js";
import {
  type FollowupRun,
  kickFollowupDrainIfIdle,
  type QueueSettings,
  scheduleFollowupDrain,
} from "./queue.js";
import { normalizeReplyPayloadDirectives, type DirectBlockDelivery } from "./reply-delivery.js";
import {
  buildRestartLifecycleReplyText,
  isReplyOperationSuperseded,
  resolveReplyOperationAbortReason,
} from "./reply-operation-abort.js";
import { type ReplyOperation, runAfterReplyOperationClear } from "./reply-run-registry.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { resolveSourceReplyVisibilityPolicy } from "./source-reply-delivery-mode.js";
import type { TypingController } from "./typing.js";
export const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;

export function scheduleFollowupDrainAfterReplyOperationClear(params: {
  operation: ReplyOperation;
  queueKey: string;
  runFollowup: (run: FollowupRun) => Promise<void>;
}): void {
  runAfterReplyOperationClear(params.operation, (admissionSessionId) => {
    const completedSessionId = params.operation.sessionId;
    const runFollowupAfterClear =
      admissionSessionId === completedSessionId
        ? params.runFollowup
        : (queued: FollowupRun) =>
            params.runFollowup(
              queued.run.sessionId === completedSessionId
                ? { ...queued, admissionSessionId }
                : queued,
            );
    scheduleFollowupDrain(params.queueKey, runFollowupAfterClear);
  });
}

export function markBeforeAgentRunBlockedPayloads(payloads: ReplyPayload[]): ReplyPayload[] {
  return payloads.map((payload) =>
    setReplyPayloadMetadata(payload, { beforeAgentRunBlocked: true }),
  );
}

export function buildSilentFallbackFailurePayload(params: {
  fallbackTransition: ReturnType<typeof resolveFallbackTransition>;
  fallbackFailureKnown: boolean;
  fallbackAttempts: readonly RuntimeFallbackAttempt[];
  cfg: OpenClawConfig;
  completion: ReplyCompletion;
}): ReplyPayload | undefined {
  if (
    params.completion.outcome !== "missing" ||
    !params.fallbackTransition.fallbackActive ||
    !params.fallbackFailureKnown
  ) {
    return undefined;
  }
  const selected = params.fallbackTransition.selectedModelRef;
  const active = params.fallbackTransition.activeModelRef;
  const attempts = params.fallbackAttempts;
  const selectedAttempts = attempts.filter((attempt) =>
    areRuntimeModelRefsEquivalent(`${attempt.provider}/${attempt.model}`, selected, {
      config: params.cfg,
    }),
  );
  let primary = `⚠️ The configured model backend ${selected} produced no usable reply. `;
  // Local skips retain old failure reasons, not evidence of a new backend attempt.
  if (
    selectedAttempts.length > 0 &&
    selectedAttempts.every((attempt) => attempt.code !== MODEL_FALLBACK_SKIPPED_CODE) &&
    attempts.every((attempt) => attempt.provider.trim() && attempt.model.trim())
  ) {
    if (
      selectedAttempts.every(({ reason }) =>
        ["timeout", "server_error", "overloaded", "tls_certificate"].includes(reason),
      )
    ) {
      primary = `⚠️ I couldn't reach the configured model backend ${selected}. `;
    } else if (
      selectedAttempts.every(({ reason }) => reason === "format" || reason === "empty_response")
    ) {
      primary = `⚠️ The configured model backend ${selected} responded but produced no usable reply. `;
    }
  }
  return markReplyPayloadForSourceSuppressionDelivery({
    text: `${primary}Fallback used ${active}, but it produced no visible reply.`,
    isError: true,
  });
}

export function resolveSourceReplyPolicy(params: {
  cfg: OpenClawConfig;
  sessionCtx: TemplateContext;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  runtimePolicySessionKey?: string;
  opts?: GetReplyOptions;
}): ReturnType<typeof resolveSourceReplyVisibilityPolicy> {
  const sendPolicy = resolveSendPolicy({
    cfg: params.cfg,
    entry: params.sessionEntry,
    sessionKey: params.runtimePolicySessionKey ?? params.sessionKey,
    channel:
      params.sessionCtx.OriginatingChannel ??
      params.sessionCtx.Surface ??
      params.sessionCtx.Provider ??
      sessionDeliveryChannel(params.sessionEntry),
    chatType: params.sessionEntry?.chatType,
  });
  return resolveSourceReplyVisibilityPolicy({
    cfg: params.cfg,
    ctx: params.sessionCtx,
    requested: params.opts?.sourceReplyDeliveryMode,
    sendPolicy,
  });
}

export function resolveReplyRunDeliveryContext(
  params: Parameters<typeof resolveSourceReplyPolicy>[0],
): DeliveryContext | undefined {
  const sourceReplyPolicy = resolveSourceReplyPolicy(params);
  if (
    params.sessionCtx.InboundEventKind === "room_event" ||
    sourceReplyPolicy.sendPolicyDenied ||
    (sourceReplyPolicy.suppressDelivery &&
      sourceReplyPolicy.sourceReplyDeliveryMode !== "message_tool_only")
  ) {
    return undefined;
  }
  return normalizeDeliveryContext({
    ...resolveEffectiveReplyRoute({
      ctx: params.sessionCtx,
      entry: params.sessionEntry,
    }),
    threadId: resolveRoutedDeliveryThreadId({
      ctx: params.sessionCtx,
      sessionKey: params.sessionCtx.SessionKey ?? params.sessionKey,
    }),
  });
}

export function hasSuccessfulSourceReplyDelivery(params: {
  blockReplyPipeline: { didStream: () => boolean; isAborted: () => boolean } | null;
  hasDirectlySentBlockReply?: boolean;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: unknown[];
}): boolean {
  return (
    params.blockReplyPipeline?.didStream() ||
    params.hasDirectlySentBlockReply === true ||
    hasVisibleCommittedMessagingToolDeliveryEvidence(params)
  );
}

export async function resolveTerminalReplyDelivery(params: {
  blockReplyPipeline?: BlockReplyPipeline | null;
  directBlockDeliveries?: DirectBlockDelivery[];
  minimumAssistantMessageIndex?: number;
  resolveReplyDelivery?: ReplyDeliveryObserver;
  sourceReplyDeliveryState?: ReplyDeliveryState;
}): Promise<ReplyDeliveryState> {
  if (
    params.sourceReplyDeliveryState === "delivered" ||
    params.sourceReplyDeliveryState === "pending"
  ) {
    return params.sourceReplyDeliveryState;
  }
  const { blockReplyPipeline, minimumAssistantMessageIndex = 0 } = params;
  if (params.sourceReplyDeliveryState === undefined) {
    await blockReplyPipeline?.flush({ force: true });
  }
  const sourceDelivery = await observeReplyDelivery(
    params.resolveReplyDelivery,
    minimumAssistantMessageIndex,
    (error) => logVerbose(`reply delivery observation failed; retaining custody: ${String(error)}`),
  );
  if (sourceDelivery === "delivered" || params.sourceReplyDeliveryState !== undefined) {
    return sourceDelivery;
  }
  let pending =
    sourceDelivery === "pending" ||
    blockReplyPipeline?.hasRetryBlockedTerminalDelivery?.(minimumAssistantMessageIndex) === true;
  for (const delivery of params.directBlockDeliveries ?? []) {
    if (
      (getReplyPayloadMetadata(delivery.payload)?.assistantMessageIndex ?? 0) <
        minimumAssistantMessageIndex ||
      !isReplyPayloadTerminalContent(delivery.payload)
    ) {
      continue;
    }
    if (delivery.terminalDeliveryConfirmed) {
      return "delivered";
    }
    pending ||= hasBlockReplyDeliveryCustody(delivery);
  }
  return blockReplyPipeline?.didStreamTerminalReply?.(minimumAssistantMessageIndex)
    ? "delivered"
    : pending
      ? "pending"
      : "missing";
}

export function resolveFallbackOriginModel(params: {
  run: FollowupRun["run"];
  fallbackStateEntry?: SessionEntry;
  runtimeModelSelection?: ModelRef;
}): { provider: string; model: string; persistedAutoFallback: boolean } {
  // Runtime-owned selection is not a fallback from the caller's nominal model.
  if (params.runtimeModelSelection) {
    return { ...params.runtimeModelSelection, persistedAutoFallback: false };
  }
  const entry = params.fallbackStateEntry;
  const isAutoFallbackOverride =
    entry?.modelOverrideSource === "auto" ||
    (entry !== undefined &&
      entry.modelOverrideSource === undefined &&
      hasSessionAutoModelFallbackProvenance(entry));
  if (isAutoFallbackOverride && entry !== undefined) {
    const originProvider = normalizeOptionalString(entry.modelOverrideFallbackOriginProvider);
    const originModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
    if (originProvider && originModel) {
      return { provider: originProvider, model: originModel, persistedAutoFallback: true };
    }
  }
  return {
    provider: params.run.provider,
    model: params.run.model,
    persistedAutoFallback: false,
  };
}

export function normalizeAssistantFinalDeliveryText(text: string): string {
  const parsed = normalizeReplyPayloadDirectives({
    payload: { text },
    trimLeadingWhitespace: true,
    parseMode: "auto",
  });
  return sanitizePendingFinalDeliveryText(parsed.payload.text ?? "");
}

export async function refreshSessionEntryFromStore(params: {
  storePath?: string;
  sessionKey?: string;
  fallbackEntry?: SessionEntry;
  activeSessionStore?: Record<string, SessionEntry>;
  expectedGeneration?: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  reader?: SessionEntryCohortReader;
}): Promise<SessionEntry | undefined> {
  const { storePath, sessionKey, fallbackEntry, activeSessionStore } = params;
  if (!storePath || !sessionKey) {
    return fallbackEntry;
  }
  try {
    const latestEntry = await readSessionEntryReadOnlyInWorker(
      {
        storePath,
        sessionKey,
      },
      undefined,
      params.reader,
    );
    // Completion may refresh facts, but only admission can adopt a replacement generation.
    if (
      !latestEntry ||
      (params.expectedGeneration &&
        (latestEntry.sessionId !== params.expectedGeneration.sessionId ||
          latestEntry.lifecycleRevision !== params.expectedGeneration.lifecycleRevision))
    ) {
      return fallbackEntry;
    }
    if (activeSessionStore) {
      activeSessionStore[sessionKey] = latestEntry;
    }
    return latestEntry;
  } catch (error) {
    if (params.reader) {
      throw error;
    }
    return fallbackEntry;
  }
}

export async function handleReplyAgentRunError(
  error: unknown,
  context: {
    resolveVisibleReplyDelivery: () => Promise<boolean>;
    isHeartbeat: boolean;
    replyExpectation: ReplyExpectation;
    isRestartRecoveryArmed: () => Promise<boolean>;
    replyOperation: ReplyOperation;
    resolvedVerboseLevel: VerboseLevel;
    returnWithQueuedFollowupDrain: <T>(value: T) => T;
    sessionCtx: TemplateContext;
  },
): Promise<ReplyPayload | undefined> {
  const {
    resolveVisibleReplyDelivery,
    isHeartbeat,
    replyExpectation,
    isRestartRecoveryArmed,
    replyOperation,
    resolvedVerboseLevel,
    returnWithQueuedFollowupDrain,
    sessionCtx,
  } = context;

  if (isReplyOperationSuperseded(replyOperation)) {
    return { text: SILENT_REPLY_TOKEN };
  }
  if (
    replyOperation.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_by_user"
  ) {
    return returnWithQueuedFollowupDrain({ text: SILENT_REPLY_TOKEN });
  }
  if (
    replyOperation.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_for_restart"
  ) {
    if (
      (await isRestartRecoveryArmed()) ||
      isReplyOperationSuperseded(replyOperation) ||
      resolveReplyOperationAbortReason(replyOperation) === "user"
    ) {
      return returnWithQueuedFollowupDrain({ text: SILENT_REPLY_TOKEN });
    }
    return returnWithQueuedFollowupDrain(
      markReplyPayloadForSourceSuppressionDelivery({
        text: buildRestartLifecycleReplyText(),
      }),
    );
  }
  if (error instanceof GatewayDrainingError || error instanceof CommandLaneClearedError) {
    replyOperation.fail(
      error instanceof GatewayDrainingError ? "gateway_draining" : "command_lane_cleared",
      error,
    );
    return returnWithQueuedFollowupDrain(
      markReplyPayloadForSourceSuppressionDelivery({
        text: buildRestartLifecycleReplyText(),
      }),
    );
  }
  if (isRestartRecoveryClaimChangedError(error)) {
    replyOperation.fail("run_failed", error);
    return returnWithQueuedFollowupDrain(
      markReplyPayloadForSourceSuppressionDelivery({
        text: "⚠️ This conversation changed before your message could start. Check the latest messages, then try again if needed.",
      }),
    );
  }
  const knownFailurePayload = buildKnownAgentRunFailureReplyPayload({
    err: error,
    sessionCtx,
    resolvedVerboseLevel,
  });
  if (knownFailurePayload) {
    replyOperation.fail("run_failed", error);
    return returnWithQueuedFollowupDrain(knownFailurePayload);
  }
  const visibleReplyDelivered = await resolveVisibleReplyDelivery();
  if (!isHeartbeat && visibleReplyDelivered && !replyOperation.abortSignal.aborted) {
    replyOperation.fail("run_failed", error);
    return returnWithQueuedFollowupDrain(
      buildTerminalAgentRunFailureReplyPayload({ replyExpectation, visibleReplyDelivered }),
    );
  }
  replyOperation.fail("run_failed", error);
  // Keep the followup queue moving even when an unexpected exception escapes
  // the run path; the caller still receives the original error.
  returnWithQueuedFollowupDrain(undefined);
  throw error;
}

export async function cleanupReplyAgentRun(context: {
  blockReplyPipeline: BlockReplyPipeline | null;
  clearRestartRecoveryDeliveryClaim: () => Promise<void>;
  isHeartbeat: boolean;
  providedReplyOperation: ReplyOperation | undefined;
  queueKey: string;
  replyOperation: ReplyOperation;
  runFollowupTurn: (queued: FollowupRun) => Promise<void>;
  sessionKey: string | undefined;
  shouldDrainQueuedFollowupsAfterClear: boolean;
  typing: TypingController;
}): Promise<void> {
  const {
    blockReplyPipeline,
    clearRestartRecoveryDeliveryClaim,
    isHeartbeat,
    providedReplyOperation,
    queueKey,
    replyOperation,
    runFollowupTurn,
    sessionKey,
    shouldDrainQueuedFollowupsAfterClear,
    typing,
  } = context;

  try {
    await clearRestartRecoveryDeliveryClaim();
  } catch (error) {
    logVerbose(
      `failed to clear restart recovery delivery context for ${sessionKey ?? "unknown"}: ${String(
        error,
      )}`,
    );
  }
  if (shouldDrainQueuedFollowupsAfterClear) {
    if (isHeartbeat) {
      // Heartbeat-scoped options and dispatch must never run queued user turns after a restart.
      runAfterReplyOperationClear(replyOperation, () => kickFollowupDrainIfIdle(queueKey));
    } else {
      scheduleFollowupDrainAfterReplyOperationClear({
        operation: replyOperation,
        queueKey,
        runFollowup: runFollowupTurn,
      });
    }
  }
  if (!providedReplyOperation) {
    replyOperation.complete();
  }
  blockReplyPipeline?.stop();
  typing.markRunComplete();
  // Early exits may never reach dispatcher onIdle, leaving typing's other half open.
  // The typing controller seals cleanup, so repeated completion is safe.
  typing.markDispatchIdle();
}

export type RunReplyAgentParams = ReplyAgentTurnContext & {
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  hasQueuedFollowups?: boolean;
  isActive: boolean;
  isRunActive?: () => boolean;
  typing: TypingController;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  defaultModel: string;
  isNewSession: boolean;
  shouldInjectGroupIntro: boolean;
  typingMode: TypingMode;
  resetTriggered?: boolean;
  replyThreadingOverride?: TemplateContext["ReplyThreading"];
};
