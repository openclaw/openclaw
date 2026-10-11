import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../reply-payload.js";
import {
  hasExecApprovalPayload,
  requiresDurableToolResultDelivery,
} from "./dispatch-from-config.payloads.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";

/** Owns progress visibility, commentary ordering, and the cutoff after final delivery starts. */
export function createDispatchProgress(
  state: Pick<
    PrepareDispatchOperationReadyState,
    | "params"
    | "ctx"
    | "sendPolicyDenied"
    | "suppressDelivery"
    | "suppressAutomaticSourceDelivery"
    | "sourceReplyDeliveryMode"
    | "shouldEmitVerboseProgress"
    | "shouldEmitVerboseProgressAsync"
    | "shouldEmitFullVerboseProgressAsync"
    | "isDispatchOperationAborted"
    | "assertProgressCurrent"
    | "shouldRouteToOriginating"
    | "sendPayloadAsync"
    | "markInboundDedupeReplayUnsafe"
    | "turnLedger"
  >,
) {
  const {
    params,
    ctx,
    shouldEmitVerboseProgressAsync,
    shouldRouteToOriginating,
    sendPayloadAsync,
    markInboundDedupeReplayUnsafe,
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
  const shouldSuppressLateTextOnlyToolProgress = (payload: ReplyPayload) =>
    finalReplyDeliveryStarted && !requiresDurableToolResultDelivery(payload);
  // Buffer the latest snapshot per item and flush it before the next item or final reply.
  let pendingCommentaryProgress: { itemId?: string; text: string } | null = null;
  const flushedCommentaryItems = new Set<string>();
  const deliverCommentaryProgressMessage = async (text: string) => {
    if (!(await shouldSendToolSummariesAsync()) || (await shouldSuppressProgressDelivery())) {
      return;
    }
    if (state.isDispatchOperationAborted()) {
      return;
    }
    const payload: ReplyPayload = { text: `💬 ${text}` };
    if (shouldSuppressLateTextOnlyToolProgress(payload)) {
      return;
    }
    state.assertProgressCurrent();
    if (shouldRouteToOriginating) {
      await sendPayloadAsync(payload);
    } else {
      markInboundDedupeReplayUnsafe();
      turnLedger.sendQueued("tool", payload);
    }
  };
  const flushPendingCommentaryProgress = async () => {
    const pending = pendingCommentaryProgress;
    pendingCommentaryProgress = null;
    const text = pending?.text.trim();
    if (!text) {
      return;
    }
    if (pending?.itemId) {
      flushedCommentaryItems.add(pending.itemId);
    }
    await deliverCommentaryProgressMessage(text);
  };
  const noteCommentaryProgress = async (payload: { itemId?: string; progressText?: string }) => {
    const itemId = payload.itemId?.trim() || undefined;
    if (finalReplyDeliveryStarted || (itemId && flushedCommentaryItems.has(itemId))) {
      return;
    }
    const text = payload.progressText ?? "";
    const updatesBufferedItem =
      pendingCommentaryProgress !== null &&
      ((pendingCommentaryProgress.itemId !== undefined &&
        pendingCommentaryProgress.itemId === itemId) ||
        pendingCommentaryProgress.text.trim() === text.trim());
    if (!text.trim()) {
      // Empty commentary with an item id retracts that item before it is sent.
      if (updatesBufferedItem) {
        pendingCommentaryProgress = null;
      }
      return;
    }
    if (pendingCommentaryProgress && !updatesBufferedItem) {
      await flushPendingCommentaryProgress();
    }
    pendingCommentaryProgress = { itemId, text };
  };
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
  return {
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
    markFinalReplyDeliveryStarted: () => {
      finalReplyDeliveryStarted = true;
    },
  };
}
