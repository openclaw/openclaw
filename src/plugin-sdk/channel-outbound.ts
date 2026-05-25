// Shared outbound/message lifecycle helpers for channel plugins.
import type {
  ChannelMessageAdapter,
  ChannelMessageAdapterShape,
} from "../channels/message/index.js";
import type { ChannelMessageReceiveAdapterShape } from "../channels/message/index.js";
import type {
  DurableMessageBatchSendParams,
  DurableMessageBatchSendResult,
  DurableMessageSendContext,
  DurableMessageSendContextParams,
} from "../channels/message/runtime.js";
type ChannelInboundKernelModule = typeof import("../channels/turn/kernel.js");

export type {
  DurableInboundReplyDeliveryOptions,
  DurableInboundReplyDeliveryParams,
  DurableInboundReplyDeliveryResult,
} from "../channels/turn/kernel.js";
export type {
  DurableMessageBatchSendParams,
  DurableMessageBatchSendResult,
  DurableMessageSendContext,
  DurableMessageSendContextParams,
} from "../channels/message/runtime.js";
export {
  createChannelReplyPipeline as createChannelMessageReplyPipeline,
  createReplyPrefixContext,
  createReplyPrefixOptions,
  createTypingCallbacks,
  resolveChannelSourceReplyDeliveryMode as resolveChannelMessageSourceReplyDeliveryMode,
} from "./channel-reply-core.js";

export {
  classifyDurableSendRecoveryState,
  createChannelMessageAdapterFromOutbound,
  createDurableInboundReceiveJournal,
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  createMessageReceiveContext,
  createPreviewMessageReceipt,
  defineFinalizableLivePreviewAdapter,
  deriveDurableFinalDeliveryRequirements,
  deliverFinalizableLivePreview,
  deliverWithFinalizableLivePreviewAdapter,
  listDeclaredChannelMessageLiveCapabilities,
  listDeclaredDurableFinalCapabilities,
  listDeclaredLivePreviewFinalizerCapabilities,
  listDeclaredReceiveAckPolicies,
  createLiveMessageState,
  createDurableMessageStateRecord,
  markLiveMessageCancelled,
  markLiveMessageFinalized,
  markLiveMessagePreviewUpdated,
  resolveMessageReceiptPrimaryId,
  shouldAckMessageAfterStage,
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveCapabilityProofs,
  verifyChannelMessageLiveFinalizerProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
  verifyChannelMessageReceiveAckPolicyProofs,
  verifyDurableFinalCapabilityProofs,
  verifyLivePreviewFinalizerCapabilityProofs,
} from "../channels/message/index.js";
export type {
  ChannelMessageAdapter,
  ChannelMessageAdapterShape,
  ChannelMessageDurableFinalAdapter,
  ChannelMessageLiveFinalizerAdapterShape,
  ChannelMessageLiveAdapterShape,
  ChannelMessageLiveCapability,
  ChannelMessageOutboundBridgeAdapter,
  ChannelMessageOutboundBridgeResult,
  ChannelMessageReceiveAckPolicy,
  ChannelMessageReceiveAdapterShape,
  ChannelMessageSendAdapter,
  ChannelMessageSendAttemptContext,
  ChannelMessageSendAttemptKind,
  ChannelMessageSendCommitContext,
  ChannelMessageSendFailureContext,
  ChannelMessageSendLifecycleAdapter,
  ChannelMessageSendMediaContext,
  ChannelMessageSendPayloadContext,
  ChannelMessageSendPollContext,
  ChannelMessageSendResult,
  ChannelMessageSendSuccessContext,
  ChannelMessageSendTextContext,
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
  CreateChannelReplyPipelineParams,
  CreateChannelMessageAdapterFromOutboundParams,
  DeriveDurableFinalDeliveryRequirementsParams,
  ChannelMessageLiveCapabilityProof,
  ChannelMessageLiveCapabilityProofMap,
  ChannelMessageLiveCapabilityProofResult,
  ChannelMessageReceiveAckPolicyProof,
  ChannelMessageReceiveAckPolicyProofMap,
  ChannelMessageReceiveAckPolicyProofResult,
  DurableFinalCapabilityProof,
  DurableFinalCapabilityProofMap,
  DurableFinalCapabilityProofResult,
  DurableFinalDeliveryCapability,
  DurableFinalDeliveryPayloadShape,
  DurableFinalDeliveryRequirementMap,
  DurableFinalRequirementExtras,
  DurableInboundReceiveAcceptOptions,
  DurableInboundReceiveAcceptResult,
  DurableInboundReceiveCompletedRecord,
  DurableInboundReceiveCompleteOptions,
  DurableInboundReceiveJournal,
  DurableInboundReceiveJournalOptions,
  DurableInboundReceivePendingRecord,
  DurableInboundReceiveReleaseOptions,
  DurableMessageSendIntent,
  DurableMessageSendState,
  DurableMessageStateRecord,
  FinalizableLivePreviewAdapter,
  LiveMessagePhase,
  LiveMessageState,
  LivePreviewFinalizerCapability,
  LivePreviewFinalizerCapabilityMap,
  LivePreviewFinalizerDraft,
  LivePreviewFinalizerCapabilityProof,
  LivePreviewFinalizerCapabilityProofMap,
  LivePreviewFinalizerCapabilityProofResult,
  LivePreviewFinalizerResult,
  LivePreviewFinalizerResultKind,
  MessageAckPolicy,
  MessageAckStage,
  MessageAckState,
  MessageReceiveContext,
  MessageSendContext,
  MessageDurabilityPolicy,
  MessageReceipt,
  MessageReceiptPart,
  MessageReceiptPartKind,
  MessageReceiptSourceResult,
  RenderedMessageBatch,
  RenderedMessageBatchPlan,
  RenderedMessageBatchPlanItem,
  RenderedMessageBatchPlanKind,
} from "../channels/message/index.js";

export const deliverInboundReplyWithMessageSendContext: ChannelInboundKernelModule["deliverInboundReplyWithMessageSendContext"] =
  async (...args) => {
    const mod = await import("../channels/turn/kernel.js");
    return await mod.deliverInboundReplyWithMessageSendContext(...args);
  };

export async function sendDurableMessageBatch(
  params: DurableMessageBatchSendParams,
): Promise<DurableMessageBatchSendResult> {
  const mod = await import("../channels/message/runtime.js");
  return await mod.sendDurableMessageBatch(params);
}

export async function withDurableMessageSendContext<T>(
  params: DurableMessageSendContextParams,
  run: (ctx: DurableMessageSendContext) => Promise<T>,
): Promise<T> {
  const mod = await import("../channels/message/runtime.js");
  return await mod.withDurableMessageSendContext(params, run);
}

const defaultManualReceiveAdapter = {
  defaultAckPolicy: "manual",
  supportedAckPolicies: ["manual"],
} as const satisfies ChannelMessageReceiveAdapterShape;

type ChannelMessageAdapterWithDefaultReceive<TAdapter extends ChannelMessageAdapterShape> =
  TAdapter & {
    receive: TAdapter["receive"] extends undefined
      ? typeof defaultManualReceiveAdapter
      : NonNullable<TAdapter["receive"]>;
  };

export function defineChannelMessageAdapter<const TAdapter extends ChannelMessageAdapterShape>(
  adapter: TAdapter,
): ChannelMessageAdapter<ChannelMessageAdapterWithDefaultReceive<TAdapter>> {
  return {
    ...adapter,
    receive: adapter.receive ?? defaultManualReceiveAdapter,
  } as ChannelMessageAdapter<ChannelMessageAdapterWithDefaultReceive<TAdapter>>;
}
