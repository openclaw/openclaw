import type { PluginChannelRegistration, PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginChannelRegistry, getActivePluginRegistry } from "../../plugins/runtime.js";
import type { ChannelId } from "./types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  const cache = new Map<ChannelId, TValue>();
  let lastRegistry: PluginRegistry | null = null;

  return async (id: ChannelId): Promise<TValue | undefined> => {
    const channelRegistry = getActivePluginChannelRegistry();
    if (channelRegistry !== lastRegistry) {
      cache.clear();
      lastRegistry = channelRegistry;
    }
    const cached = cache.get(id);
    if (cached) {
      return cached;
    }

    // Look in the pinned channel registry first (stable across subagent swaps).
    const pluginEntry = channelRegistry?.channels.find((entry) => entry.plugin.id === id);
    if (pluginEntry) {
      const resolved = resolveValue(pluginEntry);
      if (resolved) {
        cache.set(id, resolved);
      }
      return resolved;
    }

    // Fall back to the mutable active registry for channels bootstrapped after
    // the initial pin (e.g. via maybeBootstrapChannelPlugin).
    const activeRegistry = getActivePluginRegistry();
    if (!activeRegistry || activeRegistry === channelRegistry) {
      return undefined;
    }
    const activeEntry = activeRegistry.channels.find((entry) => entry.plugin.id === id);
    if (!activeEntry) {
      return undefined;
    }
    const resolved = resolveValue(activeEntry);
    if (resolved) {
      cache.set(id, resolved);
    }
    return resolved;
  };
}
