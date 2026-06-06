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

function normalizeSlackDirectUserTarget(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutPrefix = trimmed.toLowerCase().startsWith("user:")
    ? trimmed.slice("user:".length).trim()
    : trimmed;
  return /^U[A-Z0-9]+$/i.test(withoutPrefix) ? withoutPrefix.toUpperCase() : undefined;
}

function normalizeSlackDmChannelTarget(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutPrefix = trimmed.toLowerCase().startsWith("channel:")
    ? trimmed.slice("channel:".length).trim()
    : trimmed;
  return /^D[A-Z0-9]+$/i.test(withoutPrefix) ? withoutPrefix.toUpperCase() : undefined;
}

/**
 * Slack text-only DM sends can persist as user-scoped targets (`user:U...`),
 * while the already-received event also proves the concrete DM channel (`D...`).
 * Prefer the concrete channel for pending-final recovery so replay uses the
 * same address family as normal Slack DM replies.
 */
export function resolveSlackDirectPendingFinalDeliveryContext(params: {
  context?: DeliveryContext;
  nativeChannelId?: string;
  chatType?: string;
  directUserTarget?: string;
}): DeliveryContext | undefined {
  const context = normalizeDeliveryContext(params.context);
  if (!context || context.channel !== "slack") {
    return context;
  }
  if (params.chatType?.trim().toLowerCase() !== "direct") {
    return context;
  }
  const nativeDmChannelId = normalizeSlackDmChannelTarget(params.nativeChannelId);
  if (!nativeDmChannelId) {
    return context;
  }
  const contextUser = normalizeSlackDirectUserTarget(context.to);
  if (!contextUser) {
    return context;
  }
  const expectedUser = normalizeSlackDirectUserTarget(params.directUserTarget);
  if (expectedUser && expectedUser !== contextUser) {
    return context;
  }
  return normalizeDeliveryContext({
    ...context,
    to: `channel:${nativeDmChannelId}`,
  });
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
