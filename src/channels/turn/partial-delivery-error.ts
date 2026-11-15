// Typed provider-accepted partial delivery errors live outside turn contracts
// so outbound send entrypoints can use them without importing the turn graph.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ChannelDeliveryOutcome } from "./delivery-outcome.js";

const CHANNEL_PARTIAL_DELIVERY_ERROR_CODE = "CHANNEL_PARTIAL_DELIVERY";

type ChannelPartialDeliveryEnvelope = {
  cause?: unknown;
  code: typeof CHANNEL_PARTIAL_DELIVERY_ERROR_CODE;
  deliveryResult: ChannelDeliveryOutcome & { visibleReplySent: true };
};

export type ChannelPartialDeliveryError = Error & ChannelPartialDeliveryEnvelope;

/** Preserves provider-visible delivery facts when a later native operation fails. */
export function createChannelPartialDeliveryError(
  cause: unknown,
  deliveryResult: ChannelDeliveryOutcome & { visibleReplySent: true },
): ChannelPartialDeliveryError & { sentBeforeError: true; visibleReplySent: true } {
  return Object.assign(new Error(formatErrorMessage(cause), { cause }), {
    code: "CHANNEL_PARTIAL_DELIVERY" as const,
    deliveryResult,
    sentBeforeError: true as const,
    visibleReplySent: true as const,
  });
}

export function isChannelPartialDeliveryError(
  error: unknown,
): error is ChannelPartialDeliveryEnvelope {
  return (
    isRecord(error) &&
    error.code === CHANNEL_PARTIAL_DELIVERY_ERROR_CODE &&
    isRecord(error.deliveryResult) &&
    error.deliveryResult.visibleReplySent === true
  );
}
