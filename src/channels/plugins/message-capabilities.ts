/** Canonical message capabilities advertised by channel plugins. */
export const CHANNEL_MESSAGE_CAPABILITIES = ["presentation", "delivery-pin"] as const;

/** Union of canonical channel message capabilities. */
export type ChannelMessageCapability = (typeof CHANNEL_MESSAGE_CAPABILITIES)[number];
