import type { PluginChannelRegistration } from "../../plugins/registry.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import type { ChannelId } from "./types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  const CACHE_MISS = Symbol("channel-registry-cache-miss");
  const CACHE_MAX_ENTRIES = 256;
  const cache = new Map<ChannelId, TValue | typeof CACHE_MISS>();
  let lastRegistryVersion = -1;

  const cacheSet = (id: ChannelId, value: TValue | typeof CACHE_MISS) => {
    if (!cache.has(id) && cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(id, value);
  };

  return async (id: ChannelId): Promise<TValue | undefined> => {
    const registryVersion = getActivePluginRegistryVersion();
    if (registryVersion !== lastRegistryVersion) {
      cache.clear();
      lastRegistryVersion = registryVersion;
    }

    if (cache.has(id)) {
      const cached = cache.get(id);
      return cached === CACHE_MISS ? undefined : cached;
    }

    const registry = getActivePluginRegistry();
    const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
    if (!pluginEntry) {
      cacheSet(id, CACHE_MISS);
      return undefined;
    }

    const resolved = resolveValue(pluginEntry);
    cacheSet(id, resolved === undefined ? CACHE_MISS : resolved);
    return resolved;
  };
}
