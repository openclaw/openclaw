import { hasCompletionMessageSessionSpawn } from "../../agents/accepted-session-spawn.js";
import { resolveDiagnosticModelResponse } from "../../agents/diagnostic-model-response.js";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasCompletedSourceReplyDeliveryEvidence,
  hasVisibleOutboundDeliveryEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
  resolveSourceReplyDelivery,
} from "../../agents/embedded-agent-runner/delivery-evidence.js";
import {
  createMissingReplyNotice,
  MISSING_REPLY_NOTICE_TEXT,
  isSyntheticSourceReplyTurn,
  resolveClaimedReplyExpectation,
  resolveReplyCompletion,
  shouldDeliverMissingReplyNotice,
} from "../../agents/reply-completion.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { getReplyOperationSessionReader } from "../../sessions/session-controller.state.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { resolveLiveContinuationRuntimeConfig } from "../continuation/config.js";
import { resolveQueuedDelegateCounts } from "../continuation/delegate-store.js";
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
  selectAutomationReplyPayloads,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { appendCyberAccessProgramNotice } from "./access-program-notice.js";
import {
  buildSilentFallbackFailurePayload,
  hasSuccessfulSourceReplyDelivery,
  refreshSessionEntryFromStore,
  resolveSourceReplyPolicy,
  resolveTerminalReplyDelivery,
} from "./agent-runner-core.js";
import { signalTypingIfNeeded } from "./agent-runner-helpers.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import {
  appendUnscheduledReminderNote,
  hasSessionRelatedCronJobs,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";
import type { AccountedAgentTurn } from "./agent-runner-result-accounting.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { emitReplyAgentUsageDiagnostic } from "./agent-runner-usage-diagnostic.js";
import { resolveResponseUsageLine } from "./agent-runner-usage-line.js";
import {
  resolveAutomationReplyState,
  retainAutomationReasoningWithFinal,
} from "./automation-reply-payloads.js";
import { attachMcpAppChannelAction, attachMcpConnectChannelAction } from "./mcp-channel-actions.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import {
  recordReplyOperationAgentTurn,
  resolveReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyToModeFilterForChannel } from "./reply-threading.js";
import { resolveReplyRunTrigger } from "./reply-turn-kind.js";
import { resolveSourceReplyExpectation } from "./source-reply-delivery-mode.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";
import { buildWaitingStatusPayload, prepareWaitingStatusContinuation } from "./waiting-status.js";
export async function prepareReplyAgentPayloads(state: {
  context: FinalizeReplyAgentRunInput;
  accounting: AccountedAgentTurn;
}) {
  const { context, accounting } = state;
  const {
    activeSessionStore,
    blockReplyPipeline,
    blockStreamingEnabled,
    cfg,
    followupRun,
    opts,
    replyMediaContext,
    replyOperation,
    replyRouteThreadId,
    replyThreadingOverride,
    replyToChannel,
    replyToMode,
    returnWithQueuedFollowupDrain,
    runtimePolicySessionKey,
    sessionCtx,
    sessionKey,
    storePath,
    typingSignals,
  } = context;
  const {
    configuredFallbackModel,
    hasDirectlySentBlockReply,
    directBlockDeliveries,
    effectiveContinuationSignal,
    fallbackAttempts,
    fallbackExhausted,
    fallbackTransition,
    modelUsed,
    payloadArray,
    preserveUserFacingSessionState,
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
  let { activeSessionEntry } = accounting;
  const terminalReplyExpectation =
    followupRun.run.terminalReplyExpectation ??
    resolveSourceReplyExpectation({
      ctx: {
        ...sessionCtx,
        InboundEventKind: followupRun.currentInboundEventKind,
        InputProvenance: followupRun.run.inputProvenance,
      },
      cfg,
      scheduledAutomation: followupRun.run.scheduledAutomation !== undefined,
    });
  const missingReplyNoticeAllowed = shouldDeliverMissingReplyNotice({
    ...followupRun.run,
    scheduledAutomation: followupRun.run.scheduledAutomation !== undefined,
    config: cfg,
    terminalReplyExpectation,
    trigger: resolveReplyRunTrigger(context),
    currentInboundEventKind: followupRun.currentInboundEventKind,
  });
  const backgroundMissingReply =
    !missingReplyNoticeAllowed &&
    (!runResult.meta?.error ||
      (runResult.meta.error.kind === "incomplete_turn" &&
        runResult.meta.error.message.startsWith(MISSING_REPLY_NOTICE_TEXT)));
  const replyOperationRunState = resolveReplyOperationRunState(opts);
  const {
    blocked,
    successfulTerminal,
    authoredSilence,
    pendingContinuation,
    automationNoChange,
    reasoningPayloadsEnabled,
  } = resolveAutomationReplyState(context.execution, { opts });
  const strandedFinal =
    successfulTerminal &&
    runResult.meta?.terminalReply?.disposition === "empty" &&
    runResult.meta.terminalReply.code === "message-tool-not-called" &&
    followupRun.strandedReplyRetry !== true;
  const implicitContinuation = runResult.meta?.continuationPending === true;
  // Completion-message children own their continuation; detached media retains its own run owner.
  const continuationOwner =
    implicitContinuation && hasCompletionMessageSessionSpawn(runResult.acceptedSessionSpawns)
      ? {
          stateContext: captureOpenClawStateWorkerContext(),
          operationKey: replyOperation.key,
          operationSessionId: replyOperation.sessionId,
        }
      : undefined;
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
  // A terminal payload can confirm an earlier progress send as its final answer.
  // Explicit delivery custody and unfinished/failed turns remain authoritative.
  const canCompleteFromMessagingToolDuplicate =
    runResult.sourceReplyDeliveryState === undefined &&
    (resolveExplicitFinalSourceReplyDeliveryEvidence(runResult) === undefined ||
      (successfulTerminal &&
        !pendingContinuation &&
        followupRun.run.sourceReplyDeliveryMode !== "message_tool_only"));
  const visibleOutboundDelivery = hasVisibleOutboundDeliveryEvidence(runResult);
  const successfulSideEffectDelivery =
    successfulSourceReplyDelivery ||
    committedMessagingToolSourceReplyDelivery ||
    visibleOutboundDelivery ||
    runResult.didSendDeterministicApprovalPrompt === true;
  const terminalReplyDelivery = await resolveTerminalReplyDelivery({
    blockReplyPipeline,
    directBlockDeliveries,
    resolveReplyDelivery: opts?.resolveReplyDelivery,
    sourceReplyDeliveryState: runResult.sourceReplyDeliveryState,
  });
  const sourceReplyDelivery = resolveSourceReplyDelivery(runResult, terminalReplyDelivery);
  let completion = resolveReplyCompletion(
    resolveClaimedReplyExpectation(terminalReplyExpectation, runResult.meta),
    blocked
      ? "blocked"
      : authoredSilence
        ? "silent"
        : sourceReplyDelivery !== "missing"
          ? sourceReplyDelivery
          : automationNoChange
            ? "silent"
            : pendingContinuation
              ? "pending"
              : "empty",
  );
  const explicitSilence = completion.outcome === "silent";
  if (replyOperationRunState) {
    replyOperationRunState.replyCompletion = completion;
  }
  const onDeliveredTerminalDuplicate = canCompleteFromMessagingToolDuplicate
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
  const waitingStatusPayload =
    context.execution.status === "failed"
      ? undefined
      : buildWaitingStatusPayload({
          completion,
          yielded: runResult.meta?.yielded === true,
          continuationPending: implicitContinuation,
          mediaContinuation: implicitContinuation && !continuationOwner,
          yieldAcknowledgment: runResult.meta?.yieldAcknowledgment,
          // Child spawns do not suppress a model-authored acknowledgment.
          hasVisibleMessageDelivery:
            successfulSourceReplyDelivery ||
            committedMessagingToolSourceReplyDelivery ||
            runResult.didSendDeterministicApprovalPrompt === true,
        });
  const missingReplyPayload =
    strandedFinal ||
    terminalFailurePayload ||
    !missingReplyNoticeAllowed ||
    completion.outcome !== "missing"
      ? undefined
      : createMissingReplyNotice();
  const buildStrandedRetryMissingDeliveryDiagnostic = (): ReplyPayload | undefined => {
    if (
      !missingReplyNoticeAllowed ||
      authoredSilence ||
      automationNoChange ||
      !sessionKey ||
      !storePath ||
      followupRun.strandedReplyRetry !== true ||
      sessionCtx.InboundEventKind === "room_event" ||
      completedSourceReplyDelivery
    ) {
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
      terminalReply: runResult.meta?.terminalReply,
      sourceReplyDeliveryMode: sourceReplyPolicy.sourceReplyDeliveryMode,
      sendPolicyDenied: sourceReplyPolicy.sendPolicyDenied,
      successfulSourceReplyDelivery: completedSourceReplyDelivery,
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
  const isPayloadLaneEnabled = (payload: ReplyPayload) =>
    (payload.isReasoning !== true || reasoningPayloadsEnabled) &&
    (payload.isCommentary !== true || opts?.commentaryPayloadsEnabled === true);
  const applyFinalReplyToMode = (payload: ReplyPayload) => {
    const laneEnabled = isPayloadLaneEnabled(payload);
    const isFilteredPayload =
      normalizeReplyPayload(payload, { applyChannelTransforms: false }) === null;
    const shouldDeferToolWarning = waitingStatusPayload && isGeneratedToolWarning(payload);
    return !laneEnabled || isFilteredPayload || shouldDeferToolWarning
      ? payload
      : applyDeliveredReplyToMode(payload);
  };
  const buildFinalPayloads = async (payloads: ReplyPayload[]) => {
    const result = await buildReplyPayloads({
      config: cfg,
      payloads,
      conversationContext: sessionCtx.agentText ?? sessionCtx.BodyForAgent,
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
    return result.replyPayloads;
  };
  const returnSilentFallbackFailureIfNeeded = async (): Promise<ReplyPayload | undefined> => {
    if (backgroundMissingReply) {
      return undefined;
    }
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
    if (!replyOperation.result) {
      replyOperation.fail(
        "run_failed",
        new Error(
          `configured model backend ${fallbackTransition.selectedModelRef} failed and fallback ${fallbackTransition.activeModelRef} produced no visible reply`,
        ),
      );
      opts?.onAgentRunTerminalOutcome?.("failed");
    }
    const [preparedPayload] = await buildFinalPayloads([silentFallbackFailurePayload]);
    if (!preparedPayload) {
      return undefined;
    }
    await signalTypingIfNeeded([preparedPayload], typingSignals);
    return returnWithQueuedFollowupDrain(preparedPayload);
  };
  const recordMissingReply = () => {
    if (completion.outcome === "missing" && !replyOperation.result) {
      replyOperation.fail("run_failed", new Error(MISSING_REPLY_NOTICE_TEXT));
      recordReplyOperationAgentTurn(followupRun.replyOperationRunStates, replyOperation, {
        kind: "settled",
        status: "failed",
        result: runResult,
      });
      opts?.onAgentRunTerminalOutcome?.("failed");
    }
  };
  const quietContinuation = completion.outcome === "pending" && !waitingStatusPayload;
  if (explicitSilence || quietContinuation) {
    await prepareWaitingStatusContinuation({ context, owner: continuationOwner });
  }
  const finishEmptyReply = async () => {
    recordMissingReply();
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
      scheduledAutomation: followupRun.run.scheduledAutomation !== undefined,
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
  const fallbackModels = {
    selectedProvider,
    selectedModel,
    activeProvider: sessionModel.provider,
    activeModel: sessionModel.model,
  };
  if (fallbackNoticeChanged && fallbackTransition.fallbackTransitioned) {
    emitAgentEvent({
      runId,
      sessionKey,
      stream: "lifecycle",
      data: {
        phase: "fallback",
        ...fallbackModels,
        reasonSummary: fallbackTransition.reasonSummary,
        attemptSummaries: fallbackTransition.attemptSummaries,
        attempts: fallbackAttempts,
      },
    });
    if (shouldDeliverFallbackNotice && !providerPolicyRetrySucceeded) {
      fallbackNoticeText = buildFallbackNotice({
        ...fallbackModels,
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
        ...fallbackModels,
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
  // Silent finals drop notices, so leave the one-time claim for a visible reply.
  if (!authoredSilence && !automationNoChange) {
    fallbackNoticeText = appendCyberAccessProgramNotice(fallbackNoticeText, context, accounting);
  }
  const fallbackNoticePayloads: ReplyPayload[] = fallbackNoticeText
    ? [
        setReplyPayloadMetadata(
          markReplyPayloadForSourceSuppressionDelivery({
            text: fallbackNoticeText,
            isFallbackNotice: true,
          }),
          !providerPolicyRetrySucceeded &&
            runResult.meta.modelFallbackTranscriptToModel === fallbackTransition.activeModelRef
            ? { modelFallbackNotice: true }
            : {},
        ),
      ]
    : [];

  // Report usage before any early return so silent replies still emit it (#152396).
  await emitReplyAgentUsageDiagnostic(state);

  // A tool-only continuation turn may have no visible text while still needing
  // delegate consumption/persistence below. Exact counts: before custody hydration or
  // after an unresolved write the projection is unknown, and reading that as zero
  // would drop committed work.
  const queuedDelegateCounts =
    resolveLiveContinuationRuntimeConfig(cfg).enabled && sessionKey
      ? await resolveQueuedDelegateCounts(sessionKey)
      : undefined;
  const hasQueuedDelegateWork =
    queuedDelegateCounts !== undefined &&
    (queuedDelegateCounts.pending > 0 || queuedDelegateCounts.stagedPostCompaction > 0);

  // Dispatch installs onRawLlmResponse only when output capture is enabled.
  if (opts?.onRawLlmResponse) {
    const finalDiagnosticResponse = resolveDiagnosticModelResponse(runResult);
    if (finalDiagnosticResponse !== undefined) {
      opts.onRawLlmResponse(finalDiagnosticResponse);
    }
  }

  const quietFinal = authoredSilence || automationNoChange;
  const sourcePayloads = selectAutomationReplyPayloads(
    payloadArray,
    automationNoChange,
    quietFinal,
  );
  // Continuation work must reach completion (which arms it) even when nothing is visible.
  if (
    !hasQueuedDelegateWork &&
    !effectiveContinuationSignal &&
    ((quietFinal && sourcePayloads.length === 0) ||
      (!strandedFinal &&
        completion.outcome !== "delivered" &&
        payloadArray.length === 0 &&
        fallbackNoticePayloads.length === 0 &&
        !shouldDeliverTerminalFailure &&
        !waitingStatusPayload &&
        (!missingReplyPayload || hasSpecificFallbackFailure)))
  ) {
    return finishEmptyReply();
  }

  const payloadCandidates = (
    !quietFinal && fallbackNoticePayloads.length > 0
      ? [...fallbackNoticePayloads, ...sourcePayloads]
      : sourcePayloads
  ).filter(isPayloadLaneEnabled);
  let replyPayloads = await buildFinalPayloads(payloadCandidates);
  if (context.execution.automation) {
    replyPayloads = retainAutomationReasoningWithFinal(replyPayloads);
  }
  if (sourceReplyDelivery !== "delivered" && completion.outcome === "delivered") {
    await opts?.onObservedReplyDelivery?.();
  }
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
  if (
    !hasTerminalReply &&
    !waitingStatusPayload &&
    !strandedFinal &&
    !effectiveContinuationSignal &&
    !hasQueuedDelegateWork
  ) {
    recordMissingReply();
  }
  if (shouldDeliverTerminalFailure && !hasTerminalReply && terminalFailurePayload) {
    replyPayloads = [...replyPayloads, ...(await buildFinalPayloads([terminalFailurePayload]))];
  } else if (waitingStatusPayload && !hasTerminalReply) {
    const acknowledgmentPayloads = await buildFinalPayloads([waitingStatusPayload]);
    replyPayloads =
      acknowledgmentPayloads.length > 0
        ? [...replyPayloadsWithoutToolWarnings, ...acknowledgmentPayloads]
        : replyPayloads.map((payload) =>
            isGeneratedToolWarning(payload) ? applyFinalReplyToMode(payload) : payload,
          );
  } else if (hasSpecificFallbackFailure && !hasTerminalReply) {
    const silentFallbackFailurePayload = await returnSilentFallbackFailureIfNeeded();
    if (silentFallbackFailurePayload) {
      return { kind: "return" as const, value: silentFallbackFailurePayload };
    }
  } else if (
    missingReplyPayload &&
    !hasTerminalReply &&
    !effectiveContinuationSignal &&
    !hasQueuedDelegateWork
  ) {
    const emptyPayloads = await buildFinalPayloads([
      buildStrandedRetryMissingDeliveryDiagnostic() ?? missingReplyPayload,
    ]);
    replyPayloads = [...replyPayloads, ...emptyPayloads];
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
      payload.isError ||
      (!isReplyPayloadStatusNotice(payload) &&
        isPayloadLaneEnabled(payload) &&
        normalizeReplyPayload(payload, { applyChannelTransforms: false }) !== null),
  );
  const canDeliverStandaloneFallbackNotice =
    Boolean(blockReplyPipeline?.didStream()) || successfulSideEffectDelivery;
  // Track whether the agent reply was purely a continuation signal (stripped to empty).
  // Used later to suppress verbose/usage augmentation that would break silent continuation.
  const wasSilentContinuation = replyPayloads.length === 0 && Boolean(effectiveContinuationSignal);
  // A continuation-only reply (e.g. bare CONTINUE_WORK) or a tool-only delegate turn has no
  // visible payload but still needs the continuation handling below, so it never finishes
  // as an empty reply here.
  if (
    !strandedFinal &&
    completion.outcome !== "delivered" &&
    (replyPayloads.length === 0 ||
      (!hasVisibleReplyPayload && !canDeliverStandaloneFallbackNotice)) &&
    !effectiveContinuationSignal &&
    !hasQueuedDelegateWork
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
      ? await hasSessionRelatedCronJobs(sessionKey)
      : false;
  const guardedReplyPayloads =
    hasReminderCommitment && successfulCronAdds === 0 && !coveredByExistingCron
      ? appendUnscheduledReminderNote(replyPayloads)
      : replyPayloads;

  const statusPayload = guardedReplyPayloads.find(
    (payload) => getReplyPayloadMetadata(payload)?.continuationStatus === true,
  );
  if (!explicitSilence && !quietContinuation) {
    await prepareWaitingStatusContinuation({
      context,
      owner: continuationOwner,
      payload: statusPayload,
    });
  }
  await signalTypingIfNeeded(guardedReplyPayloads, typingSignals);

  const responseUsageSessionRaw =
    activeSessionEntry?.responseUsage ??
    (sessionKey ? activeSessionStore?.[sessionKey]?.responseUsage : undefined);
  const responseUsageLine = await resolveResponseUsageLine({
    preparePricing: accounting.preparePricing,
    config: cfg,
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
    activeSessionEntry = context.completion
      ? await context.completion.refresh()
      : await refreshSessionEntryFromStore({
          storePath,
          sessionKey,
          fallbackEntry: activeSessionEntry,
          activeSessionStore,
          expectedGeneration: accounting.expectedSession,
          reader: getReplyOperationSessionReader(replyOperation),
        });
  }

  return {
    kind: "continue" as const,
    activeSessionEntry,
    replyCompletion: completion,
    completedSourceReplyDelivery,
    reminderNoteAppended: guardedReplyPayloads !== replyPayloads,
    guardedReplyPayloads,
    responseUsageLine,
    wasSilentContinuation,
  };
}
