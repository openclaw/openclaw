import {
  hasOutboundReplyContent,
  isFastModeAutoProgressPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import { isAskUserPromptPending } from "../../agents/tools/ask-user-tool.js";
import { settleProgressVisibilityCallbackResult } from "../../channels/progress-visibility.js";
import { normalizeAgentPlanSteps } from "../../channels/streaming.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { registerReplyDispatcherSettledTask } from "../dispatch-dispatcher.js";
import {
  getReplyPayloadMetadata,
  isCommandReplyForDelivery,
  readAskUserQuestionId,
} from "../reply-payload.js";
import { buildTerminalAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import { handleAcpDispatchTailAfterReset } from "./dispatch-from-config.acp-tail.js";
import { createDispatchBlockReplyHandler } from "./dispatch-from-config.block-reply.js";
import { flushDispatchDeferredFinalText } from "./dispatch-from-config.deferred-final.js";
import type { InternalReplyResolverOptions } from "./dispatch-from-config.events.js";
import {
  hasAskUserPayload,
  prepareReplyPayloadForSideEffects as preparePayload,
  requiresDurableToolResultDelivery,
} from "./dispatch-from-config.payloads.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import type { PrepareDispatchExecutionReadyState } from "./dispatch-from-config.prepare-execution.js";
import { requireQueuedReplyDelivery } from "./dispatch-from-config.turn-ledger.js";
import type { PendingContinuationSettlement } from "./get-reply.types.js";
import { bindPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import { REPLY_OPERATION_RUN_STATE } from "./reply-operation-run-state.js";

export async function executeDispatch(state: PrepareDispatchExecutionReadyState) {
  const {
    cfg,
    commentaryPayloadsEnabled,
    ctx,
    deliveryChannel,
    deferFinalTtsText,
    dispatcher,
    failDispatchReplyOperation,
    flushPendingCommentaryProgress,
    getAgentRunTerminalOutcome,
    getDispatchAbortOperation,
    getDispatchAbortSignal,
    isDispatchOperationAborted,
    markInboundDedupeReplayUnsafe,
    markProgress,
    maybeApplyTtsWithFinalizationLease,
    normalizeReplyMediaPayload,
    notifySessionMetadataChanges,
    onToolResultFromReplyOptions,
    onReasoningStream,
    params,
    reasoningPayloadsEnabled,
    replyConfig,
    replyRoute,
    resolveToolDeliveryPayload,
    runWithDispatchLifecycleAdmission,
    sendPayloadAsync,
    sessionAgentId,
    sessionTtsAuto,
    shouldForwardProgressCallback,
    shouldRouteToOriginating,
    shouldSuppressDefaultToolProgressMessages,
    trackDispatchLifecycleWork,
    typing,
    waitForPendingDirectBlockReplyDelivery,
    wrapProgressCallback,
  } = state;
  // Bind at invocation so every public resolver consumes the request generation without widening its Plugin SDK contract.
  const replyResolver = bindPreparedReplyDispatchRuntime(
    params.configOverride ? undefined : state.preparedReplyDispatchRuntime,
    state.replyResolver,
  );
  let pendingContinuation = false;
  let pendingContinuationSettlement: PendingContinuationSettlement | undefined;
  const releasePendingContinuation = async () => {
    const settlement = pendingContinuationSettlement;
    pendingContinuationSettlement = undefined;
    await settlement?.settle(false);
  };
  let didDeliverVisiblePartialReply = false;
  const {
    onBlockReply,
    onPreparedBlockReply,
    flush: flushBlockTtsText,
  } = createDispatchBlockReplyHandler(state);
  const flushDeferredFinalText = async () => {
    const delivered = await flushDispatchDeferredFinalText({
      deferFinalTtsText,
      isHeartbeat: params.replyOptions?.isHeartbeat === true,
      state,
    });
    didDeliverVisiblePartialReply ||= delivered;
    return delivered;
  };
  const forwardToolProgress = async (forward: () => unknown) => {
    if (isDispatchOperationAborted()) {
      return;
    }
    markProgress();
    await waitForPendingDirectBlockReplyDelivery(getDispatchAbortOperation()?.abortSignal);
    if (isDispatchOperationAborted()) {
      return;
    }
    markInboundDedupeReplayUnsafe();
    if (
      shouldForwardProgressCallback({
        forwardWhenSourceDeliverySuppressed: true,
        requiresToolSummaryVisibility: true,
      })
    ) {
      await forward();
    }
  };
  const replyResult = await runWithDispatchLifecycleAdmission(
    async () =>
      await runWithDispatchAbortSignal(
        getDispatchAbortSignal(),
        () =>
          state.traceReplyPhase("reply.run_reply_resolver", async () => {
            const result = await replyResolver(
              ctx,
              {
                ...state.getReplyOptions(),
                [REPLY_OPERATION_RUN_STATE]: state.replyOperationRunState,
                sourceReplyDeliveryMode: state.sourceReplyDeliveryMode,
                sessionPromptSourceReplyDeliveryMode: state.sessionStableSourceReplyDeliveryMode,
                ...state.sourceReplyDeliveryRuntimeOptions,
                ...({
                  mediaNormalizationOwner: state.isInternalWebchatTurn ? "gateway" : undefined,
                  onPendingContinuation: (settlement) => {
                    pendingContinuation = true;
                    pendingContinuationSettlement ??= settlement;
                  },
                  onSessionMetadataChanges: notifySessionMetadataChanges,
                  onSessionPrepared: state.notePreparedSession,
                  onRunVerbosityResolved: (settings) => {
                    state.noteRunVerbosity(settings);
                    params.replyOptions?.onRunVerbosityResolved?.(settings);
                  },
                } satisfies InternalReplyResolverOptions),
                onObservedReplyDelivery: state.markObservedReplyDelivery,
                typingPolicy: typing.typingPolicy,
                suppressTyping: typing.suppressTyping,
                onPartialReply: deferFinalTtsText
                  ? undefined
                  : wrapProgressCallback(params.replyOptions?.onPartialReply, {
                      onVisible: (payload) => {
                        if (hasOutboundReplyContent(payload, { trimText: true })) {
                          didDeliverVisiblePartialReply = true;
                        }
                      },
                    }),
                onReasoningStream,
                streamReasoningInNonStreamModes:
                  params.replyOptions?.streamReasoningInNonStreamModes,
                onReasoningEnd: wrapProgressCallback(params.replyOptions?.onReasoningEnd),
                onAssistantMessageStart: wrapProgressCallback(
                  params.replyOptions?.onAssistantMessageStart,
                ),
                onQueuedFollowupSettled: async () => {
                  // Retained block callbacks only enqueue; cleanup must join their
                  // delivery even when this dispatch has already returned.
                  try {
                    await flushBlockTtsText();
                    await waitForPendingDirectBlockReplyDelivery();
                    if (
                      dispatcher.getFailedCounts().block > 0 &&
                      state.turnLedger.canAttemptFallback()
                    ) {
                      await dispatcher.waitForIdle();
                    }
                  } catch (error) {
                    try {
                      await params.replyOptions?.onQueuedFollowupSettled?.();
                    } catch (cleanupError) {
                      logVerbose(
                        `dispatch-from-config: queued cleanup failed; preserving delivery error: ${formatErrorMessage(cleanupError)}`,
                      );
                    }
                    throw error;
                  }
                  await params.replyOptions?.onQueuedFollowupSettled?.();
                },
                onBlockReplyQueued: wrapProgressCallback(params.replyOptions?.onBlockReplyQueued),
                onToolStart: wrapProgressCallback(params.replyOptions?.onToolStart, {
                  allowWhenToolSummariesHidden:
                    params.replyOptions?.allowToolLifecycleWhenProgressHidden === true,
                  forwardWhenSourceDeliverySuppressed: true,
                  requiresToolSummaryVisibility: true,
                  waitForDirectBlockReplyDelivery: true,
                  onForward: async () => {
                    // Commentary precedes the tool that follows it.
                    await flushPendingCommentaryProgress();
                  },
                }),
                onItemEvent: state.onItemEvent,
                commentaryProgressEnabled:
                  state.deliverStandaloneCommentaryProgress ||
                  state.canForwardSuppressedSourceItemEvents ||
                  params.replyOptions?.commentaryProgressEnabled,
                reasoningPayloadsEnabled,
                commentaryPayloadsEnabled,
                onCommandOutput: wrapProgressCallback(params.replyOptions?.onCommandOutput, {
                  forwardWhenSourceDeliverySuppressed: true,
                  requiresToolSummaryVisibility: true,
                  waitForDirectBlockReplyDelivery: true,
                }),
                onCompactionStart: wrapProgressCallback(params.replyOptions?.onCompactionStart, {
                  allowWhenToolSummariesHidden:
                    params.replyOptions?.allowToolLifecycleWhenProgressHidden === true,
                  forwardWhenSourceDeliverySuppressed: true,
                  requiresToolSummaryVisibility: true,
                  waitForDirectBlockReplyDelivery: true,
                }),
                onCompactionEnd: wrapProgressCallback(params.replyOptions?.onCompactionEnd, {
                  allowWhenToolSummariesHidden:
                    params.replyOptions?.allowToolLifecycleWhenProgressHidden === true,
                  forwardWhenSourceDeliverySuppressed: true,
                  requiresToolSummaryVisibility: true,
                  waitForDirectBlockReplyDelivery: true,
                }),
                onToolResult: (payload) => {
                  if (state.replyOperationRunState.heartbeat) {
                    return Promise.resolve();
                  }
                  state.getDispatchReplyOperation()?.recordActivity();
                  markProgress();
                  const run = async () => {
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    await waitForPendingDirectBlockReplyDelivery(
                      getDispatchAbortOperation()?.abortSignal,
                    );
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    markInboundDedupeReplayUnsafe();
                    // Buffered commentary preceded this tool; land it before the summary.
                    await flushPendingCommentaryProgress();
                    const isFastModeAutoProgress = isFastModeAutoProgressPayload(payload);
                    const isForcedToolProgress =
                      state.shouldDeliverForcedToolProgressDespiteSourceSuppression();
                    const forceToolResultProgress =
                      params.replyOptions?.forceToolResultProgress === true;
                    const allowProgressCallbacksWhenSourceDeliverySuppressed =
                      params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed ===
                        true && ctx.InboundEventKind !== "room_event";
                    const durableToolResult = requiresDurableToolResultDelivery(payload);
                    const requiresDurableToolResult = forceToolResultProgress && durableToolResult;
                    const shouldDeliverFastModeAutoProgress =
                      isFastModeAutoProgress &&
                      ((!state.suppressAutomaticSourceDelivery &&
                        (forceToolResultProgress || state.shouldSendToolSummaries())) ||
                        isForcedToolProgress ||
                        state.shouldDeliverVerboseProgressDespiteSourceSuppression());
                    if (params.replyOptions?.suppressToolProgressMessages && !durableToolResult) {
                      return;
                    }
                    const shouldForwardToolResultProgress = forceToolResultProgress
                      ? !requiresDurableToolResult &&
                        (isFastModeAutoProgress || !state.shouldEmitVerboseProgress()) &&
                        shouldForwardProgressCallback({
                          forwardWhenSourceDeliverySuppressed:
                            allowProgressCallbacksWhenSourceDeliverySuppressed,
                        })
                      : (state.shouldSendToolSummaries() ||
                          (isFastModeAutoProgress &&
                            params.replyOptions?.allowToolLifecycleWhenProgressHidden === true)) &&
                        shouldForwardProgressCallback(
                          isFastModeAutoProgress
                            ? {
                                forwardWhenSourceDeliverySuppressed:
                                  allowProgressCallbacksWhenSourceDeliverySuppressed,
                              }
                            : undefined,
                        );
                    const toolResultProgressCallback = shouldForwardToolResultProgress
                      ? onToolResultFromReplyOptions
                      : undefined;
                    let toolResultProgressVisible = false;
                    if (toolResultProgressCallback) {
                      toolResultProgressVisible = (
                        await settleProgressVisibilityCallbackResult(
                          toolResultProgressCallback(payload),
                        )
                      ).visible;
                    }
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    if (
                      toolResultProgressCallback &&
                      forceToolResultProgress &&
                      !isFastModeAutoProgress
                    ) {
                      return;
                    }
                    if (toolResultProgressCallback && isFastModeAutoProgress) {
                      if (toolResultProgressVisible || !shouldDeliverFastModeAutoProgress) {
                        return;
                      }
                    }
                    if (state.sendPolicyDenied) {
                      return;
                    }
                    const bypassToolSummarySuppression =
                      isForcedToolProgress || shouldDeliverFastModeAutoProgress;
                    if (
                      state.shouldSuppressProgressDelivery() &&
                      !bypassToolSummarySuppression &&
                      !hasAskUserPayload(payload)
                    ) {
                      return;
                    }
                    const visibleToolPayload = preparePayload(
                      dispatcher,
                      "tool",
                      bypassToolSummarySuppression ? payload : resolveToolDeliveryPayload(payload),
                      state.progressState,
                    );
                    if (!visibleToolPayload) {
                      return;
                    }
                    const ttsPayload = await maybeApplyTtsWithFinalizationLease({
                      payload: visibleToolPayload,
                      cfg,
                      channel: deliveryChannel,
                      kind: "tool",
                      ttsAuto: sessionTtsAuto,
                      agentId: sessionAgentId,
                      accountId: replyRoute.accountId,
                    });
                    const normalizedPayload = await normalizeReplyMediaPayload(ttsPayload);
                    const deliveryPayload = bypassToolSummarySuppression
                      ? normalizedPayload
                      : resolveToolDeliveryPayload(normalizedPayload);
                    if (!deliveryPayload) {
                      return;
                    }
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    if (
                      state.shouldSuppressLateTextOnlyToolProgress(deliveryPayload) &&
                      !bypassToolSummarySuppression
                    ) {
                      return;
                    }
                    if (state.shouldSuppressMessageToolOnlyTextErrorProgress(deliveryPayload)) {
                      return;
                    }
                    if (
                      shouldSuppressDefaultToolProgressMessages() &&
                      !bypassToolSummarySuppression
                    ) {
                      if (!requiresDurableToolResultDelivery(deliveryPayload)) {
                        return;
                      }
                    }
                    const askUserQuestionId = readAskUserQuestionId(deliveryPayload);
                    if (
                      askUserQuestionId !== undefined &&
                      !(await isAskUserPromptPending(askUserQuestionId))
                    ) {
                      return;
                    }
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    if (shouldRouteToOriginating) {
                      await sendPayloadAsync(deliveryPayload, undefined, false);
                    } else {
                      const delivery = state.turnLedger.sendQueued("tool", deliveryPayload);
                      if (hasAskUserPayload(deliveryPayload)) {
                        await requireQueuedReplyDelivery({
                          delivery,
                          dispatcher,
                          abortSignal: getDispatchAbortOperation()?.abortSignal,
                        });
                      }
                    }
                  };
                  return run();
                },
                onPlanUpdate: async (payload) => {
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  const steps = normalizeAgentPlanSteps(payload.steps);
                  const normalized = {
                    phase: payload.phase,
                    title: payload.title,
                    explanation: payload.explanation,
                    ...(payload.explanationFormat
                      ? { explanationFormat: payload.explanationFormat }
                      : {}),
                    steps,
                    source: payload.source,
                  };
                  markProgress();
                  await waitForPendingDirectBlockReplyDelivery(
                    getDispatchAbortOperation()?.abortSignal,
                  );
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  markInboundDedupeReplayUnsafe();
                  if (
                    shouldForwardProgressCallback({
                      forwardWhenSourceDeliverySuppressed: true,
                      requiresToolSummaryVisibility: true,
                    })
                  ) {
                    await state.onPlanUpdateFromReplyOptions?.(normalized);
                  }
                  if (isDispatchOperationAborted()) {
                    return;
                  }
                  if (payload.phase !== "update" || shouldSuppressDefaultToolProgressMessages()) {
                    return;
                  }
                  await state.sendPlanUpdate({
                    explanation: normalized.explanation,
                    explanationFormat: normalized.explanationFormat,
                    steps,
                  });
                },
                onApprovalEvent: (payload) =>
                  forwardToolProgress(() => state.onApprovalEventFromReplyOptions?.(payload)),
                onPatchSummary: (payload) =>
                  forwardToolProgress(() => state.onPatchSummaryFromReplyOptions?.(payload)),
                onBlockReply,
                onPreparedBlockReply,
              },
              state.preparedReplyDispatchRuntime && !params.configOverride
                ? undefined
                : replyConfig,
            );
            // Register before finalization can fail. Queue admission is not
            // delivery: adapters may adopt until the dispatcher drains.
            for (const reply of Array.isArray(result) ? result : result ? [result] : []) {
              const continuation = getReplyPayloadMetadata(reply)?.progressContinuation;
              if (continuation) {
                if (isDispatchOperationAborted()) {
                  // The resolver may finish after its caller's abort race settled.
                  continuation.close();
                } else {
                  registerReplyDispatcherSettledTask(dispatcher, continuation.close);
                }
              }
            }
            return result;
          }),
        trackDispatchLifecycleWork,
      ).then(
        async (result) => {
          await flushBlockTtsText();
          return result;
        },
        async (error: unknown) => {
          await flushBlockTtsText();
          throw error;
        },
      ),
  ).catch(async (error: unknown) => {
    await releasePendingContinuation();
    await flushDeferredFinalText();
    const failedAgentRun = getAgentRunTerminalOutcome() === "failed";
    const adopted = state.turnAdoptionState?.adopted === true;
    if (
      params.replyOptions?.isHeartbeat === true ||
      (!failedAgentRun && !didDeliverVisiblePartialReply && !adopted) ||
      isDispatchOperationAborted()
    ) {
      throw error;
    }
    failDispatchReplyOperation(error, "failed");
    if (!didDeliverVisiblePartialReply) {
      // Adoption retires ingress replay before the model starts. A progress ACK
      // cannot settle a later failure; use normal final delivery and its policy.
      return adopted &&
        state.replyOperationRunState.replyCompletion?.expectation === "required" &&
        state.replyOperationRunState.replyCompletion.outcome !== "blocked" &&
        !state.suppressDelivery &&
        !state.getObservedReplyDelivery()
        ? { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, isError: true }
        : undefined;
    }
    return buildTerminalAgentRunFailureReplyPayload({
      replyExpectation: state.replyOperationRunState.replyCompletion?.expectation ?? "required",
      visibleReplyDelivered: true,
    });
  });
  try {
    if (isDispatchOperationAborted()) {
      await flushDeferredFinalText();
    }
    const sessionMetadataChanges = takeCommandSessionMetadataChanges(ctx);
    notifySessionMetadataChanges(sessionMetadataChanges);
    const resolvedCommandReply = isCommandReplyForDelivery(replyResult);
    const finalDispatchAcquisition = resolvedCommandReply
      ? ({ status: "ready" } as const)
      : await state.ensureDispatchReplyOperation("dispatch");
    if (finalDispatchAcquisition.status === "aborted") {
      return { status: "complete" as const, result: state.finishReplyOperationAbortedDispatch() };
    }
    if (finalDispatchAcquisition.status === "busy") {
      return {
        status: "complete" as const,
        result: state.finishReplyOperationBusyDispatch({
          recordAgentDispatchCompleted: true,
          ...(state.routeState.sessionMetadataChangesForResult
            ? { sessionMetadataChanges: state.routeState.sessionMetadataChangesForResult }
            : {}),
        }),
      };
    }

    const acpTailResult = await handleAcpDispatchTailAfterReset(state);
    if (acpTailResult) {
      return acpTailResult;
    }
    const nextState = extendPreparedDispatchState(state, {
      pendingContinuation,
      pendingContinuationSettlement,
      replyResult,
    });
    // Finalization now owns the exact settlement; earlier returns and throws release it here.
    pendingContinuationSettlement = undefined;
    return { status: "ready" as const, state: nextState };
  } finally {
    await releasePendingContinuation();
  }
}
