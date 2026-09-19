// Typed provider-accepted partial delivery errors live outside turn contracts
// so outbound send entrypoints can use them without importing the turn graph.
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
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }
  // SAFETY: the guard above narrows error to a non-array object before reading fields.
  const candidate = error as { code?: unknown; deliveryResult?: unknown };
  return (
    candidate.code === CHANNEL_PARTIAL_DELIVERY_ERROR_CODE &&
    Boolean(
      candidate.deliveryResult &&
      typeof candidate.deliveryResult === "object" &&
      !Array.isArray(candidate.deliveryResult) &&
      // SAFETY: the checks above narrow deliveryResult to a non-array object.
      (candidate.deliveryResult as { visibleReplySent?: unknown }).visibleReplySent === true,
    )
  );
}
