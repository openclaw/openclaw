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
export { deliverOutboundPayloads, deliverOutboundPayloadsInternal } from "./deliver-queue.js";
