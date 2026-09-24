import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { buildCaptionedFinalTextFallback } from "../../tts/captioned-final.js";
import type { BlockReplyContext } from "../get-reply-options.types.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
} from "../reply-payload.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { createBlockReplySource, setBlockReplyDelivery } from "./block-reply-delivery.js";
import type { BlockReplySource } from "./block-reply-source.types.js";
import {
  prepareReplyPayloadForSideEffects as preparePayload,
  shouldDeliverDespiteSourceReplySuppression,
} from "./dispatch-from-config.payloads.js";
import type { PrepareDispatchExecutionReadyState } from "./dispatch-from-config.prepare-execution.js";
import type { ReplyDispatchOperation } from "./reply-dispatcher.types.js";

export function createDispatchBlockReplyHandler(state: PrepareDispatchExecutionReadyState) {
  const {
    cleanBlockTtsDirectiveText,
    commentaryPayloadsEnabled,
    cfg,
    deliveryChannel,
    deferFinalTtsText,
    dispatcher,
    flushPendingCommentaryProgress,
    isDispatchOperationAborted,
    markInboundDedupeReplayUnsafe,
    markProgress,
    maybeApplyTtsWithFinalizationLease,
    normalizeReplyMediaPayload,
    params,
    reasoningPayloadsEnabled,
    replyRoute,
    sessionAgentId,
    sessionTtsAuto,
    shouldRouteToOriginating,
    trackDispatchLifecycleWork,
  } = state;
  let pendingBlockSource: BlockReplySource | undefined;
  let drain: ((text: string) => Promise<void>) | undefined;
  const dispatchBlockReply = (operation: ReplyDispatchOperation, context?: BlockReplyContext) => {
    const inputPayload = operation.kind === "prepared" ? operation.plan.payload : operation.payload;
    setBlockReplyDelivery(Promise.resolve({ outcome: "cancelled" }));
    // A monitor decides notify only after its structured final result.
    if (state.replyOperationRunState.heartbeat) {
      return Promise.resolve();
    }
    markProgress();
    const run = async () => {
      if (isDispatchOperationAborted()) {
        return;
      }
      // Buffered commentary preceded this block; deliver it first.
      await flushPendingCommentaryProgress();
      const independentDurableBlock = context?.deliveryIntentId !== undefined;
      if (independentDurableBlock && state.suppressAcpChildUserDelivery) {
        return;
      }
      if (
        state.suppressDelivery &&
        !shouldDeliverDespiteSourceReplySuppression(inputPayload, state)
      ) {
        return;
      }
      // Durable reasoning is a channel-owned lane; generic channels
      // keep the historical suppression unless they explicitly opt in.
      if (inputPayload.isReasoning === true && !reasoningPayloadsEnabled) {
        return;
      }
      // Durable commentary is a channel-owned lane; generic channels keep the
      // historical suppression unless they explicitly opt in.
      if (inputPayload.isCommentary === true && !commentaryPayloadsEnabled) {
        return;
      }
      const payload = preparePayload(
        dispatcher,
        "block",
        inputPayload,
        state.progressState,
        markInboundDedupeReplayUnsafe,
      );
      if (!payload) {
        return;
      }
      // Accumulate block text for TTS generation after streaming.
      // Exclude status notices — they are informational UI signals
      // and must not be synthesised into the spoken reply. Display
      // lanes stay out too: they are presentation, never final text.
      const isStatusNotice = isReplyPayloadStatusNotice(payload);
      const contributesToFinalReply =
        !isStatusNotice &&
        !independentDurableBlock &&
        payload.isReasoning !== true &&
        payload.isCommentary !== true;
      if (payload.text && contributesToFinalReply) {
        const joinsBufferedTtsDirective =
          cleanBlockTtsDirectiveText?.hasBufferedDirectiveText() === true;
        if (state.progressState.accumulatedBlockText.length > 0) {
          state.progressState.accumulatedBlockText += "\n";
        }
        state.progressState.accumulatedBlockText += payload.text;
        if (state.progressState.accumulatedBlockTtsText.length > 0 && !joinsBufferedTtsDirective) {
          state.progressState.accumulatedBlockTtsText += "\n";
        }
        state.progressState.accumulatedBlockTtsText += payload.text;
        state.progressState.blockCount++;
      }
      let source: BlockReplySource | undefined;
      const cleanedPayload =
        payload.text && cleanBlockTtsDirectiveText && contributesToFinalReply
          ? (() => {
              if (!deferFinalTtsText) {
                source = pendingBlockSource ?? createBlockReplySource();
              }
              const text = cleanBlockTtsDirectiveText.push(payload.text);
              const buffered = cleanBlockTtsDirectiveText.hasBufferedDirectiveText();
              source?.setComplete(!buffered);
              pendingBlockSource = buffered ? source : undefined;
              return copyReplyPayloadMetadata(payload, {
                ...payload,
                text: text.trim() ? text : undefined,
              });
            })()
          : payload;
      const sendPrepared = async (preparedPayload: ReplyPayload, terminal = false) => {
        let visiblePayload = preparedPayload;
        if (terminal) {
          setBlockReplyDelivery(Promise.resolve({ outcome: "cancelled" }), visiblePayload);
        }
        const deferThisBlock = deferFinalTtsText && contributesToFinalReply;
        if (deferThisBlock) {
          const hasNonTextContent = Boolean(
            visiblePayload.mediaUrl ||
            visiblePayload.mediaUrls?.length ||
            visiblePayload.presentation ||
            visiblePayload.interactive ||
            visiblePayload.channelData,
          );
          if (!hasNonTextContent) {
            return;
          }
          visiblePayload = copyReplyPayloadMetadata(visiblePayload, {
            ...visiblePayload,
            text: undefined,
          });
        }
        if (!hasOutboundReplyContent(visiblePayload, { trimText: true })) {
          return;
        }

        // Channels that keep a live draft preview may need to rotate their
        // preview state at the logical block boundary before queued block
        // delivery drains asynchronously through the dispatcher.
        const payloadMetadata = getReplyPayloadMetadata(payload);
        const queuedContext =
          payloadMetadata?.assistantMessageIndex !== undefined
            ? {
                ...context,
                assistantMessageIndex: payloadMetadata.assistantMessageIndex,
              }
            : context;
        if (isDispatchOperationAborted()) {
          return;
        }
        const ttsPayload =
          terminal || payload.isReasoning === true || payload.isCommentary === true
            ? visiblePayload
            : await maybeApplyTtsWithFinalizationLease({
                payload: visiblePayload,
                cfg,
                channel: deliveryChannel,
                kind: "block",
                ttsAuto: sessionTtsAuto,
                agentId: sessionAgentId,
                accountId: replyRoute.accountId,
              });
        const normalizedPayload = await normalizeReplyMediaPayload(ttsPayload);
        let deliveryOperation: ReplyDispatchOperation = { kind: "raw", payload: normalizedPayload };
        if (operation.kind === "prepared") {
          const plan = createStructuredOutboundPayloadPlan([normalizedPayload])[0];
          if (!plan) {
            return;
          }
          deliveryOperation = { kind: "prepared", plan };
        }
        if (isDispatchOperationAborted()) {
          return;
        }
        if (
          shouldRouteToOriginating ||
          (independentDurableBlock && state.canRouteDurableBlockReply)
        ) {
          const result = await state.sendReplyOperationAsync(
            deliveryOperation,
            context?.abortSignal,
            false,
            "block",
            context?.deliveryIntentId,
          );
          const outcome = state.recordRoutedBlockReplyDelivery(normalizedPayload, result);
          if (outcome === "delivered" && !state.suppressAutomaticSourceDelivery) {
            await params.replyOptions?.onBlockReplyQueued?.(visiblePayload, queuedContext);
          }
        } else {
          markInboundDedupeReplayUnsafe();
          const delivery = state.sendTrackedBlockReply(deliveryOperation);
          if (delivery.queued) {
            // This block's receipt owns its settlement. A turn-wide no-send
            // verdict is premature while a recovery final can still arrive.
            const pending = (delivery.outcome ?? dispatcher.waitForIdle()).then(() => undefined);
            void pending.catch(() => undefined);
            state.progressState.pendingDirectBlockReplyDelivery = pending;
          }
          if (
            delivery.queued &&
            !state.suppressAutomaticSourceDelivery &&
            params.replyOptions?.onBlockReplyQueued
          ) {
            // Settled dispatchers notify on this block's confirmed delivery.
            // Receipt-less dispatchers retain their admission-time boundary
            // notification; its callback is not delivery evidence.
            trackDispatchLifecycleWork(
              (delivery.outcome ?? Promise.resolve("delivered")).then(async (outcome) => {
                if (outcome === "delivered" && !context?.abortSignal?.aborted) {
                  await params.replyOptions?.onBlockReplyQueued?.(visiblePayload, queuedContext);
                }
              }),
              "delivery",
            );
          }
        }
      };
      if (cleanBlockTtsDirectiveText && contributesToFinalReply && payload.text) {
        drain = async (text) => {
          if (!text || deferFinalTtsText) {
            source?.setComplete(true);
            return;
          }
          if (isDispatchOperationAborted()) {
            return;
          }
          const tail = buildCaptionedFinalTextFallback(payload);
          tail.text = text;
          source?.setComplete(true);
          const send = () => sendPrepared(tail, true);
          if (source) {
            await source.run(send);
          } else {
            await send();
          }
        };
      }
      const send = () => sendPrepared(cleanedPayload);
      if (source) {
        await source.run(send);
      } else {
        await send();
      }
    };
    return run();
  };
  const onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]> = (payload, context) =>
    dispatchBlockReply({ kind: "raw", payload }, context);
  const onPreparedBlockReply: NonNullable<GetReplyOptions["onPreparedBlockReply"]> = (
    plan,
    context,
  ) => dispatchBlockReply({ kind: "prepared", plan }, context);
  return {
    onBlockReply,
    onPreparedBlockReply,
    flush: async () => {
      if (!cleanBlockTtsDirectiveText?.hasBufferedDirectiveText()) {
        return;
      }
      const text = cleanBlockTtsDirectiveText.flush();
      const finish = drain;
      drain = undefined;
      pendingBlockSource = undefined;
      await finish?.(text);
    },
  };
}
