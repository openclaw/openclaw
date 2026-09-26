import type { SessionDeliveryGeneration } from "../../config/sessions/session-delivery-generation.types.js";

export const LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME = "outbound";
export const OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME = "outbound-legacy-preparing-v1";
export const OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME = "outbound-preparing-v1";
export const OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME = "outbound-prepared-migration-v1";
export const OUTBOUND_DELIVERY_QUEUE_NAME = "outbound-prepared-v1";
const SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME = "outbound-session-generation-v1";
export const COMMAND_OWNER_OUTBOUND_DELIVERY_QUEUE_NAME = "outbound-command-owner-v1";
export const OUTBOUND_EXECUTABLE_QUEUE_NAMES = [
  COMMAND_OWNER_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME,
] as const;

export function outboundDeliveryQueueName(entry: {
  sessionGeneration?: SessionDeliveryGeneration;
  deliveryCompletion?: { kind: string; commandOwnerReference?: unknown };
}): (typeof OUTBOUND_EXECUTABLE_QUEUE_NAMES)[number] {
  if (
    entry.deliveryCompletion?.kind === "pending-final" &&
    entry.deliveryCompletion.commandOwnerReference !== undefined
  ) {
    return COMMAND_OWNER_OUTBOUND_DELIVERY_QUEUE_NAME;
  }
  return entry.sessionGeneration === undefined
    ? OUTBOUND_DELIVERY_QUEUE_NAME
    : SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME;
}
export const DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME = "outbound-media-staging";
