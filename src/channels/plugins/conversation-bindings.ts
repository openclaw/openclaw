import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { getChannelPlugin } from "./registry.js";
import type { ChannelId } from "./types.public.js";

function warnLegacyBindingMethod(method: string): void {
  warnPluginSdkDeprecation({
    family: "channel-conversation-bindings",
    method,
    replacement: `${method}Async`,
  });
}

/**
 * @deprecated Use setChannelConversationBindingIdleTimeoutBySessionKeyAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release.
 *
 * Missing plugin support is a no-op because session commands fan out through
 * generic channel helpers while only some channels keep conversation bindings.
 */
export function setChannelConversationBindingIdleTimeoutBySessionKey(params: {
  channelId: ChannelId;
  targetSessionKey: string;
  accountId?: string | null;
  idleTimeoutMs: number;
}) {
  warnLegacyBindingMethod("setChannelConversationBindingIdleTimeoutBySessionKey");
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
 * @deprecated Use setChannelConversationBindingMaxAgeBySessionKeyAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release.
 *
 * Returns the modified binding snapshots so command handlers can report the
 * concrete sessions affected by the generic channel command.
 */
export function setChannelConversationBindingMaxAgeBySessionKey(params: {
  channelId: ChannelId;
  targetSessionKey: string;
  accountId?: string | null;
  maxAgeMs: number;
}) {
  warnLegacyBindingMethod("setChannelConversationBindingMaxAgeBySessionKey");
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
  if (adapter?.setIdleTimeoutBySessionKeyAsync) {
    return await adapter.setIdleTimeoutBySessionKeyAsync(input);
  }
  if (adapter?.setIdleTimeoutBySessionKey) {
    warnLegacyBindingMethod("ChannelConversationBindingSupport.setIdleTimeoutBySessionKey");
    return adapter.setIdleTimeoutBySessionKey(input);
  }
  return [];
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
  if (adapter?.setMaxAgeBySessionKeyAsync) {
    return await adapter.setMaxAgeBySessionKeyAsync(input);
  }
  if (adapter?.setMaxAgeBySessionKey) {
    warnLegacyBindingMethod("ChannelConversationBindingSupport.setMaxAgeBySessionKey");
    return adapter.setMaxAgeBySessionKey(input);
  }
  return [];
}
