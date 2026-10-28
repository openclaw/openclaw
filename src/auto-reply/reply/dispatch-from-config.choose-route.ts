import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { scopeCommandTranscriptId } from "../../config/sessions/command-transcript.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withClaimingHookAdmission } from "../../plugins/hook-claim-admission.js";
import { createPluginSubagentRequesterContext } from "../../plugins/runtime/subagent-requester-context.js";
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
import { commandTranscriptMirror } from "./channel-command-user-turn.js";
import { resolveCommandContextText } from "./context-text.js";
import {
  DispatchReplyOperationAbortedError,
  runWithDispatchAbortSignal,
} from "./dispatch-from-config.abort.js";
import type {
  SendFinalPayloadOptions,
  SendFinalPayloadOutcome,
} from "./dispatch-from-config.choose-route.types.js";
import { createDispatchCommentaryProgress } from "./dispatch-from-config.commentary.js";
import {
  acquireAcpDispatchTurn,
  acquireDispatchTurn,
} from "./dispatch-from-config.dispatch-admission.js";
import { admittedSessionSettingsRestrictRuntime } from "./dispatch-from-config.events.js";
import {
  hasExecApprovalPayload,
  requiresDurableToolResultDelivery,
} from "./dispatch-from-config.payloads.js";
import { suppressPendingFinalDelivery } from "./dispatch-from-config.pending-final.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import { runReplyDispatchHook } from "./dispatch-from-config.reply-dispatch-hook.js";
import { createSessionMetadataChangeNotifier } from "./dispatch-from-config.session-metadata.js";
import {
  mirrorDeliveredReplyToTranscript,
  sendReplyWithTranscriptMirror,
  transcriptMirrorForDeliveredPayload,
} from "./dispatch-from-config.transcript.js";
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
import {
  createSessionWriterDeliveryPreparation,
  isDispatchFinalReplySessionWriterAuthorized,
} from "./session-writer-delivery-authority.js";

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
    shouldEmitVerboseProgressAsync,
    shouldRouteToOriginating,
    traceReplyPhase,
    trackDispatchLifecycleWork,
    turnLedger,
  } = state;
  const shouldSuppressProgressDelivery = async () =>
    state.sendPolicyDenied ||
    (state.suppressDelivery && !(await shouldDeliverVerboseProgressDespiteSourceSuppression()));
  // The released reply_dispatch getter retains its synchronous contract.
  const shouldSendToolSummaries = () =>
    params.replyOptions?.suppressToolProgressMessages !== true && state.shouldEmitVerboseProgress();
  const shouldSendToolSummariesAsync = async () =>
    params.replyOptions?.suppressToolProgressMessages !== true &&
    (await shouldEmitVerboseProgressAsync());
  const { notifySessionMetadataChanges, routeState } = createSessionMetadataChangeNotifier(
    params.onSessionMetadataChanges,
  );
  const allowsVerboseProgressDespiteSourceSuppression = () =>
    state.suppressAutomaticSourceDelivery &&
    state.sourceReplyDeliveryMode === "message_tool_only" &&
    ctx.InboundEventKind !== "room_event" &&
    !state.sendPolicyDenied;
  const shouldDeliverVerboseProgressDespiteSourceSuppression = async () =>
    allowsVerboseProgressDespiteSourceSuppression() && (await shouldSendToolSummariesAsync());
  const shouldSuppressProgressDeliverySync = () =>
    state.sendPolicyDenied ||
    (state.suppressDelivery &&
      !(allowsVerboseProgressDespiteSourceSuppression() && shouldSendToolSummaries()));
  const shouldDeliverForcedToolProgressDespiteSourceSuppression = () =>
    allowsVerboseProgressDespiteSourceSuppression() &&
    params.replyOptions?.forceToolResultProgress === true;
  let finalReplyDeliveryStarted = false;
  const prepareSessionWriterDelivery = createSessionWriterDeliveryPreparation({
    storePath: sessionStoreEntry.storePath,
    retain: (release) => registerReplyDispatcherSettledTask(dispatcher, release),
  });
  const isSessionWriterDeliveryAuthorized = (payload: ReplyPayload) =>
    isDispatchFinalReplySessionWriterAuthorized(payload, sessionKey);
  const shouldSuppressLateTextOnlyToolProgress = (payload: ReplyPayload) =>
    finalReplyDeliveryStarted && !requiresDurableToolResultDelivery(payload);
  const { flushPendingCommentaryProgress, noteCommentaryProgress } =
    createDispatchCommentaryProgress({
      shouldSendToolSummaries: shouldSendToolSummariesAsync,
      shouldSuppressDelivery: shouldSuppressProgressDelivery,
      isAborted: () => state.isDispatchOperationAborted(),
      isFinalDeliveryStarted: () => finalReplyDeliveryStarted,
      assertCurrent: () => state.assertProgressCurrent(),
      send: shouldRouteToOriginating
        ? sendPayloadAsync
        : (payload) => {
            markInboundDedupeReplayUnsafe();
            turnLedger.sendQueued("tool", payload);
          },
    });
  const shouldSuppressMessageToolOnlyTextErrorProgress = async (payload: ReplyPayload) => {
    if (
      state.sourceReplyDeliveryMode !== "message_tool_only" ||
      (await state.shouldEmitFullVerboseProgressAsync()) ||
      payload.isError !== true
    ) {
      return false;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    return !reply.hasMedia && !hasExecApprovalPayload(payload);
  };
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
        ...commandTranscriptMirror(state, commandText, commandId),
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
    const delivery = sendReplyWithTranscriptMirror({
      dispatcher,
      cfg,
      metadata: commandBlockMirror(payload),
      payload,
      kind: "block",
      send: () =>
        operation.kind === "prepared"
          ? turnLedger.sendPreparedQueued("block", operation.plan)
          : turnLedger.sendQueued("block", payload),
    });
    recordBlockOutcome(
      payload,
      delivery.queued
        ? (delivery.outcome?.then((outcome) => ({
            outcome,
            pending: delivery.hasPendingDelivery?.(),
          })) ?? Promise.resolve({ outcome: "failed-deliver" }))
        : Promise.resolve({ outcome: "cancelled" }),
    );
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
    options: SendFinalPayloadOptions = {},
  ): Promise<SendFinalPayloadOutcome> => {
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
      await suppressPendingFinalDelivery(inputPayload);
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
      finalReplyDeliveryStarted = true;
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
    // An explicit empty string is a result, not a missing value: when normalization or a
    // channel transform clears the caption, callers must speak nothing rather than fall
    // back to the raw reply they were handed. The value is finalized once normalization
    // has run below; this is only the pre-normalization reading.
    let preparedSpeechText = ttsInputPayload.text ?? "";
    // Nothing left this lane: the block already delivered it, or it holds no content.
    const notDeliveredHere = () => ({
      blockDeliveryOutcome,
      pendingBlock,
      preparedSpeechText,
      queuedFinal: false,
      routedFinalCount: 0,
    });
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
    // Speak what delivery prepared: normalization has stripped silent tokens and the
    // media pass may have rewritten the caption. A recording cannot be normalized after
    // it is made, so the speech text has to be read from the payload that will be sent,
    // not from the reply the model produced.
    preparedSpeechText = normalizedPayload.text ?? "";
    throwIfFinalDeliveryAborted();
    const blockDeliveryOutcome = block?.outcome;
    const pendingBlock = block?.pending && blockDeliveryOutcome !== "delivered";
    if (blockDeliveryOutcome && (pendingBlock || !shouldRetryReplyDispatch(blockDeliveryOutcome))) {
      if (
        blockDeliveryOutcome === "channel-transform" ||
        (blockDeliveryOutcome === "failed-deliver" && !pendingBlock && !sourceRecovery) ||
        createBlockReplyContentKey(normalizedPayload) === createBlockReplyContentKey(payload)
      ) {
        return notDeliveredHere();
      }
      // The block already owns the text. Preserve final-only media without
      // letting an audio receipt finalize the block's pending text completion.
      normalizedPayload = copyReplyPayloadMetadata(normalizedPayload, {
        ...normalizedPayload,
        text: undefined,
      });
      if (pendingBlock) {
        await suppressPendingFinalDelivery(payload);
      }
      if (pendingBlock || sourceRecovery) {
        setReplyPayloadMetadata(normalizedPayload, { pendingFinalDeliveryCompletion: undefined });
        sourceReplyTranscriptMirror = sourceReplyTranscriptMirror
          ? transcriptMirrorForDeliveredPayload(sourceReplyTranscriptMirror, normalizedPayload)
          : undefined;
      }
      if (!hasOutboundReplyContent(normalizedPayload, { trimText: true })) {
        return notDeliveredHere();
      }
    }
    await prepareSessionWriterDelivery(normalizedPayload);
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
    const isCommandReply = !hasTranscriptOwner && commandText?.startsWith("/");
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
              ...(isCommandReply && commandText && commandId
                ? commandTranscriptMirror(state, commandText, commandId)
                : {}),
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
        preparedSpeechText,
        ...(result.reason === "channel_transform"
          ? { suppressionReason: "channel_transform" as const }
          : {}),
      };
    }
    throwIfFinalDeliveryAborted();
    markInboundDedupeReplayUnsafe();
    const { queued: queuedFinal, outcome: dispatcherOutcome } = sendReplyWithTranscriptMirror({
      dispatcher,
      cfg,
      metadata: transcriptMirror,
      payload: normalizedPayload,
      send: (reply) => {
        if (deferFinalTtsText && reply.mediaUrl && reply.text?.trim()) {
          attachReplyDispatchUndeliveredFallback(reply, buildCaptionedFinalTextFallback(reply));
        }
        return turnLedger.sendQueued("final", reply);
      },
    });
    return {
      blockDeliveryOutcome: sourceRecovery ? blockDeliveryOutcome : undefined,
      pendingBlock,
      queuedFinal,
      routedFinalCount: 0,
      preparedSpeechText,
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
      runWithDispatchLifecycleAdmission(() =>
        runWithDispatchAbortSignal(
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
        ),
      ),
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

  const acpRefusal = state.dispatchKind === "acp" ? await acquireAcpDispatchTurn(state) : undefined;
  if (acpRefusal) {
    return acpRefusal;
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
  const dispatchRefusal =
    state.dispatchKind === "acp" ? undefined : await acquireDispatchTurn(state);
  if (dispatchRefusal) {
    return dispatchRefusal;
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
