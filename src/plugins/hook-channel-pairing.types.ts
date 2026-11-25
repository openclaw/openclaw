import type { AsyncPluginHook } from "./hook-handler.types.js";

type PluginHookChannelPairingRequestedEvent = {
  /** Channel that created the pending pairing request. */
  channel: string;
  /** Provider account ID for multi-account channel setups. */
  accountId?: string;
  /** Channel-scoped sender ID awaiting operator approval. */
  senderId: string;
  /** Short-lived code accepted by `openclaw pairing approve`. */
  code: string;
  /** Sender-supplied channel metadata for operator notification/audit. Treat as untrusted. */
  metadata?: Record<string, string | undefined>;
};

type PluginHookChannelPairingContext = {
  channelId: string;
  accountId?: string;
  senderId: string;
};

export type PluginHookChannelPairingRequestedHandler = AsyncPluginHook<
  PluginHookChannelPairingRequestedEvent,
  PluginHookChannelPairingContext
>;
