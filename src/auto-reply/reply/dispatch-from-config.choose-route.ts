import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { scopeCommandTranscriptId } from "../../config/sessions/command-transcript.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withClaimingHookAdmission } from "../../plugins/hook-claim-admission.js";
import { createPluginSubagentRequesterContext } from "../../plugins/runtime/subagent-requester-context.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../sessions/input-provenance.js";
import {
  buildCaptionedFinalTextFallback,
  cleanDeferredFinalText,
  isCaptionedFinalTextPayload,
  mergeDeferredFinalText,
  shouldDeferFinalTtsText,
} from "../../tts/captioned-final.js";
import { shouldCleanTtsDirectiveText } from "../../tts/tts-config.js";
import { registerReplyDispatcherSettledTask } from "../dispatch-dispatcher.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";
import { renderPostCompactionModelFailurePayload } from "./agent-runner-failure-reply.js";
import { recoverBlockReplySources, setBlockReplyDelivery } from "./block-reply-delivery.js";
import { createBlockReplyContentKey } from "./block-reply-pipeline.js";
import { resolveCommandContextText } from "./context-text.js";
import {
  DispatchReplyOperationAbortedError,
  runWithDispatchAbortSignal,
} from "./dispatch-from-config.abort.js";
import { admittedSessionSettingsRestrictRuntime } from "./dispatch-from-config.events.js";
import { suppressPendingFinalDelivery } from "./dispatch-from-config.pending-final.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import { createDispatchProgress } from "./dispatch-from-config.progress.js";
import { runReplyDispatchHook } from "./dispatch-from-config.reply-dispatch-hook.js";
import { createSessionMetadataChangeNotifier } from "./dispatch-from-config.session-metadata.js";
import {
  captureDeliveredTranscriptMirror,
  mirrorDeliveredReplyToTranscript,
  transcriptMirrorForDeliveredPayload,
} from "./dispatch-from-config.transcript.js";
import type { NormalizeReplySkipReason } from "./normalize-reply.js";
import {
  resolveRoutedReplyDeliveryOutcome,
  shouldRetryReplyDispatch,
} from "./reply-dispatch-outcome.js";
import {
  attachReplyDispatchUndeliveredFallback,
  prepareReplyPayloadForDispatcher,
  type ReplyDispatchDeliveryOutcome,
} from "./reply-dispatcher.js";
import type { ReplyDispatchOperation } from "./reply-dispatcher.types.js";
import { isDispatchFinalReplySessionWriterAuthorized } from "./session-writer-delivery-authority.js";

export async function chooseDispatchRoute(state: PrepareDispatchOperationReadyState) {
  const {
    acpDispatchSessionKey,
    attachSourceReplyDeliveryMode,
    cfg,
    commitInboundDedupeIfClaimed,
    completeDispatchReplyOperation,
    ctx,
    deliveryChannel,
    dispatcher,
    getPreDispatchAbortSignal,
    hookRunner,
    isRoutedReplyDelivered,
    markIdle,
    markInboundDedupeReplayUnsafe,
    params,
    recordProcessed,
    replyContextAccountId,
    replyRoute,
    resolvePreparedTranscriptBinding,
    routeReplyChannel,
    routeReplyThreadId,
    routeReplyTo,
    runWithDispatchLifecycleAdmission,
    sendPayloadAsync,
    sessionAgentId,
    sessionKey,
    sessionStoreEntry,
    sessionTtsAuto,
    traceReplyPhase,
    trackDispatchLifecycleWork,
    turnLedger,
  } = state;
  const { notifySessionMetadataChanges, routeState } = createSessionMetadataChangeNotifier(
    params.onSessionMetadataChanges,
  );
  const {
    shouldSuppressProgressDelivery,
    shouldSuppressProgressDeliverySync,
    shouldSendToolSummaries,
    shouldSendToolSummariesAsync,
    shouldDeliverVerboseProgressDespiteSourceSuppression,
    shouldDeliverForcedToolProgressDespiteSourceSuppression,
    shouldSuppressLateTextOnlyToolProgress,
    flushPendingCommentaryProgress,
    noteCommentaryProgress,
    shouldSuppressMessageToolOnlyTextErrorProgress,
    markFinalReplyDeliveryStarted,
  } = createDispatchProgress(state);
  const isSessionWriterDeliveryAuthorized = (payload: ReplyPayload) =>
    isDispatchFinalReplySessionWriterAuthorized(payload, sessionStoreEntry.storePath, sessionKey);
  const captionedFinalTtsContext = {
    cfg,
    preparedTtsPreferences: state.preparedTtsPreferences,
    ttsAuto: sessionTtsAuto,
    agentId: sessionAgentId,
    channelId: deliveryChannel,
    accountId: replyRoute.accountId,
    inboundAudio: state.inboundAudio,
  };
  const deferFinalTtsText = shouldDeferFinalTtsText(captionedFinalTtsContext);
  let commandReplyIndex = 0;
  const commandBlockMirror = (payload: ReplyPayload) => {
    const metadata = getReplyPayloadMetadata(payload);
    const commandText = normalizeOptionalString(resolveCommandContextText(ctx));
    const commandId = scopeCommandTranscriptId(
      normalizeOptionalString(state.messageIdForHook),
      state.hookState.inboundClaimContext,
    );
    if (
      (state.isInternalWebchatTurn && params.replyOptions?.userTurnTranscriptRecorder) ||
      ctx.CommandInterpretationSuppressed ||
      !commandText?.startsWith("/") ||
      !commandId ||
      Boolean(metadata?.inlineCommandReply || metadata?.assistantTranscriptOwned) ||
      metadata?.assistantMessageIndex !== undefined
    ) {
      return undefined;
    }
    const targetKey = acpDispatchSessionKey ?? sessionStoreEntry.sessionKey ?? sessionKey;
    if (!targetKey) {
      return undefined;
    }
    const binding = resolvePreparedTranscriptBinding(targetKey);
    return transcriptMirrorForDeliveredPayload(
      {
        sessionKey: targetKey,
        agentId: sessionAgentId,
        expectedSessionId: binding?.sessionId,
        storePath: binding?.storePath ?? sessionStoreEntry.storePath,
        commandText,
        commandId,
        preferText: true,
        idempotencyKey: `command-block:${commandId}:${++commandReplyIndex}`,
        deliveryMirror: { kind: "channel-final", sourceMessageId: commandId },
      },
      payload,
    );
  };
  const cleanDeferredFinalDirectives = shouldCleanTtsDirectiveText(captionedFinalTtsContext);
  type BlockDelivery = { outcome: ReplyDispatchDeliveryOutcome; pending?: boolean };
  const blockDeliveryOutcomes = new Map<string, Array<Promise<BlockDelivery>>>();
  const recordBlockOutcome = (payload: ReplyPayload, outcome: Promise<BlockDelivery>) => {
    setBlockReplyDelivery(outcome, payload);
    if (getReplyPayloadMetadata(payload)?.independentDeliveryIntentId !== undefined) {
      return;
    }
    const key = createBlockReplyContentKey(payload);
    const outcomes = blockDeliveryOutcomes.get(key) ?? [];
    outcomes.push(outcome);
    blockDeliveryOutcomes.set(key, outcomes);
  };
  const sendTrackedBlockReply = (operation: ReplyDispatchOperation) => {
    const payload = operation.kind === "prepared" ? operation.plan.payload : operation.payload;
    const mirror = commandBlockMirror(payload);
    const captureToken = mirror ? {} : undefined;
    const deliveredMirror = captureDeliveredTranscriptMirror({
      dispatcher,
      metadata: mirror,
      captureToken,
      kind: "block",
    });
    if (captureToken) {
      setReplyPayloadMetadata(payload, { finalDeliveryCapture: captureToken });
    }
    const delivery =
      operation.kind === "prepared"
        ? turnLedger.sendPreparedQueued("block", operation.plan)
        : turnLedger.sendQueued("block", payload);
    recordBlockOutcome(
      payload,
      delivery.queued
        ? (delivery.outcome?.then((outcome) => ({
            outcome,
            pending: delivery.hasPendingDelivery?.(),
          })) ?? Promise.resolve({ outcome: "failed-deliver" }))
        : Promise.resolve({ outcome: "cancelled" }),
    );
    if (mirror && delivery.queued && delivery.outcome) {
      registerReplyDispatcherSettledTask(dispatcher, async () => {
        if ((await delivery.outcome) === "delivered") {
          await mirrorDeliveredReplyToTranscript({ metadata: deliveredMirror(), cfg });
        }
      });
    }
    return delivery;
  };
  const recordRoutedBlockReplyDelivery = (
    payload: ReplyPayload,
    result: Awaited<ReturnType<typeof sendPayloadAsync>>,
  ): ReplyDispatchDeliveryOutcome | undefined => {
    if (!result) {
      recordBlockOutcome(payload, Promise.resolve({ outcome: "cancelled" }));
      return undefined;
    }
    const outcome = resolveRoutedReplyDeliveryOutcome(result);
    if (outcome === "delivered") {
      const metadata = commandBlockMirror(payload);
      if (metadata) {
        registerReplyDispatcherSettledTask(dispatcher, () =>
          mirrorDeliveredReplyToTranscript({ metadata, cfg }),
        );
      }
    }
    recordBlockOutcome(
      payload,
      Promise.resolve({
        outcome,
        pending: result.queueCustody === "held" || result.ambiguous === true,
      }),
    );
    return outcome;
  };
  const getBlockReplyOutcome = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
  ): Promise<BlockDelivery | undefined> => {
    const outcomes = blockDeliveryOutcomes.get(createBlockReplyContentKey(payload));
    if (!outcomes || abortSignal?.aborted) {
      return undefined;
    }
    const settled = await runWithDispatchAbortSignal(abortSignal, () => Promise.all(outcomes));
    return (
      settled.find(({ outcome }) => outcome === "delivered") ??
      settled.find(({ outcome, pending }) => pending || !shouldRetryReplyDispatch(outcome)) ??
      settled[0]
    );
  };
  const sendFinalPayload = async (
    inputPayload: ReplyPayload,
    options: {
      abortSignal?: AbortSignal | false;
      deliveryId?: string;
      deferredTtsText?: string;
      skipTts?: boolean;
    } = {},
  ): Promise<{
    blockDeliveryOutcome?: ReplyDispatchDeliveryOutcome;
    pendingBlock?: boolean;
    queuedFinal: boolean;
    routedFinalCount: number;
    suppressionReason?: NormalizeReplySkipReason;
    sessionWriterDeliveryRevoked?: true;
    dispatcherOutcome?: Promise<ReplyDispatchDeliveryOutcome>;
    routedOutcome?: ReplyDispatchDeliveryOutcome;
  }> => {
    const abortSignal =
      options.abortSignal === false
        ? undefined
        : (options.abortSignal ?? state.getDispatchAbortSignal());
    const throwIfFinalDeliveryAborted = () => {
      if (abortSignal?.aborted) {
        throw new DispatchReplyOperationAbortedError();
      }
    };
    throwIfFinalDeliveryAborted();
    // Trailing commentary must land ahead of the final answer.
    await flushPendingCommentaryProgress();
    throwIfFinalDeliveryAborted();
    const preparation = prepareReplyPayloadForDispatcher(dispatcher, "final", inputPayload);
    if (preparation.kind === "suppress") {
      await suppressPendingFinalDelivery(inputPayload, {
        preserveActivity: shouldPreserveUserFacingSessionStateForInputProvenance(
          state.ctx.InputProvenance,
        ),
      });
      return {
        queuedFinal: false,
        routedFinalCount: 0,
        suppressionReason: preparation.reason,
      };
    }
    const payload = renderPostCompactionModelFailurePayload(preparation.payload);
    const payloadMetadata = getReplyPayloadMetadata(payload);
    const expectedWriterRunId = normalizeOptionalString(params.replyOptions?.runId);
    const expectedLifecycleRevision = sessionStoreEntry.entry?.lifecycleRevision;
    const transcriptWriterMetadata = (
      binding: ReturnType<typeof resolvePreparedTranscriptBinding>,
    ) => ({
      ...(binding ? { expectedSessionId: binding.sessionId } : {}),
      ...(expectedLifecycleRevision !== undefined ? { expectedLifecycleRevision } : {}),
      ...(expectedWriterRunId ? { expectedWriterRunId } : {}),
      storePath: binding?.storePath ?? sessionStoreEntry.storePath,
    });
    const sourceReplySessionBinding = resolvePreparedTranscriptBinding(
      payloadMetadata?.sourceReplyTranscriptMirror?.sessionKey,
    );
    let sourceReplyTranscriptMirror: Parameters<
      typeof mirrorDeliveredReplyToTranscript
    >[0]["metadata"] = payloadMetadata?.sourceReplyTranscriptMirror
      ? {
          ...payloadMetadata.sourceReplyTranscriptMirror,
          ...transcriptWriterMetadata(sourceReplySessionBinding),
        }
      : undefined;
    const hasTranscriptOwner =
      payloadMetadata?.assistantMessageIndex !== undefined ||
      Boolean(payloadMetadata?.inlineCommandReply || payloadMetadata?.assistantTranscriptOwned);
    const hasVisibleFinalContent = hasOutboundReplyContent(payload, { trimText: true });
    if (hasVisibleFinalContent) {
      markInboundDedupeReplayUnsafe();
      markFinalReplyDeliveryStarted();
    }
    const shouldAttachDeferredText = deferFinalTtsText && isCaptionedFinalTextPayload(payload);
    const deferredRawText = shouldAttachDeferredText
      ? mergeDeferredFinalText(options.deferredTtsText ?? "", payload.text)
      : undefined;
    const ttsInputPayload = shouldAttachDeferredText
      ? copyReplyPayloadMetadata(payload, {
          ...payload,
          text: deferredRawText,
        })
      : payload;
    const deferredVisibleText = shouldAttachDeferredText
      ? cleanDeferredFinalDirectives
        ? cleanDeferredFinalText(deferredRawText)
        : deferredRawText
      : undefined;
    let appliedTtsPayload = payload;
    if (!options.skipTts && payload.isReasoning !== true && payload.isCommentary !== true) {
      try {
        appliedTtsPayload = await state.maybeApplyTtsWithFinalizationLease(
          ttsInputPayload,
          "final",
        );
      } catch (error) {
        if (!shouldAttachDeferredText) {
          throw error;
        }
        logVerbose(`dispatch-from-config: final TTS failed: ${formatErrorMessage(error)}`);
      }
    }
    const ttsPayload = shouldAttachDeferredText
      ? copyReplyPayloadMetadata(appliedTtsPayload, {
          ...appliedTtsPayload,
          text: deferredVisibleText || undefined,
        })
      : appliedTtsPayload;
    throwIfFinalDeliveryAborted();
    let normalizedPayload: ReplyPayload;
    try {
      normalizedPayload = await state.normalizeReplyMediaPayload(ttsPayload);
    } catch (error) {
      if (!shouldAttachDeferredText || !deferredVisibleText) {
        throw error;
      }
      logVerbose(`dispatch-from-config: media normalization failed: ${formatErrorMessage(error)}`);
      normalizedPayload = buildCaptionedFinalTextFallback(ttsPayload);
    }
    throwIfFinalDeliveryAborted();
    const sourceRecovery = getReplyPayloadMetadata(payload)?.blockReplySources;
    let block: BlockDelivery | undefined;
    if (sourceRecovery) {
      const recovery = await runWithDispatchAbortSignal(abortSignal, () =>
        recoverBlockReplySources(normalizedPayload, sourceRecovery),
      );
      normalizedPayload = recovery.payload;
      block = recovery.delivery;
    } else {
      block = await getBlockReplyOutcome(payload, abortSignal);
    }
    throwIfFinalDeliveryAborted();
    const blockDeliveryOutcome = block?.outcome;
    const pendingBlock = block?.pending && blockDeliveryOutcome !== "delivered";
    if (blockDeliveryOutcome && (pendingBlock || !shouldRetryReplyDispatch(blockDeliveryOutcome))) {
      if (
        blockDeliveryOutcome === "channel-transform" ||
        (blockDeliveryOutcome === "failed-deliver" && !pendingBlock && !sourceRecovery) ||
        createBlockReplyContentKey(normalizedPayload) === createBlockReplyContentKey(payload)
      ) {
        return { blockDeliveryOutcome, pendingBlock, queuedFinal: false, routedFinalCount: 0 };
      }
      // The block already owns the text. Preserve final-only media without
      // letting an audio receipt finalize the block's pending text completion.
      normalizedPayload = copyReplyPayloadMetadata(normalizedPayload, {
        ...normalizedPayload,
        text: undefined,
      });
      if (pendingBlock) {
        await suppressPendingFinalDelivery(payload, {
          preserveActivity: shouldPreserveUserFacingSessionStateForInputProvenance(
            state.ctx.InputProvenance,
          ),
        });
      }
      if (pendingBlock || sourceRecovery) {
        setReplyPayloadMetadata(normalizedPayload, { pendingFinalDeliveryCompletion: undefined });
        sourceReplyTranscriptMirror = sourceReplyTranscriptMirror
          ? transcriptMirrorForDeliveredPayload(sourceReplyTranscriptMirror, normalizedPayload)
          : undefined;
      }
      if (!hasOutboundReplyContent(normalizedPayload, { trimText: true })) {
        return { blockDeliveryOutcome, pendingBlock, queuedFinal: false, routedFinalCount: 0 };
      }
    }
    if (!isSessionWriterDeliveryAuthorized(normalizedPayload)) {
      return { queuedFinal: false, routedFinalCount: 0, sessionWriterDeliveryRevoked: true };
    }
    const transcriptMirrorSessionKey =
      acpDispatchSessionKey ?? sessionStoreEntry.sessionKey ?? sessionKey;
    const transcriptMirrorSourceId =
      normalizeOptionalString(state.messageIdForHook) ??
      normalizeOptionalString(params.replyOptions?.runId);
    const transcriptMirrorSessionBinding = resolvePreparedTranscriptBinding(
      transcriptMirrorSessionKey,
    );
    const commandText = ctx.CommandInterpretationSuppressed
      ? undefined
      : normalizeOptionalString(resolveCommandContextText(ctx));
    const isCommandReply =
      !(state.isInternalWebchatTurn && params.replyOptions?.userTurnTranscriptRecorder) &&
      !hasTranscriptOwner &&
      commandText?.startsWith("/");
    const commandId = isCommandReply
      ? scopeCommandTranscriptId(transcriptMirrorSourceId, state.hookState.inboundClaimContext)
      : undefined;
    const transcriptMirror =
      sourceReplyTranscriptMirror ??
      ((state.normalizedCurrentSurface === "slack" || isCommandReply) &&
      hasVisibleFinalContent &&
      transcriptMirrorSessionKey
        ? transcriptMirrorForDeliveredPayload(
            {
              sessionKey: transcriptMirrorSessionKey,
              agentId: sessionAgentId,
              ...transcriptWriterMetadata(transcriptMirrorSessionBinding),
              preferText: true,
              ...(isCommandReply && commandText && commandId ? { commandText, commandId } : {}),
              ...(hasTranscriptOwner ? { transcriptOwner: true } : {}),
              idempotencyKey: transcriptMirrorSourceId
                ? `channel-final:${commandId ?? transcriptMirrorSourceId}:${options.deliveryId ?? "single"}`
                : undefined,
              deliveryMirror: {
                kind: "channel-final",
                ...(transcriptMirrorSourceId ? { sourceMessageId: transcriptMirrorSourceId } : {}),
              },
            },
            normalizedPayload,
          )
        : undefined);
    const routeFinalPayload = (finalPayload: ReplyPayload) =>
      state.routeReplyToOriginating(finalPayload, {
        abortSignal,
        kind: "final",
        ...(hasTranscriptOwner || isCommandReply ? { mirror: false } : {}),
      });
    let result = await routeFinalPayload(normalizedPayload);
    if (result) {
      let routedOutcome = resolveRoutedReplyDeliveryOutcome(result);
      if (!result.ok) {
        logVerbose(
          `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
        );
      }
      const fallbackText =
        deferFinalTtsText && normalizedPayload.mediaUrl
          ? normalizeOptionalString(normalizedPayload.text)
          : undefined;
      if (fallbackText && shouldRetryReplyDispatch(routedOutcome)) {
        if (!isSessionWriterDeliveryAuthorized(normalizedPayload)) {
          return { queuedFinal: false, routedFinalCount: 0, sessionWriterDeliveryRevoked: true };
        }
        result =
          (await routeFinalPayload(
            copyReplyPayloadMetadata(normalizedPayload, { text: fallbackText }),
          )) ?? result;
        routedOutcome = resolveRoutedReplyDeliveryOutcome(result);
      }
      if (isRoutedReplyDelivered(result)) {
        await mirrorDeliveredReplyToTranscript({
          metadata: isCommandReply ? transcriptMirror : sourceReplyTranscriptMirror,
          cfg,
        });
      }
      return {
        blockDeliveryOutcome: sourceRecovery ? blockDeliveryOutcome : undefined,
        pendingBlock,
        queuedFinal: result.ok,
        routedFinalCount: isRoutedReplyDelivered(result) ? 1 : 0,
        routedOutcome,
        ...(result.reason === "channel_transform"
          ? { suppressionReason: "channel_transform" as const }
          : {}),
      };
    }
    throwIfFinalDeliveryAborted();
    if (!isSessionWriterDeliveryAuthorized(normalizedPayload)) {
      return { queuedFinal: false, routedFinalCount: 0, sessionWriterDeliveryRevoked: true };
    }
    markInboundDedupeReplayUnsafe();
    const finalDeliveryCapture = transcriptMirror ? {} : undefined;
    const deliveredTranscriptMirror = transcriptMirror
      ? captureDeliveredTranscriptMirror({
          dispatcher,
          metadata: transcriptMirror,
          captureToken: finalDeliveryCapture,
        })
      : undefined;
    if (finalDeliveryCapture) {
      setReplyPayloadMetadata(normalizedPayload, { finalDeliveryCapture });
    }
    if (deferFinalTtsText && normalizedPayload.mediaUrl && normalizedPayload.text?.trim()) {
      attachReplyDispatchUndeliveredFallback(
        normalizedPayload,
        buildCaptionedFinalTextFallback(normalizedPayload),
      );
    }
    const { queued: queuedFinal, outcome: dispatcherOutcome } = turnLedger.sendQueued(
      "final",
      normalizedPayload,
    );
    if (queuedFinal && deliveredTranscriptMirror && dispatcherOutcome) {
      // The common settle owner runs this after successful delivery or
      // cancellation. Keeping reconciliation out of the reply operation avoids
      // creating another operation/idle cycle during delivery settlement.
      registerReplyDispatcherSettledTask(dispatcher, async () => {
        if ((await dispatcherOutcome) === "delivered") {
          await mirrorDeliveredReplyToTranscript({ metadata: deliveredTranscriptMirror(), cfg });
        }
      });
    }
    return {
      blockDeliveryOutcome: sourceRecovery ? blockDeliveryOutcome : undefined,
      pendingBlock,
      queuedFinal,
      routedFinalCount: 0,
      ...(queuedFinal && dispatcherOutcome ? { dispatcherOutcome } : {}),
    };
  };

  let takeover:
    | { payload: ReplyPayload; deliveryId: string; recordProcessed: () => void }
    | undefined;
  if (
    state.allowInboundHandlers &&
    !admittedSessionSettingsRestrictRuntime(params.replyOptions?.admittedSessionSettings) &&
    hookRunner?.hasHooks("before_dispatch")
  ) {
    // This outer lookup key is resolved from the routed context; fields inside
    // sessionStoreEntry.entry cannot redirect hook or requester lineage.
    const beforeDispatchSessionKey = sessionStoreEntry.sessionKey ?? sessionKey;
    const pluginSubagentRequester = createPluginSubagentRequesterContext({
      sessionKey: beforeDispatchSessionKey,
      origin: {
        channel: routeReplyChannel,
        to: routeReplyTo,
        accountId: replyContextAccountId,
        threadId: routeReplyThreadId,
      },
    });
    const beforeDispatchResult = await traceReplyPhase("reply.before_dispatch_hooks", () =>
      runWithDispatchLifecycleAdmission(async () => {
        return await runWithDispatchAbortSignal(
          getPreDispatchAbortSignal(),
          () => {
            const hookContext = state.hookState.hookContext;
            const replyContext = {
              messageId: hookContext.messageId,
              sessionKey: beforeDispatchSessionKey,
              senderId: hookContext.senderId,
              replyToId: hookContext.replyToId,
              replyToIdFull: hookContext.replyToIdFull,
              replyToBody: hookContext.replyToBody,
              replyToSender: hookContext.replyToSender,
              replyToIsQuote: hookContext.replyToIsQuote,
            };
            return hookRunner.runBeforeDispatch(
              {
                ...replyContext,
                content: hookContext.content,
                body: hookContext.bodyForAgent ?? hookContext.body,
                channel: hookContext.channelId,
                isGroup: hookContext.isGroup,
                timestamp: hookContext.timestamp,
              },
              withClaimingHookAdmission(
                {
                  ...replyContext,
                  channelId: hookContext.channelId,
                  accountId: hookContext.accountId,
                  conversationId: state.hookState.inboundClaimContext.conversationId,
                },
                { prepare: state.assertCurrentBindingRoute },
              ),
              pluginSubagentRequester,
            );
          },
          trackDispatchLifecycleWork,
        );
      }),
    );
    if (beforeDispatchResult?.handled) {
      takeover = {
        payload: { text: beforeDispatchResult.text },
        deliveryId: "before-dispatch",
        recordProcessed: () => recordProcessed("completed", { reason: "before_dispatch_handled" }),
      };
    }
  }

  if (
    !takeover &&
    state.dispatchKind === "acp" &&
    admittedSessionSettingsRestrictRuntime(params.replyOptions?.admittedSessionSettings)
  ) {
    const error =
      "This session's bound runtime cannot enforce its permission or tool policy; use an embedded runtime for this restricted conversation.";
    takeover = {
      payload: { text: error, isError: true },
      deliveryId: "restricted-runtime-takeover",
      recordProcessed: () =>
        state.recordProcessed("error", { reason: "restricted_runtime_takeover", error }),
    };
  }
  if (takeover) {
    const { queuedFinal, routedFinalCount } =
      takeover.payload.text && !state.suppressDelivery
        ? await sendFinalPayload(takeover.payload, {
            abortSignal: getPreDispatchAbortSignal(),
            deliveryId: takeover.deliveryId,
          })
        : { queuedFinal: false, routedFinalCount: 0 };
    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    takeover.recordProcessed();
    markIdle("message_completed");
    commitInboundDedupeIfClaimed();
    completeDispatchReplyOperation();
    return {
      status: "complete" as const,
      result: attachSourceReplyDeliveryMode({ queuedFinal, counts }),
    };
  }

  const replyDispatchTakeover = await runReplyDispatchHook(state, {
    shouldSendToolSummaries,
    shouldSendToolSummariesAsync,
  });
  if (replyDispatchTakeover?.handled) {
    commitInboundDedupeIfClaimed();
    completeDispatchReplyOperation();
    return {
      status: "complete" as const,
      result: attachSourceReplyDeliveryMode({
        queuedFinal: replyDispatchTakeover.queuedFinal,
        counts: replyDispatchTakeover.counts,
      }),
    };
  }

  const dispatchPhase = state.activeRunSafeCommandTurn ? "command_resolution" : "dispatch";
  const dispatchAcquisition = await traceReplyPhase(`reply.admit_${dispatchPhase}`, () =>
    state.ensureDispatchReplyOperation(dispatchPhase),
  );
  if (dispatchAcquisition.status === "aborted") {
    return { status: "complete" as const, result: state.finishReplyOperationAbortedDispatch() };
  }
  if (dispatchAcquisition.status === "busy") {
    return {
      status: "complete" as const,
      result: state.finishReplyOperationBusyDispatch({ dedupeDisposition: "release" }),
    };
  }
  const nextState = Object.assign(state, {
    shouldSuppressProgressDelivery,
    shouldSuppressProgressDeliverySync,
    shouldSendToolSummaries,
    shouldSendToolSummariesAsync,
    notifySessionMetadataChanges,
    shouldDeliverVerboseProgressDespiteSourceSuppression,
    shouldDeliverForcedToolProgressDespiteSourceSuppression,
    shouldSuppressLateTextOnlyToolProgress,
    flushPendingCommentaryProgress,
    noteCommentaryProgress,
    shouldSuppressMessageToolOnlyTextErrorProgress,
    sendTrackedBlockReply,
    recordRoutedBlockReplyDelivery,
    sendFinalPayload,
    isSessionWriterDeliveryAuthorized,
    deferFinalTtsText,
    routeState,
  });
  return { status: "ready" as const, state: nextState };
}

type ChooseDispatchRouteResult = Awaited<ReturnType<typeof chooseDispatchRoute>>;
export type ChooseDispatchRouteReadyState = Extract<
  ChooseDispatchRouteResult,
  { status: "ready" }
>["state"];
