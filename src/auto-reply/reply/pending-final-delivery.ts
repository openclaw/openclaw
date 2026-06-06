/** Sanitizes pending final delivery text before channel-visible output. */
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import {
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../tokens.js";
import { stripInternalMetadataForDisplay } from "./display-text-sanitize.js";

/** Sanitizes final pending-delivery text and removes silent control tokens. */
export function sanitizePendingFinalDeliveryText(text: string): string {
  let stripped = stripInternalMetadataForDisplay(text).trim();
  if (isSilentReplyPayloadText(stripped, SILENT_REPLY_TOKEN)) {
    return "";
  }
  if (stripped && !isSilentReplyText(stripped, SILENT_REPLY_TOKEN)) {
    const hasLeadingSilentToken = startsWithSilentToken(stripped, SILENT_REPLY_TOKEN);
    if (hasLeadingSilentToken) {
      stripped = stripLeadingSilentToken(stripped, SILENT_REPLY_TOKEN);
    }
    // Remove stray silent tokens only after confirming the payload is not entirely silent.
    if (
      hasLeadingSilentToken ||
      stripped.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase())
    ) {
      stripped = stripSilentToken(stripped, SILENT_REPLY_TOKEN);
    }
  }
  if (!stripped.trim()) {
    return "";
  }
  return isSilentReplyPayloadText(stripped, SILENT_REPLY_TOKEN) ? "" : stripped.trim();
}

function routeFieldMatches(
  left: string | number | undefined,
  right: string | number | undefined,
): boolean {
  if (left === undefined && right === undefined) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  return String(left) === String(right);
}

/**
 * Pending final replay is only safe when the saved target and the current
 * source-reply target prove the same channel destination.
 */
export function isSameRoutePendingFinalDeliveryReplaySafe(params: {
  pendingContext?: DeliveryContext;
  currentContext?: DeliveryContext;
}): boolean {
  const pendingContext = normalizeDeliveryContext(params.pendingContext);
  const currentContext = normalizeDeliveryContext(params.currentContext);
  if (
    !pendingContext?.channel ||
    !pendingContext.to ||
    !currentContext?.channel ||
    !currentContext.to
  ) {
    return false;
  }
  return (
    pendingContext.channel === currentContext.channel &&
    pendingContext.to === currentContext.to &&
    routeFieldMatches(pendingContext.accountId, currentContext.accountId) &&
    routeFieldMatches(pendingContext.threadId, currentContext.threadId)
  );
}

export function pendingFinalDeliveryClearedPatch(updatedAt = Date.now()) {
  return {
    pendingFinalDelivery: undefined,
    pendingFinalDeliveryText: undefined,
    pendingFinalDeliveryCreatedAt: undefined,
    pendingFinalDeliveryLastAttemptAt: undefined,
    pendingFinalDeliveryAttemptCount: undefined,
    pendingFinalDeliveryLastError: undefined,
    pendingFinalDeliveryContext: undefined,
    pendingFinalDeliveryIntentId: undefined,
    updatedAt,
  };
}
