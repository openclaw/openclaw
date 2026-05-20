import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import { getActivePluginChannelRegistry, getActivePluginRegistry } from "../../plugins/runtime.js";
import type { ChannelId } from "./channel-id.types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  return async (id: ChannelId): Promise<TValue | undefined> => {
    const channelRegistry = getActivePluginChannelRegistry();
    const pinnedEntry = channelRegistry?.channels.find((entry) => entry.plugin.id === id);
    if (pinnedEntry) {
      return resolveValue(pinnedEntry);
    }

    // Pinned registry does not contain this channel. Check the active
    // registry for dynamically registered channels (e.g. discordVoice,
    // which is registered at runtime after a voice connection is
    // established). Do NOT use the active registry when the channel
    // already exists in the pinned registry — the active registry is
    // unstable (replaced on every loadOpenClawPlugins call) and may
    // lack the outbound adapter, causing "Outbound not configured"
    // errors. See #84568.
    const activeRegistry = getActivePluginRegistry();
    if (!activeRegistry || activeRegistry === channelRegistry) {
      return undefined;
    }
    const activeEntry = activeRegistry.channels.find((entry) => entry.plugin.id === id);
    return activeEntry ? resolveValue(activeEntry) : undefined;
  };
}
