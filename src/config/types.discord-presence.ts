// Defines Discord presence-event configuration.
export type DiscordPresenceEventsConfig = {
  /** Enable online-presence system events for this guild. Default: true when configured. */
  enabled?: boolean;
  /** Discord channel ID that receives the routed agent wake. */
  channelId: string;
  /** Optional immutable Discord user ID allowlist. Omit to include all human members. */
  users?: string[];
  /** Per-user greeting cooldown in seconds. Default: 28800 (8 hours). */
  cooldownSeconds?: number;
  /**
   * Suppress presence-derived online events for this many seconds after a gateway
   * (re)connect while Discord replays every member's presence. 0 disables. Default: 300.
   */
  reconnectSuppressSeconds?: number;
  /** Maximum online events emitted per burst window before the rest are suppressed. Default: 8. */
  burstLimit?: number;
  /** Sliding burst-detection window in seconds. Default: 60. */
  burstWindowSeconds?: number;
};
