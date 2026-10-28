import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import {
  createMissingReplyNotice,
  resolveReplyCompletion,
  shouldDeliverMissingReplyNotice,
} from "../../agents/reply-completion.js";
import { recordAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { hasNonAudioMediaReference } from "../../media/audio.js";
import { cleanDeferredFinalText, mergeDeferredFinalText } from "../../tts/captioned-final.js";
import { extractTtsDirectiveFacts } from "../../tts/directive-facts.js";
import { resolveTtsSettingsSnapshot } from "../../tts/tts-settings.js";
import { registerReplyDispatcherSettledTask } from "../dispatch-dispatcher.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  isReplyPayloadTtsSupplement,
  markReplyPayloadAsTtsSupplement,
  retainSilentFinalPayloads,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";
import { isDispatchReplyOperationAbortedError } from "./dispatch-from-config.abort.js";
import type { executeDispatch } from "./dispatch-from-config.execute.js";
import {
  COLLABORATIVE_STEERING_DISABLED_TEXT,
  createFinalDispatchPayloadDedupeKey,
  QUEUE_CAP_REJECTION_TEXT,
  shouldDeliverDespiteSourceReplySuppression,
} from "./dispatch-from-config.payloads.js";
import {
  clearPendingFinalDeliveryAfterSuccess,
  suppressPendingFinalDelivery,
} from "./dispatch-from-config.pending-final.js";

type ExecuteDispatchReadyState = Extract<
  Awaited<ReturnType<typeof executeDispatch>>,
  { status: "ready" }
>["state"];

export const needsTtsFallback = (clean: boolean, visible: string, fallback?: string) =>
  clean && !visible.trim() && Boolean(fallback?.trim());

/**
 * Carries the speech decision and the delivery guard onto the synthesized supplement,
 * and nothing else.
 *
 * The line runs between a guard and a claim. `sessionWriterDeliveryAuthority` is a
 * guard: it says which writer may still speak for this session, and dropping it would
 * let audio derived from a replaced writer reach the channel — an absent authority
 * reads as "authorized" at every check. The ownership fields are claims — the
 * transcript row, the delivery completion, the pending-final receipt — and they belong
 * to the visible message alone; a second message must never claim them.
 */
function withInheritedSupplementMetadata(
  payload: ReplyPayload,
  source: ReplyPayload,
): ReplyPayload {
  const metadata = getReplyPayloadMetadata(source);
  if (!metadata) {
    return payload;
  }
  return setReplyPayloadMetadata(payload, {
    ...(metadata.tts ? { tts: metadata.tts } : {}),
    ...(metadata.ttsExplicit ? { ttsExplicit: metadata.ttsExplicit } : {}),
    ...(metadata.commandReply ? { commandReply: metadata.commandReply } : {}),
    ...(metadata.sessionWriterDeliveryAuthority
      ? {
          sessionWriterDeliveryAuthority: metadata.sessionWriterDeliveryAuthority,
        }
      : {}),
  });
}

/** Legacy `MEDIA:` lines are attachments too, and the core guard refuses to speak them. */
const LEGACY_MEDIA_DIRECTIVE_LINE = /^[ \t]*MEDIA[ \t]*:[ \t]*(.*)$/gim;

/**
 * Speech text for a final that was delivered carrying non-audio media, or "" when the
 * payload is not one. Synthesis overwrites `mediaUrl`, so such finals are delivered
 * silently and their answer is spoken by a separate supplement payload instead.
 *
 * Legacy `MEDIA:` directives are dropped from the returned text: the visible payload
 * keeps them for media resolution, while the spoken copy must not re-trigger the very
 * guard this branch compensates for.
 */
function resolveMediaFinalTtsText(
  reply: ReplyPayload,
  deferredText?: string,
  preparedText?: string,
): string {
  if (reply.isReasoning === true || reply.isCommentary === true || reply.isError === true) {
    return "";
  }
  // An answer that is itself a voice note already speaks; a supplement would double it.
  if (isReplyPayloadTtsSupplement(reply) || reply.audioAsVoice === true) {
    return "";
  }
  // Speak what delivery prepared, not the raw reply: normalization has already
  // stripped silent/heartbeat tokens and merged deferred block text by then, and a
  // recording cannot be normalized after it is made. An empty prepared text is an
  // answer in itself — the caption was cleared, so there is nothing to say — and only
  // a genuinely absent one falls back to the reply.
  const text =
    preparedText !== undefined
      ? preparedText
      : deferredText
        ? mergeDeferredFinalText(deferredText, reply.text)
        : (reply.text ?? "");
  if (!text.trim()) {
    return "";
  }
  const directiveRefs = [...text.matchAll(LEGACY_MEDIA_DIRECTIVE_LINE)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((ref) => ref.length > 0);
  const mediaRefs = [...resolveOutboundMediaUrls(reply), ...directiveRefs];
  if (mediaRefs.length === 0 || !hasNonAudioMediaReference(mediaRefs)) {
    return "";
  }
  // Stripping a directive line from the middle leaves a hole in the text; collapse
  // it so the spoken copy reads as one piece.
  const spokenText = text
    .replace(LEGACY_MEDIA_DIRECTIVE_LINE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return spokenText || "";
}

export async function finalizeDispatchAndAudit(state: ExecuteDispatchReadyState) {
  const {
    cfg,
    ctx,
    deferFinalTtsText,
    deliveryChannel,
    rawLlmResponse,
    dispatcher,
    getDispatchAbortSignal,
    getObservedReplyDelivery,
    isRoutedReplyDelivered,
    markInboundDedupeReplayUnsafe,
    pendingContinuation,
    pendingContinuationSettlement,
    replyResult,
    replyRoute,
    routeReplyToOriginating,
    sendPolicyDenied,
    sessionAgentId,
    sessionKey,
    suppressDelivery,
    throwIfDispatchOperationAborted,
    turnLedger,
    waitForPendingDirectBlockReplyDelivery,
  } = state;
  throwIfDispatchOperationAborted();
  const finalResult = replyResult;
  const explicitSilence = state.replyOperationRunState.replyCompletion?.outcome === "silent";
  const finalReplies = Array.isArray(finalResult) ? finalResult : finalResult ? [finalResult] : [];
  const replies = explicitSilence ? retainSilentFinalPayloads(finalReplies) : finalReplies;
  const scheduledPayload = state.params.replyOptions?.scheduledAutomation?.job.payload;
  // Automation result assembly already requires a successful, meaningful final.
  // This opt-in must not enable reasoning blocks before that outcome is known.
  const finalReasoningEnabled = scheduledPayload
    ? scheduledPayload.kind === "agentTurn" && scheduledPayload.includeReasoning === true
    : state.reasoningPayloadsEnabled;
  const queueAdmission = state.replyOperationRunState.admission;
  const collaborativeSteeringRefused =
    queueAdmission?.status === "skipped" &&
    queueAdmission.reason === "collaborative-steering-disabled";
  if (collaborativeSteeringRefused) {
    const refusalNotice = markReplyPayloadForSourceSuppressionDelivery({
      text: COLLABORATIVE_STEERING_DISABLED_TEXT,
      isStatusNotice: true,
    });
    setReplyPayloadMetadata(refusalNotice, { queueAdmissionNotice: true });
    replies.push(refusalNotice);
  }
  const explicitFollowupQueued =
    queueAdmission?.status === "accepted" && queueAdmission.reason === "explicit-followup";
  let queuedRequesterNotice: ReplyPayload | undefined;
  if (queueAdmission?.status === "accepted" && queueAdmission.mode === "followup") {
    queuedRequesterNotice = markReplyPayloadForSourceSuppressionDelivery({
      text: "Your message is queued for a new turn after the current turn finishes. It hasn’t changed the work already in progress.",
      isStatusNotice: true,
    });
    setReplyPayloadMetadata(queuedRequesterNotice, { queueAdmissionNotice: "queued" });
    replies.push(queuedRequesterNotice);
  }
  const pendingFinalDeliveryIdentity = replies
    .map((reply) => getReplyPayloadMetadata(reply)?.pendingFinalDeliveryCompletion)
    .find((completion) => completion !== undefined);
  const beforeAgentRunBlocked =
    state.replyOperationRunState.replyCompletion?.outcome === "blocked" ||
    replies.some((reply) => getReplyPayloadMetadata(reply)?.beforeAgentRunBlocked === true);

  let queuedFinal = false;
  let routedFinalCount = 0;
  let sessionWriterDeliveryRevoked = false;
  let channelTransformSuppressedFinal = false;
  const finalDeliveries: Array<Awaited<ReturnType<typeof state.sendFinalPayload>>> = [];
  const sentFinalPayloadDedupeKeys = new Set<string>();
  let deferredTtsTextPending = explicitSilence ? "" : state.progressState.accumulatedBlockTtsText;
  // Finals that carry non-audio media are delivered without speech: one payload owns
  // one media set, so synthesis would overwrite the picture. Their text is spoken as a
  // separate supplement once the visible message is out. The source payload travels
  // along so the supplement inherits its speech metadata and stays subject to the same
  // core guards (command replies, explicit speech requests).
  const pendingMediaFinalTts: Array<{
    text: string;
    source: ReplyPayload;
    delivery: Awaited<ReturnType<typeof state.sendFinalPayload>>;
  }> = [];
  let continuationSettlementAttempted = false;
  let continuationSettlementRegistered = false;
  const settleContinuation = async (statusDelivered: boolean) => {
    if (!pendingContinuationSettlement || continuationSettlementAttempted) {
      return;
    }
    continuationSettlementAttempted = true;
    try {
      await pendingContinuationSettlement.settle(statusDelivered);
    } catch (error) {
      if (!statusDelivered) {
        throw error;
      }
      // A delivered waiting status must not strand its child completion when
      // the batch handoff races a replaced registry row. Release the child
      // to its normal terminal-delivery owner instead.
      logVerbose(
        `dispatch-from-config: continuation batch handoff failed: ${formatErrorMessage(error)}`,
      );
      await pendingContinuationSettlement.settle(false);
    }
  };
  try {
    // Final delivery follows every source-ordered progress callback, including
    // trailing commentary on silent or streaming-delivered turns.
    if (state.preserveProgressCallbackStartOrder) {
      await state.progressState.progressCallbackStartTail;
    }
    if (!explicitSilence) {
      await state.flushPendingCommentaryProgress();
    }
    for (const [replyIndex, reply] of replies.entries()) {
      throwIfDispatchOperationAborted();
      // Progress and earlier final deliveries can wait while a later input evicts this followup.
      if (
        reply === queuedRequesterNotice &&
        state.replyOperationRunState.followupQueueDisposition === "queue-cap-old"
      ) {
        reply.text =
          "Your queued message was dropped because the session queue is full. It hasn’t changed the work already in progress. Please send it again after the current response finishes.";
        setReplyPayloadMetadata(reply, { queueAdmissionNotice: true });
      } else if (reply === queuedRequesterNotice && !explicitFollowupQueued) {
        // Automatic fallback is an implementation detail. Only explicit commands
        // acknowledge queueing; a real overflow still needs the actionable notice above.
        continue;
      }
      const laneSuppressed =
        (reply.isReasoning === true && !finalReasoningEnabled) ||
        (reply.isCommentary === true && !state.commentaryPayloadsEnabled);
      const sourceSuppressed =
        !laneSuppressed &&
        suppressDelivery &&
        !shouldDeliverDespiteSourceReplySuppression(reply, state);
      const finalPayloadDedupeKey =
        laneSuppressed || sourceSuppressed ? undefined : createFinalDispatchPayloadDedupeKey(reply);
      if (
        finalPayloadDedupeKey === undefined ||
        sentFinalPayloadDedupeKeys.has(finalPayloadDedupeKey)
      ) {
        await suppressPendingFinalDelivery(reply);
        continue;
      }
      sentFinalPayloadDedupeKeys.add(finalPayloadDedupeKey);
      if (getReplyPayloadMetadata(reply)?.pendingFinalDeliveryCompletion) {
        setReplyPayloadMetadata(reply, { pendingFinalDeliveryCleanup: {} });
      }
      const shouldAttachDeferredText = deferFinalTtsText && isReplyPayloadTerminalContent(reply);
      const finalReply = await state.sendFinalPayload(reply, {
        deliveryId: String(replyIndex),
        ...(shouldAttachDeferredText
          ? {
              deferredTtsText: deferredTtsTextPending,
            }
          : {}),
      });
      // A canonical speech final owns synthesis, including a channel veto or failed attempt.
      if (
        isReplyPayloadTerminalContent(reply) &&
        !getReplyPayloadMetadata(reply)?.precedingInputAnswer &&
        (getReplyPayloadMetadata(reply)?.tts ?? extractTtsDirectiveFacts(reply.text ?? "").facts)
      ) {
        deferredTtsTextPending = "";
      }
      state.observeDeliveryProgress(finalReply.dispatcherOutcome, "reply:final_delivered");
      if (finalReply.suppressionReason) {
        channelTransformSuppressedFinal ||= finalReply.suppressionReason === "channel_transform";
        if (!finalReply.blockDeliveryOutcome) {
          continue;
        }
      }
      finalDeliveries.push(finalReply);
      // The supplement follows a message the recipient can actually see. A final that
      // was deduped against its block only counts once that block was delivered:
      // a channel-transform veto or an unresolved delivery leaves nothing to speak to.
      // A final that was deduped against its block counts once that block was delivered;
      // otherwise the visible message itself must have been accepted for delivery —
      // queued or routed. A routing failure leaves nothing for the voice to follow.
      const visibleAnswerDelivered = finalReply.blockDeliveryOutcome
        ? finalReply.blockDeliveryOutcome === "delivered"
        : finalReply.queuedFinal || finalReply.routedFinalCount > 0;
      const mediaFinalTtsText = visibleAnswerDelivered
        ? resolveMediaFinalTtsText(
            reply,
            shouldAttachDeferredText ? deferredTtsTextPending : undefined,
            finalReply.preparedSpeechText,
          )
        : "";
      if (mediaFinalTtsText) {
        pendingMediaFinalTts.push({
          text: mediaFinalTtsText,
          source: reply,
          delivery: finalReply,
        });
      }
      if (shouldAttachDeferredText) {
        deferredTtsTextPending = "";
      }
      queuedFinal = finalReply.queuedFinal || queuedFinal;
      routedFinalCount += finalReply.routedFinalCount;
      if (finalReply.blockDeliveryOutcome) {
        const completion = getReplyPayloadMetadata(reply)?.pendingFinalDeliveryCompletion;
        if (
          completion &&
          finalReply.blockDeliveryOutcome === "failed-deliver" &&
          !finalReply.pendingBlock
        ) {
          // Ambiguous direct delivery has no recorded retry custodian; fence its distinct final.
          await settlePendingFinalDelivery({ kind: "pending-final", ...completion }, "unknown", [
            "prepared",
          ]);
        } else {
          // Explicit block custody covers this prepared duplicate; queued/unknown source survives.
          await suppressPendingFinalDelivery(reply);
        }
        continue;
      }
      if (finalReply.pendingBlock) {
        // Final-only media cannot confirm or clear the block's independent pending text.
        continue;
      }
      // Queue admission can still be cancelled or fail. Keep the owner's receipt
      // until this exact final payload settles as delivered.
      const onFinalDeliverySuccess = getReplyPayloadMetadata(reply)?.onFinalDeliverySuccess;
      if (onFinalDeliverySuccess) {
        if (finalReply.dispatcherOutcome) {
          registerReplyDispatcherSettledTask(dispatcher, async () => {
            if ((await finalReply.dispatcherOutcome) === "delivered") {
              onFinalDeliverySuccess();
            }
          });
        } else if (finalReply.routedFinalCount > 0) {
          onFinalDeliverySuccess();
        }
      }
      // Metadata survives usage, threading, and transcript decoration; object identity does not.
      if (pendingContinuationSettlement && getReplyPayloadMetadata(reply)?.continuationStatus) {
        if (finalReply.dispatcherOutcome) {
          registerReplyDispatcherSettledTask(dispatcher, async () => {
            const outcome = await finalReply.dispatcherOutcome;
            // A post-send error can leave visibility unknown. Only an acknowledged
            // status may yield the requester and hold child completion delivery.
            await settleContinuation(outcome === "delivered");
          });
          continuationSettlementRegistered = true;
        } else {
          await settleContinuation(finalReply.routedFinalCount > 0);
        }
      }
    }
    if (
      (explicitSilence ||
        (state.replyOperationRunState.replyCompletion?.outcome === "pending" &&
          replies.length === 0)) &&
      !continuationSettlementRegistered
    ) {
      throwIfDispatchOperationAborted();
      await settleContinuation(true);
    }
  } finally {
    // The batch owns release even when an earlier payload fails or the status
    // is filtered out. An admitted status transfers ownership to queue settlement.
    if (!continuationSettlementRegistered) {
      await settleContinuation(false);
    }
  }
  let channelTransformSuppressed =
    (state.progressState.channelTransformSuppressed || channelTransformSuppressedFinal) &&
    !state.progressState.acceptedReplyPayload &&
    finalDeliveries.length === 0;

  if (finalDeliveries.some((reply) => !reply.blockDeliveryOutcome)) {
    if (
      queuedFinal &&
      finalDeliveries.every((reply) => !reply.queuedFinal || reply.dispatcherOutcome !== undefined)
    ) {
      const hasCustomDelivery = finalDeliveries.some(
        (reply) => !reply.blockDeliveryOutcome && !reply.dispatcherOutcome,
      );
      const reconcilePendingFinal = Promise.all(
        finalDeliveries.flatMap((reply) =>
          reply.dispatcherOutcome ? [reply.dispatcherOutcome] : [],
        ),
      )
        .then(async (outcomes) => {
          // Core terminal settlement includes cleanup. A cancelled send may have
          // found an already-delivered intent before reaching that settlement.
          if (
            hasCustomDelivery ||
            outcomes.some(
              (outcome) => outcome === "cancelled" || outcome === "failed-before-deliver",
            )
          ) {
            await clearPendingFinalDeliveryAfterSuccess(pendingFinalDeliveryIdentity);
          }
        })
        .catch((error: unknown) => {
          logVerbose(
            `dispatch-from-config: pending final reconciliation failed: ${formatErrorMessage(error)}`,
          );
        });
      registerReplyDispatcherSettledTask(dispatcher, () => reconcilePendingFinal);
    } else {
      // Routed delivery has a transport result already. Custom dispatchers that
      // do not expose the core observer retain the legacy queue-admission behavior.
      await clearPendingFinalDeliveryAfterSuccess(pendingFinalDeliveryIdentity);
    }
    // Register any remaining cleanup before honoring a late abort. The outer
    // settle owner still runs it from finally (#89115).
    throwIfDispatchOperationAborted();
  }
  if (
    !explicitSilence &&
    !suppressDelivery &&
    !channelTransformSuppressed &&
    deferredTtsTextPending.trim()
  ) {
    const { autoMode, config: ttsConfig } = resolveTtsSettingsSnapshot({
      cfg,
      preparedTtsPreferences: state.preparedTtsPreferences,
      sessionAuto: state.sessionTtsAuto,
      agentId: sessionAgentId,
      channelId: deliveryChannel,
      accountId: replyRoute.accountId,
    });
    const taggedBlockSpeech =
      autoMode === "tagged" &&
      state.cleanBlockTtsDirectiveText &&
      extractTtsDirectiveFacts(deferredTtsTextPending).facts;
    // Cleaned block text cannot carry tagged speech, even in all mode.
    if (
      taggedBlockSpeech ||
      (ttsConfig.mode === "final" && (replies.length === 0 || deferFinalTtsText))
    ) {
      const sendTtsFinal = async (payload: ReplyPayload) => {
        const finalReply = await state.sendFinalPayload(payload, {
          abortSignal: getDispatchAbortSignal(),
          skipTts: true,
        });
        queuedFinal = finalReply.queuedFinal || queuedFinal;
        routedFinalCount += finalReply.routedFinalCount;
      };
      try {
        await waitForPendingDirectBlockReplyDelivery(getDispatchAbortSignal());
        throwIfDispatchOperationAborted();
        const ttsSyntheticReply = await state.maybeApplyTtsWithFinalizationLease(
          { text: deferredTtsTextPending },
          "final",
        );
        throwIfDispatchOperationAborted();
        let ttsOnlyPayload: ReplyPayload | undefined;
        if (ttsSyntheticReply.mediaUrl || (deferFinalTtsText && ttsSyntheticReply.text?.trim())) {
          const spokenText = ttsSyntheticReply.spokenText ?? ttsSyntheticReply.text;
          const ttsPayload = deferFinalTtsText
            ? ttsSyntheticReply
            : {
                mediaUrl: ttsSyntheticReply.mediaUrl,
                audioAsVoice: ttsSyntheticReply.audioAsVoice,
                spokenText,
                trustedLocalMedia: true,
              };
          ttsOnlyPayload =
            !deferFinalTtsText && turnLedger.resolveTerminalDelivery() === "delivered"
              ? markReplyPayloadAsTtsSupplement(ttsPayload, spokenText, {
                  visibleTextAlreadyDelivered: true,
                })
              : ttsPayload;
        } else if (
          needsTtsFallback(
            Boolean(state.cleanBlockTtsDirectiveText),
            cleanDeferredFinalText(deferredTtsTextPending),
            ttsSyntheticReply.text,
          )
        ) {
          ttsOnlyPayload = ttsSyntheticReply;
        }
        if (ttsOnlyPayload) {
          await sendTtsFinal(ttsOnlyPayload);
        }
      } catch (err) {
        if (isDispatchReplyOperationAbortedError(err)) {
          throw err;
        }
        logVerbose(
          `dispatch-from-config: accumulated block TTS failed: ${formatErrorMessage(err)}`,
        );
        const deferredVisibleText = cleanDeferredFinalText(deferredTtsTextPending);
        if (deferFinalTtsText && deferredVisibleText.trim()) {
          await sendTtsFinal({ text: deferredVisibleText });
        }
      }
    }
  }
  // The picture keeps its own message; its answer follows as a voice supplement so
  // neither the media nor the speech overwrites the other.
  if (
    pendingMediaFinalTts.length > 0 &&
    resolveTtsSettingsSnapshot({
      cfg,
      preparedTtsPreferences: state.preparedTtsPreferences,
      sessionAuto: state.sessionTtsAuto,
      agentId: sessionAgentId,
      channelId: deliveryChannel,
      accountId: replyRoute.accountId,
    }).config.mode === "final"
  ) {
    // Admission is not visibility. Speaking requires a confirmed visible answer to
    // speak to, so this gate fails closed: settlement must complete and the answer
    // must have been delivered visibly. The no-visible-reply gate below treats
    // admission as the strongest fact for the opposite reason — there, uncertainty
    // must not produce a duplicate message; here, uncertainty must not produce a
    // voice note that arrives alone.
    const supplementSettleResult = await turnLedger.settleQueued(getDispatchAbortSignal());
    // The settle wait is the only bounded one. A hung transport leaves its outcome
    // promise unresolved forever, so a failed settlement must skip the supplements
    // outright — awaiting the outcome after a timeout would hand back the very
    // deadlock the bound exists to prevent.
    const supplementsSettled = supplementSettleResult === "settled";
    if (!supplementsSettled) {
      logVerbose(
        `dispatch-from-config: media final TTS supplements skipped (settle=${supplementSettleResult})`,
      );
    }
    for (const { text: mediaFinalTtsText, source, delivery } of supplementsSettled
      ? pendingMediaFinalTts
      : []) {
      const outcome =
        (await delivery.dispatcherOutcome) ??
        delivery.blockDeliveryOutcome ??
        delivery.routedOutcome;
      if (outcome !== "delivered") {
        logVerbose(
          `dispatch-from-config: media final TTS supplement skipped (visible answer=${outcome ?? "unresolved"})`,
        );
        continue;
      }
      try {
        throwIfDispatchOperationAborted();
        const ttsSyntheticReply = await state.maybeApplyTtsWithFinalizationLease(
          withInheritedSupplementMetadata({ text: mediaFinalTtsText }, source),
          "final",
        );
        throwIfDispatchOperationAborted();
        if (!ttsSyntheticReply.mediaUrl) {
          continue;
        }
        const spokenText = ttsSyntheticReply.spokenText ?? mediaFinalTtsText;
        // The metadata lives by object identity, so it has to be attached to the
        // payload that is actually delivered — the synthesis input is a different
        // object and its authority would never reach the send path.
        const ttsOnlyPayload = withInheritedSupplementMetadata(
          markReplyPayloadAsTtsSupplement(
            {
              mediaUrl: ttsSyntheticReply.mediaUrl,
              audioAsVoice: ttsSyntheticReply.audioAsVoice,
              spokenText,
              trustedLocalMedia: true,
            },
            spokenText,
            // Live-only: this audio repeats an answer that already arrived, and its
            // writer fence is the in-memory authority inherited below. Durable
            // recovery cannot rebuild that fence — it owns no pending-final
            // completion — so a replay after a restart could send past a replaced
            // writer. Delivery honors the flag at the queue boundary; the cost is
            // losing the audio on restart, never the answer.
            { visibleTextAlreadyDelivered: true, liveOnly: true },
          ),
          source,
        );
        const finalReply = await state.sendFinalPayload(ttsOnlyPayload, {
          abortSignal: getDispatchAbortSignal(),
          skipTts: true,
        });
        queuedFinal = finalReply.queuedFinal || queuedFinal;
        routedFinalCount += finalReply.routedFinalCount;
      } catch (err) {
        if (isDispatchReplyOperationAbortedError(err)) {
          throw err;
        }
        logVerbose(
          `dispatch-from-config: media final TTS supplement failed: ${formatErrorMessage(err)}`,
        );
      }
    }
  }

  await waitForPendingDirectBlockReplyDelivery(getDispatchAbortSignal());
  const replyCompletion = () => {
    const delivery = turnLedger.resolveTerminalDelivery();
    const owned = state.replyOperationRunState.replyCompletion;
    return resolveReplyCompletion(
      owned?.expectation ?? "required",
      collaborativeSteeringRefused ||
        beforeAgentRunBlocked ||
        sendPolicyDenied ||
        owned?.outcome === "blocked"
        ? "blocked"
        : owned?.outcome === "silent"
          ? "silent"
          : owned?.outcome === "delivered" || delivery === "delivered"
            ? "delivered"
            : pendingContinuation || owned?.outcome === "pending" || getObservedReplyDelivery()
              ? "pending"
              : delivery === "missing"
                ? "empty"
                : delivery,
    );
  };
  const replyAdmission = state.replyOperationRunState.admission;
  const replyAcceptedByActiveRun = replyAdmission?.status === "accepted";
  const queueCapRejected =
    replyAdmission?.status === "skipped" && replyAdmission.reason === "queue-cap";
  const missingReplyNoticeAllowed =
    queueCapRejected ||
    shouldDeliverMissingReplyNotice({
      terminalReplyExpectation: state.replyOperationRunState.replyCompletion?.expectation,
      config: cfg,
      sessionKey,
      messageChannel: ctx.Provider ?? ctx.Surface,
      inputProvenance: ctx.InputProvenance,
      scheduledAutomation: state.params.replyOptions?.scheduledAutomation !== undefined,
      currentInboundEventKind: ctx.InboundEventKind,
      trigger: ctx.InternalTurnSource === "event" ? "event" : undefined,
    });
  const noVisibleReplyFallbackAllowed = () =>
    replyCompletion().outcome === "missing" &&
    missingReplyNoticeAllowed &&
    !suppressDelivery &&
    !sendPolicyDenied &&
    state.sourceReplyDeliveryMode !== "message_tool_only" &&
    !sessionWriterDeliveryRevoked &&
    !channelTransformSuppressed &&
    !replyAcceptedByActiveRun;
  let queuedSettleResult: Awaited<ReturnType<typeof turnLedger.settleQueued>> = "settled";
  if (noVisibleReplyFallbackAllowed()) {
    // Only a turn that still looks empty pays for settlement: pending admissions
    // must resolve (beforeDeliver cancellation, pre-transport failure) before the
    // silence verdict. Turns with settled visibility or a policy-suppressed
    // fallback skip the wait, so deliveries that legitimately outlive the turn
    // (queued same-session mirroring) cannot deadlock the gate on themselves.
    queuedSettleResult = await turnLedger.settleQueued(getDispatchAbortSignal());
  }
  if (queuedSettleResult === "settled") {
    // Adapter-owned presentation may capture a final after sending hooks. Keep that
    // intentional suppression distinct from invisible, cancelled, or failed delivery.
    channelTransformSuppressed ||=
      noVisibleReplyFallbackAllowed() &&
      finalDeliveries.length > 0 &&
      (
        await Promise.all(
          finalDeliveries.map(
            (reply) =>
              reply.dispatcherOutcome ??
              Promise.resolve(reply.blockDeliveryOutcome ?? reply.routedOutcome),
          ),
        )
      ).every((outcome) => outcome === "channel-transform");
    sessionWriterDeliveryRevoked ||= replies.some(
      (reply) => !state.isSessionWriterDeliveryAuthorized(reply),
    );
  }
  let counts = dispatcher.getQueuedCounts();
  let noVisibleReplyFallbackDelivered = false;
  // A required answer cannot override unresolved transport custody.
  // An aborted or timed-out settle leaves delivery state unknown; admission
  // then keeps its legacy trust and the turn ends without a fallback.
  if (queuedSettleResult === "settled" && noVisibleReplyFallbackAllowed()) {
    try {
      throwIfDispatchOperationAborted();
      const fallbackPayload: ReplyPayload = queueCapRejected
        ? { text: QUEUE_CAP_REJECTION_TEXT }
        : createMissingReplyNotice();
      const result = await routeReplyToOriginating(fallbackPayload, {
        abortSignal: getDispatchAbortSignal(),
        kind: "final",
        ...(!queueCapRejected ? { mirror: false } : {}),
      });
      if (result) {
        // Hook-suppressed results (ok + suppressed) stay undelivered so the
        // eligibility flag survives for channel-level fallbacks.
        if (isRoutedReplyDelivered(result)) {
          queuedFinal = true;
          noVisibleReplyFallbackDelivered = true;
          routedFinalCount += 1;
        } else if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (no-visible-reply fallback) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        throwIfDispatchOperationAborted();
        markInboundDedupeReplayUnsafe();
        const fallbackSend = turnLedger.sendQueued("final", fallbackPayload);
        if (fallbackSend.queued) {
          // Settlement decides the flag: a beforeDeliver hook can still cancel
          // the admitted fallback, and a cancelled fallback must keep the
          // eligibility flag alive for channel-level recovery. The bounded
          // abort-aware wait keeps a wedged transport from blocking
          // finalization; on abort/timeout (and for untracked dispatchers)
          // admission stays the strongest fact so channels cannot double-send.
          const fallbackSettle = await turnLedger.settleQueued(getDispatchAbortSignal());
          throwIfDispatchOperationAborted();
          if (fallbackSettle !== "settled" || turnLedger.mayHaveDelivered()) {
            queuedFinal = true;
            noVisibleReplyFallbackDelivered = true;
            // Re-snapshot so the delivered fallback is reflected in reported counts,
            // matching the TTS-only path which enqueues before the snapshot.
            counts = dispatcher.getQueuedCounts();
          }
        }
      }
    } catch (err) {
      if (isDispatchReplyOperationAbortedError(err)) {
        throw err;
      }
      logVerbose(
        `dispatch-from-config: no-visible-reply fallback failed: ${formatErrorMessage(err)}`,
      );
    }
  }
  counts.final += routedFinalCount;
  const agentRunTerminalOutcome = state.getAgentRunTerminalOutcome();
  state.commitInboundDedupeIfClaimed();
  const messageInjectionAborted = state.replyOperationRunState.messageInjectionAborted === true;
  const questionFailure =
    replyAdmission?.status === "skipped" &&
    (replyAdmission.reason === "question-response-indeterminate" ||
      replyAdmission.reason === "question-response-refused" ||
      replyAdmission.reason === "question-response-rejected")
      ? replyAdmission.reason
      : undefined;
  const preRunRejection =
    agentRunTerminalOutcome === "failed" ? undefined : state.replyOperationRunState.preRunRejection;
  const dispatchOutcome =
    agentRunTerminalOutcome === "failed" || questionFailure
      ? "error"
      : queueCapRejected ||
          collaborativeSteeringRefused ||
          messageInjectionAborted ||
          preRunRejection
        ? "skipped"
        : "completed";
  const dispatchReason =
    questionFailure ??
    (collaborativeSteeringRefused ? "collaborative-steering-disabled" : undefined) ??
    (queueCapRejected
      ? "queue-cap"
      : messageInjectionAborted
        ? "reply_operation_aborted"
        : preRunRejection
          ? preRunRejection
          : replyAdmission?.status === "accepted" && replyAdmission.mode === "steer"
            ? "active_run_injected"
            : channelTransformSuppressed
              ? "channel_transform"
              : state.bindingState.pluginFallbackReason);
  const dispatchDetails = {
    ...(dispatchReason ? { reason: dispatchReason } : {}),
    ...(state.replyResolverError ? { error: state.replyResolverError } : {}),
  };
  state.recordAgentDispatchCompleted(dispatchOutcome, dispatchDetails);
  // output.value is model-authored text only; delivered text is never a substitute.
  state.recordProcessed(dispatchOutcome, {
    ...dispatchDetails,
    ...(rawLlmResponse !== undefined ? { finalResponse: rawLlmResponse } : {}),
  });
  state.markIdle(
    dispatchOutcome === "error"
      ? "message_error"
      : queueCapRejected
        ? "message_queue_cap_rejected"
        : "message_completed",
  );
  const completion = replyCompletion();
  state.replyOperationRunState.replyCompletion = completion;
  state.completeDispatchReplyOperation();
  const result = state.attachSourceReplyDeliveryMode({
    queuedFinal,
    counts,
    ...(collaborativeSteeringRefused ? { collaborativeSteeringRefused: true as const } : {}),
    ...(state.routeState.sessionMetadataChangesForResult
      ? {
          sessionMetadataChanges: state.routeState.sessionMetadataChangesForResult,
        }
      : {}),
    ...(getObservedReplyDelivery() ? { observedReplyDelivery: true } : {}),
    ...(replyAdmission?.status === "accepted" ? { deferredToActiveRun: replyAdmission.mode } : {}),
    // Eligibility keys off settled visible delivery: a suppressed or cancelled
    // final (including the core fallback itself) leaves channel-level recovery
    // eligible, while any settled visible delivery clears it. An aborted or
    // timed-out settle leaves delivery unresolved, and a fallback reported as
    // delivered must not stay recoverable — either could double-send.
    ...(completion.outcome === "missing" &&
    missingReplyNoticeAllowed &&
    queuedSettleResult === "settled" &&
    !noVisibleReplyFallbackDelivered &&
    !replyAcceptedByActiveRun &&
    !channelTransformSuppressed &&
    !sessionWriterDeliveryRevoked
      ? { noVisibleReplyFallbackEligible: true }
      : {}),
    ...(noVisibleReplyFallbackDelivered ? { noVisibleReplyFallbackDelivered: true } : {}),
    ...(completion.outcome === "silent" || completion.outcome === "blocked"
      ? { deliberateSilentTerminalReply: true as const }
      : {}),
    ...(beforeAgentRunBlocked ? { beforeAgentRunBlocked } : {}),
  });
  if (agentRunTerminalOutcome) {
    recordAgentRunTerminalOutcome(result, agentRunTerminalOutcome);
  }
  return result;
}
