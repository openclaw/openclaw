// Channel outbound contracts define plugin send results, media handling, and delivery metadata.
import type {
  DurableMessageBatchSendResult,
  DurableMessageSendContext,
  DurableMessageSendContextParams,
} from "../channels/message/runtime.js";
import {
  registerChannelEchoAdmission,
  unregisterChannelEchoAdmission,
  type ChannelEchoAdmission,
} from "../infra/outbound/channel-admission.js";
import {
  registerChannelMirrorDispatcher,
  unregisterChannelMirrorDispatcher,
  type MirrorDispatcher,
} from "../infra/outbound/mirror-dispatch.js";
type ChannelInboundKernelModule = typeof import("../channels/turn/kernel.js");
type ChannelMessageRuntimeModule = typeof import("../channels/message/runtime.js");

let channelMessageRuntimeModulePromise: Promise<ChannelMessageRuntimeModule> | null = null;

const loadChannelMessageRuntimeModule = async () => {
  // Share one lazy import across SDK helper calls so plugin barrels do not eagerly pull
  // message runtime internals into registration/discovery-only paths.
  channelMessageRuntimeModulePromise ??= import("../channels/message/runtime.js");
  return await channelMessageRuntimeModulePromise;
};

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
  createReplyPrefixContext,
  createReplyPrefixOptions,
  createTypingCallbacks,
  createChannelReplyPipeline as createChannelMessageReplyPipeline,
  resolveChannelSourceReplyDeliveryMode as resolveChannelMessageSourceReplyDeliveryMode,
} from "../channels/message/index.js";

export {
  createFinalizableDraftLifecycle,
  createFinalizableDraftStreamControls,
  createFinalizableDraftStreamControlsForState,
  clearFinalizableDraftMessage,
  takeMessageIdAfterStop,
} from "../channels/draft-stream-controls.js";
export type { FinalizableDraftStreamState } from "../channels/draft-stream-controls.js";
export { createDraftStreamLoop } from "../channels/draft-stream-loop.js";
export type { DraftStreamLoop } from "../channels/draft-stream-loop.js";
export { resolveChannelDraftStreamingChunking } from "../channels/draft-streaming-chunking.js";
export type { ChannelDraftStreamingChunking } from "../channels/draft-streaming-chunking.js";
export { createRuntimeOutboundDelegates } from "../channels/plugins/runtime-forwarders.js";
// Pin-from-here mirror-dispatcher + echo-admission registries. A channel registers
// per account (last-wins for the SAME owner, unregister on stop, fail closed) so a
// mirrored turn renders through the target's own dispatch and a revoked destination
// stops receiving the mirror AND the echo fallback. Registration is OWNER-SCOPED:
// obtain a registrar bound to your plugin identity via createChannelOutboundRegistrar
// — entries you create cannot be replaced or removed by another owner. The raw
// register/unregister functions are intentionally NOT part of the public SDK surface.
// Contract: docs/plugins/sdk-overview.md#channel-mirror-dispatcher.
export type { MirrorDispatcher, ChannelEchoAdmission };

export type ChannelOutboundRegistrar = {
  registerMirrorDispatcher: (
    channel: string,
    accountId: string,
    dispatcher: MirrorDispatcher,
  ) => void;
  unregisterMirrorDispatcher: (channel: string, accountId: string) => void;
  registerEchoAdmission: (
    channel: string,
    accountId: string,
    admission: ChannelEchoAdmission,
  ) => void;
  unregisterEchoAdmission: (channel: string, accountId: string) => void;
};

/**
 * Create an owner-scoped registrar for the pin-from-here mirror-dispatcher and
 * echo-admission registries. `owner` is the registering plugin's STABLE identity
 * (e.g. its plugin id); the registrar binds it so a plugin can only register,
 * replace, or unregister entries it owns and can never touch another channel or
 * account's mirror/admission handler. This is the only public entrypoint to the
 * registries — it replaces the previously-global caller-keyed register/unregister
 * functions so an installed plugin cannot hijack another account's delivery.
 */
export function createChannelOutboundRegistrar(owner: string): ChannelOutboundRegistrar {
  return {
    registerMirrorDispatcher: (channel, accountId, dispatcher) =>
      registerChannelMirrorDispatcher(owner, channel, accountId, dispatcher),
    unregisterMirrorDispatcher: (channel, accountId) =>
      unregisterChannelMirrorDispatcher(owner, channel, accountId),
    registerEchoAdmission: (channel, accountId, admission) =>
      registerChannelEchoAdmission(owner, channel, accountId, admission),
    unregisterEchoAdmission: (channel, accountId) =>
      unregisterChannelEchoAdmission(owner, channel, accountId),
  };
}
export { createChannelRunQueue } from "./channel-lifecycle.core.js";
export type {
  ChannelRunQueue,
  ChannelRunQueueParams,
  ChannelRunQueueTaskContext,
} from "./channel-lifecycle.core.js";
export {
  createAccountStatusSink,
  keepHttpServerTaskAlive,
  runPassiveAccountLifecycle,
  waitUntilAbort,
} from "./channel-lifecycle.core.js";
export {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
} from "../infra/outbound/payloads.js";
export {
  buildOutboundSessionContext,
  type OutboundSessionContext,
} from "../infra/outbound/session-context.js";
export type { OutboundDeliveryFormattingOptions } from "../infra/outbound/formatting.js";
export { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
export type { OutboundIdentity } from "../infra/outbound/identity.js";
export { createReplyToFanout } from "../infra/outbound/reply-policy.js";
export type { ReplyToResolution } from "../infra/outbound/reply-policy.js";
export { resolveOutboundSendDep } from "../infra/outbound/send-deps.js";
export type { OutboundSendDeps } from "../infra/outbound/send-deps.js";
export { sanitizeForPlainText } from "../infra/outbound/sanitize-text.js";
export { logAckFailure, logTypingFailure } from "../channels/logging.js";
export * from "../channels/streaming.js";
export {
  createChannelProgressDraftCompositor,
  type ChannelProgressDraftCompositor,
  type ChannelProgressDraftCompositorLine,
  type ChannelProgressDraftMode,
  type ChannelProgressDraftUpdateOptions,
} from "../channels/progress-draft-compositor.js";
export {
  classifyDurableSendRecoveryState,
  createChannelMessageAdapterFromOutbound,
  createDurableInboundReceiveJournal,
  createDurableInboundReceiveJournalFromQueue,
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
  defineChannelMessageAdapter,
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
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueCompletedRecord,
  ChannelIngressQueueEnqueueResult,
  ChannelIngressQueueFailedRecord,
  ChannelIngressQueuePruneOptions,
  ChannelIngressQueueRecord,
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
  DurableInboundReceiveQueueJournalOptions,
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

/** Lazily forwards inbound reply delivery through the channel turn kernel. */
export const deliverInboundReplyWithMessageSendContext: ChannelInboundKernelModule["deliverInboundReplyWithMessageSendContext"] =
  async (...args) => {
    const mod = await import("../channels/turn/kernel.js");
    return await mod.deliverInboundReplyWithMessageSendContext(...args);
  };

/** Sends a durable message batch without eager-loading channel message runtime internals. */
export async function sendDurableMessageBatch(
  /**
   * Durable send context and outbound batch data forwarded to the channel runtime.
   */
  params: DurableMessageSendContextParams,
): Promise<DurableMessageBatchSendResult> {
  const mod = await loadChannelMessageRuntimeModule();
  return await mod.sendDurableMessageBatch(params);
}

/** Runs work inside a durable message send context loaded through the SDK lazy boundary. */
export async function withDurableMessageSendContext<T>(
  /**
   * Durable send context used to bind sends, receipts, and lifecycle callbacks.
   */
  params: DurableMessageSendContextParams,
  /**
   * Callback executed with the loaded durable-send runtime context.
   */
  run: (ctx: DurableMessageSendContext) => Promise<T>,
): Promise<T> {
  const mod = await loadChannelMessageRuntimeModule();
  return await mod.withDurableMessageSendContext(params, run);
}
