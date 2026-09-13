// Public facade for outbound delivery planning, queueing, and transport.
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import {
  runOutboundDelivery,
  runOutboundDeliveryInternal,
  runStructuredOutboundDeliveryInternal,
} from "./deliver-queue.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";

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
export async function deliverOutboundPayloads(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
  return await runOutboundDelivery(params);
}

export async function deliverOutboundPayloadsInternal(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
  return await runOutboundDeliveryInternal(params);
}

export async function deliverStructuredOutboundPayloadsInternal(
  params: Parameters<typeof runStructuredOutboundDeliveryInternal>[0],
): Promise<OutboundDeliveryResult[]> {
  return await runStructuredOutboundDeliveryInternal(params);
}
