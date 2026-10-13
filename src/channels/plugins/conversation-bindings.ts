import { getChannelPlugin } from "./registry.js";
import type { ChannelId } from "./types.public.js";

/** Missing plugin support is a no-op for generic session command fan-out. */
export async function setChannelConversationBindingIdleTimeoutBySessionKeyAsync(params: {
  channelId: ChannelId;
  targetSessionKey: string;
  accountId?: string | null;
  idleTimeoutMs: number;
}) {
  const adapter = getChannelPlugin(params.channelId)?.conversationBindings;
  return (
    (await adapter?.setIdleTimeoutBySessionKeyAsync?.({
      targetSessionKey: params.targetSessionKey,
      accountId: params.accountId,
      idleTimeoutMs: params.idleTimeoutMs,
    })) ?? []
  );
}

/** Returns committed binding snapshots for the session command response. */
export async function setChannelConversationBindingMaxAgeBySessionKeyAsync(params: {
  channelId: ChannelId;
  targetSessionKey: string;
  accountId?: string | null;
  maxAgeMs: number;
}) {
  const adapter = getChannelPlugin(params.channelId)?.conversationBindings;
  return (
    (await adapter?.setMaxAgeBySessionKeyAsync?.({
      targetSessionKey: params.targetSessionKey,
      accountId: params.accountId,
      maxAgeMs: params.maxAgeMs,
    })) ?? []
  );
}
