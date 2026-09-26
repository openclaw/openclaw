// Public facade for outbound delivery planning, queueing, and transport.
export type { OutboundDeliveryResult } from "./deliver-types.js";
export type { NormalizedOutboundPayload } from "./payloads.js";
export type { OutboundSendDeps } from "./send-deps.js";
export type {
  DeliverOutboundPayloadsParams,
  DurableFinalDeliveryRequirement,
  DurableFinalDeliveryRequirements,
  OutboundDeliveryIntent,
  OutboundDeliveryQueuePolicy,
} from "./deliver-contracts.js";
export { resolveOutboundDurableFinalDeliverySupport } from "./deliver-channel.js";

/**
 * @deprecated Direct outbound delivery is compatibility/runtime substrate.
 * New message lifecycle code should use `sendDurableMessageBatch` or
 * `deliverInboundReplyWithMessageSendContext`.
 */
export { runOutboundDelivery as deliverOutboundPayloads } from "./deliver-queue.js";
export {
  runOutboundDeliveryInternal as deliverOutboundPayloadsInternal,
  runStructuredOutboundDeliveryInternal as deliverStructuredOutboundPayloadsInternal,
} from "./deliver-queue.js";
