import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasCompletedSourceReplyDeliveryEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
  resolveSourceReplyDelivery,
  hasVisibleOutboundDeliveryEvidence,
} from "../../agents/embedded-agent-runner/delivery-evidence.js";
import {
  isSyntheticSourceReplyTurn,
  resolveReplyCompletion,
} from "../../agents/reply-completion.js";
import {
  deriveContextPromptTokens,
  hasBillableUsage,
  toDiagnosticUsage,
} from "../../agents/usage.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { ProgressContinuationState } from "../../channels/progress-continuation.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { estimateAggregateUsageCost } from "../../utils/usage-format.js";
import {
  buildFallbackClearedNotice,
  buildFallbackNotice,
  buildProviderPolicyRetryNotice,
} from "../fallback-state.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  isReplyPayloadTerminalContent,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  buildSilentFallbackFailurePayload,
  hasSuccessfulSourceReplyDelivery,
  resolveTerminalReplyDelivery,
  refreshSessionEntryFromStore,
  resolveSourceReplyPolicy,
} from "./agent-runner-core.js";
import { buildEmptyInteractiveReplyPayload } from "./agent-runner-failure-reply.js";
import { signalTypingIfNeeded } from "./agent-runner-helpers.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import {
  appendUnscheduledReminderNote,
  hasSessionRelatedCronJobs,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";
import type { accountAgentTurn } from "./agent-runner-result-accounting.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { resolveResponseUsageLine } from "./agent-runner-usage-line.js";
import type { PendingContinuationSettlement } from "./get-reply.types.js";
import { attachMcpAppChannelAction, attachMcpConnectChannelAction } from "./mcp-channel-actions.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { createReplyToModeFilterForChannel } from "./reply-threading.js";
import { resolveSourceReplyExpectation } from "./source-reply-delivery-mode.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";
import { buildWaitingStatusPayload } from "./waiting-status.js";
type ReplyAgentAccounting = Awaited<ReturnType<typeof accountAgentTurn>>;

export async function prepareReplyAgentPayloads(state: {
  context: FinalizeReplyAgentRunInput;
  accounting: ReplyAgentAccounting;
}) {
  const { context, accounting } = state;
  const {
    activeSessionStore,
    blockReplyPipeline,
    blockStreamingEnabled,
    cfg,
    followupRun,
    isHeartbeat,
    opts,
    replyMediaContext,
    replyOperation,
    replyRouteThreadId,
    replyThreadingOverride,
    replyToChannel,
    replyToMode,
    returnWithQueuedFollowupDrain,
    runStartedAt,
    runtimePolicySessionKey,
    sessionCtx,
    sessionKey,
    storePath,
    typingSignals,
  } = context;
  const {
    configuredFallbackModel,
    contextTokensUsed,
    hasDirectlySentBlockReply,
    directBlockDeliveries,
    fallbackAttempts,
    fallbackExhausted,
    fallbackTransition,
    modelUsed,
    payloadArray,
    preserveUserFacingSessionState,
    promptTokens,
    providerUsed,
    replyUsageState,
    runId,
    runResult,
    selectedModel,
    selectedProvider,
    sessionModel,
    terminalFailurePayload,
    usage,
  } = accounting;
  let { activeSessionEntry, didLogHeartbeatStrip } = accounting;
  const terminalReplyExpectation =
    followupRun.run.terminalReplyExpectation ??
    resolveSourceReplyExpectation({
      ctx: {
        ...sessionCtx,
        InboundEventKind: followupRun.currentInboundEventKind,
        InputProvenance: followupRun.run.inputProvenance,
      },
      cfg,
      isHeartbeat,
    });
  const blocked =
    runResult.meta?.error?.kind === "hook_block" ||
    runResult.didSendDeterministicApprovalPrompt === true;
  const replyOperationRunState = resolveReplyOperationRunState(opts);
  const implicitContinuation = runResult.meta?.continuationPending === true;
  const pendingContinuation =
    runResult.meta?.yielded === true ||
    implicitContinuation ||
    (runResult.meta?.pendingToolCalls?.length ?? 0) > 0;
  if (pendingContinuation && !implicitContinuation) {
    opts?.onPendingContinuation?.();
  }

  const successfulSourceReplyDelivery = hasSuccessfulSourceReplyDelivery({
    blockReplyPipeline,
    hasDirectlySentBlockReply,
    messagingToolSentTexts: runResult.messagingToolSentTexts,
    messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
    messagingToolSentTargets: runResult.messagingToolSentTargets,
  });
  const committedMessagingToolSourceReplyDelivery =
    hasCommittedSourceReplyDeliveryEvidence(runResult);
  const completedSourceReplyDelivery = hasCompletedSourceReplyDeliveryEvidence(runResult);
  const hasLegacyMessagingToolEvidence =
    runResult.sourceReplyDeliveryState === undefined &&
    resolveExplicitFinalSourceReplyDeliveryEvidence(runResult) === undefined;
  const visibleOutboundDelivery = hasVisibleOutboundDeliveryEvidence(runResult);
  const successfulSideEffectDelivery =
    successfulSourceReplyDelivery ||
    committedMessagingToolSourceReplyDelivery ||
    visibleOutboundDelivery ||
    runResult.didSendDeterministicApprovalPrompt === true;
  const sourceReplyDelivery = resolveSourceReplyDelivery(
    runResult,
    await resolveTerminalReplyDelivery({
      blockReplyPipeline,
      directBlockDeliveries,
      resolveReplyDelivery: opts?.resolveReplyDelivery,
      sourceReplyDeliveryState: runResult.sourceReplyDeliveryState,
    }),
  );
  let completion = resolveReplyCompletion(
    terminalReplyExpectation,
    blocked
      ? "blocked"
      : sourceReplyDelivery !== "missing"
        ? sourceReplyDelivery
        : pendingContinuation
          ? "pending"
          : "empty",
  );
  if (replyOperationRunState) {
    replyOperationRunState.replyCompletion = completion;
  }
  const onDeliveredTerminalDuplicate = hasLegacyMessagingToolEvidence
    ? () => {
        if (completion.outcome !== "blocked") {
          completion = resolveReplyCompletion(terminalReplyExpectation, "delivered");
          if (replyOperationRunState) {
            replyOperationRunState.replyCompletion = completion;
          }
        }
      }
    : undefined;
  // Compaction notices are progress, not a terminal reply. Dispatcher-backed
  // delivery settles after this run returns, so it cannot prove turn completion here.
  const shouldDeliverTerminalFailure = Boolean(
    terminalFailurePayload &&
    completion.outcome !== "delivered" &&
    completion.outcome !== "pending" &&
    completion.outcome !== "blocked",
  );
  const fallbackFailureKnown =
    fallbackAttempts.length > 0 || configuredFallbackModel.persistedAutoFallback;
  const hasSpecificFallbackFailure = fallbackTransition.fallbackActive && fallbackFailureKnown;
  const waitingStatusPayload = terminalFailurePayload
    ? undefined
    : buildWaitingStatusPayload({
        completion,
        yielded: runResult.meta?.yielded === true,
        continuationPending: implicitContinuation,
        yieldAcknowledgment: runResult.meta?.yieldAcknowledgment,
        // Child spawns are side effects, not user-visible messages. They must not
        // suppress the explicit waiting reply for the parent turn.
        hasVisibleMessageDelivery:
          successfulSourceReplyDelivery ||
          committedMessagingToolSourceReplyDelivery ||
          runResult.didSendDeterministicApprovalPrompt === true,
      });
  const emptyInteractiveReplyPayload = terminalFailurePayload
    ? undefined
    : buildEmptyInteractiveReplyPayload({ completion });
  const buildStrandedRetryMissingDeliveryDiagnostic = (): ReplyPayload | undefined => {
    if (!sessionKey || !storePath || followupRun.strandedReplyRetry !== true) {
      return undefined;
    }
    if (sessionCtx.InboundEventKind === "room_event" || completedSourceReplyDelivery) {
      return undefined;
    }
    const sourceReplyPolicy = resolveSourceReplyPolicy({
      cfg,
      sessionCtx,
      sessionEntry: activeSessionEntry,
      sessionKey,
      runtimePolicySessionKey,
      opts,
    });
    // The guard above limits this to a one-shot recovery turn. A second miss
    // always gets a diagnostic, even when the retry produced no final text.
    const recovery = resolveStrandedReplyRecovery({
      base: followupRun,
      payloads: [],
      finalText: "",
      sourceReplyDeliveryMode: sourceReplyPolicy.sourceReplyDeliveryMode,
      sendPolicyDenied: sourceReplyPolicy.sendPolicyDenied,
      successfulSourceReplyDelivery: completedSourceReplyDelivery,
      isHeartbeat,
      isRoomEvent: false,
    });
    return recovery.kind === "diagnostic" ? recovery.payload : undefined;
  };
  if (sourceReplyDelivery === "delivered") {
    await opts?.onObservedReplyDelivery?.();
  }
  const currentMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
  // A terminal fallback is built separately after normal payload filtering.
  // Share this state across deliverable lanes so replyToMode=first still threads
  // at most one visible payload without hidden reasoning/commentary consuming it.
  const applyDeliveredReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const isGeneratedToolWarning = (payload: ReplyPayload) =>
    getReplyPayloadMetadata(payload)?.toolErrorWarning !== undefined;
  const applyFinalReplyToMode = (payload: ReplyPayload) => {
    const isDisabledReasoningLane =
      payload.isReasoning === true && opts?.reasoningPayloadsEnabled !== true;
    const isDisabledCommentaryLane =
      payload.isCommentary === true && opts?.commentaryPayloadsEnabled !== true;
    const isFilteredPayload =
      normalizeReplyPayload(payload, { applyChannelTransforms: false }) === null;
    const shouldDeferToolWarning = waitingStatusPayload && isGeneratedToolWarning(payload);
    return isDisabledReasoningLane ||
      isDisabledCommentaryLane ||
      isFilteredPayload ||
      shouldDeferToolWarning
      ? payload
      : applyDeliveredReplyToMode(payload);
  };
  const buildFinalPayloads = (payloads: ReplyPayload[]) =>
    buildReplyPayloads({
      config: cfg,
      payloads,
      conversationContext: sessionCtx.agentText ?? sessionCtx.BodyForAgent,
      isHeartbeat,
      didLogHeartbeatStrip,
      silentExpected: followupRun.run.silentExpected,
      blockStreamingEnabled,
      blockReplyPipeline,
      directBlockDeliveries,
      replyToMode,
      replyToChannel,
      currentMessageId,
      replyThreading: replyThreadingOverride ?? sessionCtx.ReplyThreading,
      applyReplyToMode: applyFinalReplyToMode,
      messageProvider: followupRun.run.messageProvider,
      messagingToolSentTexts: runResult.messagingToolSentTexts,
      messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
      messagingToolSentTargets: runResult.messagingToolSentTargets,
      onDeliveredTerminalDuplicate,
      originatingChannel: sessionCtx.OriginatingChannel,
      originatingChatType: sessionCtx.ChatType,
      originatingTo: sessionCtx.OriginatingTo ?? sessionCtx.To,
      originatingThreadId: replyRouteThreadId,
      accountId: sessionCtx.AccountId,
      normalizeMediaPaths: replyMediaContext.normalizePayload,
    });
  const returnPreparedFallbackPayload = async (
    payload: ReplyPayload,
  ): Promise<ReplyPayload | undefined> => {
    const result = await buildFinalPayloads([payload]);
    didLogHeartbeatStrip = result.didLogHeartbeatStrip;
    const preparedPayload = result.replyPayloads[0];
    if (!preparedPayload) {
      return undefined;
    }
    await signalTypingIfNeeded([preparedPayload], typingSignals);
    return returnWithQueuedFollowupDrain(preparedPayload);
  };
  const returnSilentFallbackFailureIfNeeded = async (): Promise<ReplyPayload | undefined> => {
    const silentFallbackFailurePayload = buildSilentFallbackFailurePayload({
      fallbackTransition,
      fallbackFailureKnown,
      fallbackAttempts,
      cfg,
      completion,
    });
    if (!silentFallbackFailurePayload) {
      return undefined;
    }
    replyOperation.fail(
      "run_failed",
      new Error(
        `configured model backend ${fallbackTransition.selectedModelRef} failed and fallback ${fallbackTransition.activeModelRef} produced no visible reply`,
      ),
    );
    opts?.onAgentRunTerminalOutcome?.("failed");
    return returnPreparedFallbackPayload(silentFallbackFailurePayload);
  };
  const finishEmptyReply = async () => {
    if (completion.outcome === "silent" || completion.outcome === "blocked") {
      opts?.onDeliberateSilentTerminalReply?.();
    }
    return {
      kind: "return" as const,
      value:
        (await returnSilentFallbackFailureIfNeeded()) ??
        returnWithQueuedFollowupDrain(buildStrandedRetryMissingDeliveryDiagnostic()),
    };
  };
  const providerPolicyRetry = runResult.meta?.executionTrace?.providerPolicyRetry;
  const successfulProviderPolicyRetry =
    followupRun.currentInboundEventKind !== "room_event" &&
    !isSyntheticSourceReplyTurn({
      inputProvenance: followupRun.run.inputProvenance,
      isHeartbeat,
    }) &&
    context.execution.status === "ok" &&
    runResult.meta?.aborted !== true &&
    providerPolicyRetry?.category === "cyber"
      ? providerPolicyRetry
      : undefined;
  const providerPolicyRetrySucceeded = successfulProviderPolicyRetry !== undefined;
  const fallbackNoticeChanged =
    !fallbackExhausted &&
    !preserveUserFacingSessionState &&
    (fallbackTransition.fallbackTransitioned || fallbackTransition.fallbackCleared);
  const fallbackNoticeChatType =
    fallbackNoticeChanged && !providerPolicyRetrySucceeded
      ? normalizeChatType(sessionCtx.ChatType)
      : undefined;
  const shouldDeliverFallbackNotice =
    fallbackNoticeChatType !== "group" && fallbackNoticeChatType !== "channel";
  let fallbackNoticeText: string | null = successfulProviderPolicyRetry
    ? buildProviderPolicyRetryNotice({
        provider: successfulProviderPolicyRetry.provider,
        model: successfulProviderPolicyRetry.model,
        cfg,
      })
    : null;
  if (fallbackNoticeChanged && fallbackTransition.fallbackTransitioned) {
    emitAgentEvent({
      runId,
      sessionKey,
      stream: "lifecycle",
      data: {
        phase: "fallback",
        selectedProvider,
        selectedModel,
        activeProvider: sessionModel.provider,
        activeModel: sessionModel.model,
        reasonSummary: fallbackTransition.reasonSummary,
        attemptSummaries: fallbackTransition.attemptSummaries,
        attempts: fallbackAttempts,
      },
    });
    if (shouldDeliverFallbackNotice && !providerPolicyRetrySucceeded) {
      fallbackNoticeText = buildFallbackNotice({
        selectedProvider,
        selectedModel,
        activeProvider: sessionModel.provider,
        activeModel: sessionModel.model,
        attempts: fallbackAttempts,
        cfg,
      });
    }
  }
  if (fallbackNoticeChanged && fallbackTransition.fallbackCleared) {
    emitAgentEvent({
      runId,
      sessionKey,
      stream: "lifecycle",
      data: {
        phase: "fallback_cleared",
        selectedProvider,
        selectedModel,
        activeProvider: sessionModel.provider,
        activeModel: sessionModel.model,
        previousActiveModel: fallbackTransition.previousState.activeModel,
      },
    });
    if (shouldDeliverFallbackNotice && !providerPolicyRetrySucceeded) {
      fallbackNoticeText = buildFallbackClearedNotice({
        selectedProvider,
        selectedModel,
        previousActiveModel: fallbackTransition.previousState.activeModel,
      });
    }
  }
  const fallbackNoticePayloads: ReplyPayload[] = fallbackNoticeText
    ? [
        markReplyPayloadForSourceSuppressionDelivery({
          text: fallbackNoticeText,
          isFallbackNotice: true,
        }),
      ]
    : [];

  // Drain any late tool/block deliveries before deciding there's "nothing to send".
  // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
  // keep the typing indicator stuck.
  if (
    payloadArray.length === 0 &&
    fallbackNoticePayloads.length === 0 &&
    !shouldDeliverTerminalFailure &&
    !waitingStatusPayload &&
    (!emptyInteractiveReplyPayload || hasSpecificFallbackFailure)
  ) {
    return finishEmptyReply();
  }

  const payloadCandidates = (
    fallbackNoticePayloads.length > 0 ? [...fallbackNoticePayloads, ...payloadArray] : payloadArray
  ).filter(
    (payload) =>
      (payload.isReasoning !== true || opts?.reasoningPayloadsEnabled === true) &&
      (payload.isCommentary !== true || opts?.commentaryPayloadsEnabled === true),
  );
  const payloadResult = await buildFinalPayloads(payloadCandidates);
  if (sourceReplyDelivery !== "delivered" && completion.outcome === "delivered") {
    await opts?.onObservedReplyDelivery?.();
  }
  let { replyPayloads } = payloadResult;
  didLogHeartbeatStrip = payloadResult.didLogHeartbeatStrip;
  const replyPayloadsWithoutToolWarnings = waitingStatusPayload
    ? replyPayloads.filter((payload) => !isGeneratedToolWarning(payload))
    : replyPayloads;
  const hasTerminalReply =
    completion.outcome === "delivered" ||
    replyPayloadsWithoutToolWarnings.some(
      (payload) =>
        isReplyPayloadTerminalContent(payload) &&
        ((!shouldDeliverTerminalFailure && !waitingStatusPayload) ||
          followupRun.run.sourceReplyDeliveryMode !== "message_tool_only" ||
          getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true) &&
        normalizeReplyPayload(payload, { applyChannelTransforms: false }) !== null,
    );
  if (waitingStatusPayload && hasTerminalReply) {
    replyPayloads = replyPayloadsWithoutToolWarnings;
  }
  if (shouldDeliverTerminalFailure && !hasTerminalReply && terminalFailurePayload) {
    const terminalPayloadResult = await buildFinalPayloads([terminalFailurePayload]);
    replyPayloads = [...replyPayloads, ...terminalPayloadResult.replyPayloads];
    didLogHeartbeatStrip = terminalPayloadResult.didLogHeartbeatStrip;
  } else if (waitingStatusPayload && !hasTerminalReply) {
    const acknowledgmentResult = await buildFinalPayloads([waitingStatusPayload]);
    replyPayloads =
      acknowledgmentResult.replyPayloads.length > 0
        ? [...replyPayloadsWithoutToolWarnings, ...acknowledgmentResult.replyPayloads]
        : replyPayloads.map((payload) =>
            isGeneratedToolWarning(payload) ? applyFinalReplyToMode(payload) : payload,
          );
    didLogHeartbeatStrip = acknowledgmentResult.didLogHeartbeatStrip;
  } else if (hasSpecificFallbackFailure && !hasTerminalReply) {
    const silentFallbackFailurePayload = await returnSilentFallbackFailureIfNeeded();
    if (silentFallbackFailurePayload) {
      return { kind: "return" as const, value: silentFallbackFailurePayload };
    }
  } else if (emptyInteractiveReplyPayload && !hasTerminalReply) {
    const emptyPayloadResult = await buildFinalPayloads([
      buildStrandedRetryMissingDeliveryDiagnostic() ?? emptyInteractiveReplyPayload,
    ]);
    replyPayloads = [...replyPayloads, ...emptyPayloadResult.replyPayloads];
    didLogHeartbeatStrip = emptyPayloadResult.didLogHeartbeatStrip;
    if (emptyPayloadResult.replyPayloads.length > 0) {
      replyOperation.retainFailureUntilComplete();
      replyOperation.fail(
        "run_failed",
        new Error("interactive agent run completed without a visible reply"),
      );
      // Filtering can turn a successful model result into a failed reply.
      opts?.onAgentRunTerminalOutcome?.("failed");
    }
  }

  replyPayloads = attachMcpAppChannelAction({
    payloads: replyPayloads,
    channel: replyToChannel,
    sessionKey,
    view: runResult.latestMcpAppChannelView,
  });
  replyPayloads = attachMcpConnectChannelAction({
    payloads: replyPayloads,
    action: runResult.latestMcpConnectAction,
  });

  const hasVisibleReplyPayload = replyPayloads.some(
    (payload) =>
      !isReplyPayloadStatusNotice(payload) &&
      (payload.isReasoning !== true || opts?.reasoningPayloadsEnabled === true) &&
      (payload.isCommentary !== true || opts?.commentaryPayloadsEnabled === true) &&
      normalizeReplyPayload(payload, { applyChannelTransforms: false }) !== null,
  );
  const hasDeliveredBlockStream = Boolean(blockReplyPipeline?.didStream());
  const canDeliverStandaloneFallbackNotice =
    hasDeliveredBlockStream || successfulSideEffectDelivery;
  if (
    replyPayloads.length === 0 ||
    (!hasVisibleReplyPayload && !canDeliverStandaloneFallbackNotice)
  ) {
    return finishEmptyReply();
  }

  const successfulCronAdds = runResult.successfulCronAdds ?? 0;
  const hasReminderCommitment = replyPayloads.some(
    (payload) =>
      !payload.isError &&
      !isReplyPayloadStatusNotice(payload) &&
      typeof payload.text === "string" &&
      hasUnbackedReminderCommitment(payload.text),
  );
  // Suppress the guard note when an existing cron job (created in a prior
  // turn) already covers the commitment — avoids false positives (#32228).
  const coveredByExistingCron =
    hasReminderCommitment && successfulCronAdds === 0
      ? await hasSessionRelatedCronJobs({
          cronStorePath: undefined,
          sessionKey,
        })
      : false;
  const guardedReplyPayloads =
    hasReminderCommitment && successfulCronAdds === 0 && !coveredByExistingCron
      ? appendUnscheduledReminderNote(replyPayloads)
      : replyPayloads;

  if (implicitContinuation || (pendingContinuation && runResult.acceptedSessionSpawns?.length)) {
    const statusPayload = guardedReplyPayloads.find(
      (payload) => getReplyPayloadMetadata(payload)?.continuationStatus === true,
    );
    const acceptedSessionSpawns = runResult.acceptedSessionSpawns;
    const requesterSessionKey = sessionKey ?? followupRun.run.sessionKey;
    if (
      implicitContinuation &&
      (!requesterSessionKey || !acceptedSessionSpawns?.length || !statusPayload)
    ) {
      throw new Error("accepted continuation status could not be prepared for delivery");
    }
    if (requesterSessionKey && acceptedSessionSpawns?.length && statusPayload) {
      let progressPresentation: ProgressContinuationState | undefined;
      if (implicitContinuation) {
        const settlement: PendingContinuationSettlement = {
          settle: async (statusDelivered) => {
            const presentation = progressPresentation;
            progressPresentation = undefined;
            try {
              const { settleRequesterAfterSessionSpawns } =
                await import("../../agents/subagents/registry/subagent-registry.js");
              const requester = {
                requesterSessionKey,
                requesterAgentId: followupRun.run.agentId,
                requesterTurnRunId: runId,
                acceptedSessionSpawns,
              };
              const requesterYielded = statusDelivered || presentation !== undefined;
              try {
                if (
                  !settleRequesterAfterSessionSpawns({
                    ...requester,
                    requesterYielded,
                    ...(presentation ? { progressPresentation: presentation } : {}),
                  })
                ) {
                  throw new Error(
                    "accepted continuation children could not transfer terminal delivery",
                  );
                }
              } catch (error) {
                // Adoption is positive visibility even when the later transport
                // outcome is unknown. A failed handoff must still release the child.
                if (!statusDelivered && requesterYielded) {
                  settleRequesterAfterSessionSpawns({ ...requester, requesterYielded: false });
                }
                throw error;
              }
            } finally {
              getReplyPayloadMetadata(statusPayload)?.progressContinuation?.close();
            }
          },
        };
        opts?.onPendingContinuation?.(settlement);
      }
      // Ordinary replies must not load the task presentation runtime.
      const { createTaskProgressContinuation } =
        await import("../../tasks/task-progress-requester.js");
      const progressContinuation = await createTaskProgressContinuation({
        requesterSessionKey,
        requesterAgentId: followupRun.run.agentId,
        requesterTurnRunId: runId,
        acceptedSessionSpawns,
        ...(implicitContinuation
          ? {
              onAdopted: (presentation: ProgressContinuationState) => {
                progressPresentation = presentation;
              },
            }
          : {}),
      });
      if (progressContinuation) {
        setReplyPayloadMetadata(statusPayload, { progressContinuation });
      }
    }
  }
  await signalTypingIfNeeded(guardedReplyPayloads, typingSignals);

  const diagnosticUsage = runResult.meta?.agentMeta?.diagnosticUsage ?? usage;
  if (isDiagnosticsEnabled(cfg) && hasBillableUsage(diagnosticUsage)) {
    const contextUsedTokens = deriveContextPromptTokens({
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      promptTokens,
      usage,
    });
    const costUsd = estimateAggregateUsageCost({
      usage: diagnosticUsage,
      provider: providerUsed,
      model: modelUsed,
      config: cfg,
      agentDir: followupRun.run.agentDir,
    });
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      ...(runResult.diagnosticTrace
        ? {
            trace: freezeDiagnosticTraceContext(
              createChildDiagnosticTraceContext(runResult.diagnosticTrace),
            ),
          }
        : {}),
      sessionKey,
      sessionId: followupRun.run.sessionId,
      channel: replyToChannel,
      agentId: followupRun.run.agentId,
      provider: providerUsed,
      model: modelUsed,
      usage: toDiagnosticUsage(diagnosticUsage),
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      context: {
        limit: contextTokensUsed,
        ...(contextUsedTokens !== undefined ? { used: contextUsedTokens } : {}),
      },
      costUsd,
      durationMs: Date.now() - runStartedAt,
    });
  }

  const responseUsageSessionRaw =
    activeSessionEntry?.responseUsage ??
    (sessionKey ? activeSessionStore?.[sessionKey]?.responseUsage : undefined);
  const responseUsageLine = resolveResponseUsageLine({
    config: cfg,
    agentDir: followupRun.run.agentDir,
    sessionRaw: responseUsageSessionRaw,
    channel: replyToChannel,
    usage,
    provider: providerUsed,
    model: modelUsed,
    preserveUserFacingSessionState,
    replyUsageState,
  });

  // Refresh inherited verbosity even when it started off: session preferences
  // and plugin diagnostics may change while the model runs.
  if (followupRun.run.verboseLevelOverride !== "off" || followupRun.run.traceAuthorized === true) {
    activeSessionEntry = refreshSessionEntryFromStore({
      storePath,
      sessionKey,
      fallbackEntry: activeSessionEntry,
      activeSessionStore,
      expectedGeneration: accounting.expectedSession,
    });
  }

  return {
    kind: "continue" as const,
    activeSessionEntry,
    completedSourceReplyDelivery,
    guardedReplyPayloads,
    responseUsageLine,
  };
}
