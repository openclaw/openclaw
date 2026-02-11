export type CommandBridgeConfig = {
  enabled?: boolean;
  /** Channels to expose the bridge to (e.g., 'telegram', 'web'). */
  channels?: string[];
  /** Per-module or per-command settings. */
  mappings?: Record<
    string,
    {
      enabled?: boolean;
      adminOnly?: boolean;
    }
  >;
};
