/**
 * Channel message capabilities advertised through plugin discovery hooks.
 */
const CHANNEL_MESSAGE_CAPABILITIES = ["presentation", "delivery-pin", "message-edit"] as const;

/**
 * Message capability union derived from the canonical capability list.
 */
export type ChannelMessageCapability = (typeof CHANNEL_MESSAGE_CAPABILITIES)[number];
