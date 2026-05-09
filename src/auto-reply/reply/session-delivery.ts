import { normalizeChatType } from "../../channels/chat-type.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

function isExternalRoutingChannel(channel?: string): channel is string {
  return Boolean(
    channel && channel !== INTERNAL_MESSAGE_CHANNEL && isDeliverableMessageChannel(channel),
  );
}

function isTypedDirectSession(params: { chatType?: string; sessionScope?: string }): boolean {
  return (
    normalizeChatType(params.chatType) === "direct" ||
    normalizeOptionalString(params.sessionScope) === "shared-main"
  );
}

export function resolveLastChannelRaw(params: {
  originatingChannelRaw?: string;
  persistedLastChannel?: string;
  chatType?: string;
  sessionScope?: string;
  isInterSession?: boolean;
}): string | undefined {
  const originatingChannel = normalizeMessageChannel(params.originatingChannelRaw);
  // WebChat should own reply routing for direct-session UI turns, but only when
  // the session has no established external delivery route. If the session was
  // created via an external channel (e.g. Telegram, iMessage), webchat/dashboard
  // access must not overwrite the persisted route — doing so causes subagent
  // completion events to be delivered to the dashboard instead of the original
  // channel. See: https://github.com/openclaw/openclaw/issues/47745
  const persistedChannel = normalizeMessageChannel(params.persistedLastChannel);
  const hasEstablishedExternalRoute = isExternalRoutingChannel(persistedChannel);
  // Inter-session messages (sessions_send) always arrive with channel=webchat,
  // but must never overwrite an already-established external delivery route.
  // Without this guard, a sessions_send call resets lastChannel to webchat,
  // causing subsequent Discord (or other external) deliveries to be lost.
  // See: https://github.com/openclaw/openclaw/issues/54441
  if (params.isInterSession && hasEstablishedExternalRoute) {
    return persistedChannel;
  }
  if (
    originatingChannel === INTERNAL_MESSAGE_CHANNEL &&
    !hasEstablishedExternalRoute &&
    isTypedDirectSession(params)
  ) {
    return params.originatingChannelRaw;
  }
  let resolved = params.originatingChannelRaw || params.persistedLastChannel;
  // Internal/non-deliverable sources should not overwrite previously known
  // external delivery routes.
  if (!isExternalRoutingChannel(originatingChannel)) {
    if (isExternalRoutingChannel(persistedChannel)) {
      resolved = persistedChannel;
    }
  }
  return resolved;
}

export function resolveLastToRaw(params: {
  originatingChannelRaw?: string;
  originatingToRaw?: string;
  toRaw?: string;
  persistedLastTo?: string;
  persistedLastChannel?: string;
  chatType?: string;
  sessionScope?: string;
  isInterSession?: boolean;
}): string | undefined {
  const originatingChannel = normalizeMessageChannel(params.originatingChannelRaw);
  const persistedChannel = normalizeMessageChannel(params.persistedLastChannel);
  const hasEstablishedExternalRouteForTo = isExternalRoutingChannel(persistedChannel);
  // Inter-session messages must not replace a persisted external `to` with
  // webchat-scoped identifiers (e.g. session keys). Preserve the established
  // external destination so deliveries continue routing to the correct channel.
  // See: https://github.com/openclaw/openclaw/issues/54441
  if (params.isInterSession && hasEstablishedExternalRouteForTo && params.persistedLastTo) {
    return params.persistedLastTo;
  }
  if (
    originatingChannel === INTERNAL_MESSAGE_CHANNEL &&
    !hasEstablishedExternalRouteForTo &&
    isTypedDirectSession(params)
  ) {
    return params.originatingToRaw || params.toRaw;
  }
  // When the turn originates from an internal/non-deliverable source, do not
  // replace an established external destination with internal routing ids
  // (e.g., session/webchat ids).
  if (!isExternalRoutingChannel(originatingChannel)) {
    if (isExternalRoutingChannel(persistedChannel) && params.persistedLastTo) {
      return params.persistedLastTo;
    }
  }

  return params.originatingToRaw || params.toRaw || params.persistedLastTo;
}
