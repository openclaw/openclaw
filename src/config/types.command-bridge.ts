import type { ChatChannelId } from "../channels/registry.js";

/** Channels the bridge can be exposed to, including built-in chat channels and 'cli'. */
export type BridgeChannelId = ChatChannelId | "cli";

export type CommandBridgeConfig = {
  enabled?: boolean;
  /** Channels to expose the bridge to. */
  channels?: BridgeChannelId[];
  /** Per-module or per-command settings. */
  mappings?: Record<
    string,
    {
      enabled?: boolean;
      adminOnly?: boolean;
    }
  >;
};
