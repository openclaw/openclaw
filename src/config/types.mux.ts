export type ChannelMuxConfig = {
  /** Enable mux transport for this channel/account. */
  enabled?: boolean;
  /** Request timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
};
