import { getChannelPlugin } from "./registry.js";
import type { ChannelId } from "./types.public.js";

/**
 * @deprecated Use setChannelConversationBindingIdleTimeoutBySessionKeyAsync. Retained through the next Plugin SDK major.
 *
 * Missing plugin support is a no-op because session commands fan out through
 * generic channel helpers while only some channels keep conversation bindings.
 */
export function setChannelConversationBindingIdleTimeoutBySessionKey(params: {
  channelId: ChannelId;
  targetSessionKey: string;
  accountId?: string | null;
  idleTimeoutMs: number;
}): Array<{
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
}> {
  const setIdleTimeoutBySessionKey = getChannelPlugin(params.channelId)?.conversationBindings
    ?.setIdleTimeoutBySessionKey;
  if (!setIdleTimeoutBySessionKey) {
    return [];
  }
  return setIdleTimeoutBySessionKey({
    targetSessionKey: params.targetSessionKey,
    accountId: params.accountId,
    idleTimeoutMs: params.idleTimeoutMs,
  });
}

/**
 * @deprecated Use setChannelConversationBindingMaxAgeBySessionKeyAsync. Retained through the next Plugin SDK major.
 *
 * Returns the modified binding snapshots so command handlers can report the
 * concrete sessions affected by the generic channel command.
 */
export function setChannelConversationBindingMaxAgeBySessionKey(params: {
  channelId: ChannelId;
  targetSessionKey: string;
  accountId?: string | null;
  maxAgeMs: number;
}): Array<{
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
}> {
  const setMaxAgeBySessionKey = getChannelPlugin(params.channelId)?.conversationBindings
    ?.setMaxAgeBySessionKey;
  if (!setMaxAgeBySessionKey) {
    return [];
  }
  return setMaxAgeBySessionKey({
    targetSessionKey: params.targetSessionKey,
    accountId: params.accountId,
    maxAgeMs: params.maxAgeMs,
  });
}

/** Joins async lifecycle updates, with a synchronous fallback for legacy adapters. */
export async function setChannelConversationBindingIdleTimeoutBySessionKeyAsync(
  params: Parameters<typeof setChannelConversationBindingIdleTimeoutBySessionKey>[0],
): Promise<ReturnType<typeof setChannelConversationBindingIdleTimeoutBySessionKey>> {
  const adapter = getChannelPlugin(params.channelId)?.conversationBindings;
  const input = {
    targetSessionKey: params.targetSessionKey,
    accountId: params.accountId,
    idleTimeoutMs: params.idleTimeoutMs,
  };
  return adapter?.setIdleTimeoutBySessionKeyAsync
    ? await adapter.setIdleTimeoutBySessionKeyAsync(input)
    : (adapter?.setIdleTimeoutBySessionKey?.(input) ?? []);
}

/** Joins async lifecycle updates, with a synchronous fallback for legacy adapters. */
export async function setChannelConversationBindingMaxAgeBySessionKeyAsync(
  params: Parameters<typeof setChannelConversationBindingMaxAgeBySessionKey>[0],
): Promise<ReturnType<typeof setChannelConversationBindingMaxAgeBySessionKey>> {
  const adapter = getChannelPlugin(params.channelId)?.conversationBindings;
  const input = {
    targetSessionKey: params.targetSessionKey,
    accountId: params.accountId,
    maxAgeMs: params.maxAgeMs,
  };
  return adapter?.setMaxAgeBySessionKeyAsync
    ? await adapter.setMaxAgeBySessionKeyAsync(input)
    : (adapter?.setMaxAgeBySessionKey?.(input) ?? []);
}
