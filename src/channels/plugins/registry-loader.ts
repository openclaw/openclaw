import type { PluginChannelRegistration, PluginRegistry } from "../../plugins/registry-types.js";
import { getActivePluginChannelRegistry, getActivePluginRegistry } from "../../plugins/runtime.js";
import type { ChannelId } from "./channel-id.types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  const cache = new Map<ChannelId, TValue>();
  let lastRegistry: PluginRegistry | null = null;

  return async (id: ChannelId): Promise<TValue | undefined> => {
    const registry = getActivePluginChannelRegistry();
    if (registry !== lastRegistry) {
      cache.clear();
      lastRegistry = registry;
    }
    const cached = cache.get(id);
    if (cached) {
      return cached;
    }
    // Prefer the pinned channel registry (stable across subagent registry swaps).
    const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
    if (pluginEntry) {
      const resolved = resolveValue(pluginEntry);
      if (resolved) {
        cache.set(id, resolved);
      }
      return resolved;
    }
    // Fall back to the mutable active registry for channels loaded after the
    // initial pin (e.g. via bootstrap or late-loaded plugins).
    const activeRegistry = getActivePluginRegistry();
    const activeEntry = activeRegistry?.channels.find((entry) => entry.plugin.id === id);
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
