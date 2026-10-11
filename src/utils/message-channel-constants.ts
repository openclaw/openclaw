import { isStringOption } from "./string-readers.js";

export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;

export function internalSessionConversationId(
  channelId: string,
  sessionKey: string | undefined,
): string | undefined {
  return channelId === INTERNAL_MESSAGE_CHANNEL ? sessionKey : undefined;
}

// Origin channels that are never internal/gateway webchat surfaces. Replies
// originating from these channels must route back to the originating channel
// rather than falling through to webchat dispatch.
export const EXTERNAL_CHANNEL_ORIGINS = [
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "signal",
  "matrix",
] as const;

// Shipped agent-RPC source hints accepted without delivery. New internal wakes
// carry MsgContext.InternalTurnSource; do not add wake labels as channels.
const INTERNAL_NON_DELIVERY_CHANNELS = [
  "heartbeat",
  "cron",
  "webhook",
  "voice",
  "sessions_send",
] as const;

export function isInternalNonDeliveryChannel(
  value: string,
): value is (typeof INTERNAL_NON_DELIVERY_CHANNELS)[number] {
  return isStringOption(value, INTERNAL_NON_DELIVERY_CHANNELS);
}
