import type { PluginChannelRegistration } from "../../plugins/registry.js";
import {
  getActivePluginChannelRegistry,
  getActivePluginChannelRegistryVersion,
} from "../../plugins/runtime.js";
import type { ChannelId } from "./types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  const cache = new Map<ChannelId, TValue>();
  let lastRegistryVersion = -1;

  return async (id: ChannelId): Promise<TValue | undefined> => {
    const registry = getActivePluginChannelRegistry();
    const registryVersion = getActivePluginChannelRegistryVersion();
    if (registryVersion !== lastRegistryVersion) {
      cache.clear();
      lastRegistryVersion = registryVersion;
    }
    const cached = cache.get(id);
    if (cached) {
      return cached;
    }
    const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
    if (!pluginEntry) {
      return undefined;
    }
    const resolved = resolveValue(pluginEntry);
    if (resolved) {
      cache.set(id, resolved);
    }
    return resolved;
  };
}
