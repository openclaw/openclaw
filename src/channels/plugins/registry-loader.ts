import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import { getActivePluginChannelRegistry, getActivePluginRegistry } from "../../plugins/runtime.js";
import type { ChannelId } from "./channel-id.types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

type ChannelRegistryLookup<TValue> = { found: true; value: TValue | undefined } | { found: false };

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  return async (id: ChannelId): Promise<TValue | undefined> => {
    const resolveFromRegistry = (
      registry: ReturnType<typeof getActivePluginRegistry>,
    ): ChannelRegistryLookup<TValue> => {
      const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
      return pluginEntry ? { found: true, value: resolveValue(pluginEntry) } : { found: false };
    };

    const channelRegistry = getActivePluginChannelRegistry();
    const channelResult = resolveFromRegistry(channelRegistry);
    if (!channelResult.found) {
      return undefined;
    }
    if (channelResult.value !== undefined) {
      return channelResult.value;
    }

    const activeRegistry = getActivePluginRegistry();
    if (activeRegistry && activeRegistry !== channelRegistry) {
      const activeResult = resolveFromRegistry(activeRegistry);
      return activeResult.found ? activeResult.value : undefined;
    }

    return undefined;
  };
}
