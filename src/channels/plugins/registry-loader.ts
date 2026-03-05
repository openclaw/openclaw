import type { PluginChannelRegistration, PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type { ChannelId } from "./types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  const CACHE_MISS = Symbol("channel-registry-cache-miss");
  const cache = new Map<ChannelId, TValue | typeof CACHE_MISS>();
  let lastRegistry: PluginRegistry | null = null;

  return async (id: ChannelId): Promise<TValue | undefined> => {
    const registry = getActivePluginRegistry();
    if (registry !== lastRegistry) {
      cache.clear();
      lastRegistry = registry;
    }
    if (cache.has(id)) {
      const cached = cache.get(id);
      return cached === CACHE_MISS ? undefined : cached;
    }
    const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
    if (!pluginEntry) {
      cache.set(id, CACHE_MISS);
      return undefined;
    }
    const resolved = resolveValue(pluginEntry);
    cache.set(id, resolved === undefined ? CACHE_MISS : resolved);
    return resolved;
  };
}
