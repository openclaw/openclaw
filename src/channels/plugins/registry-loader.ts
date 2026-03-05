import type { PluginChannelRegistration } from "../../plugins/registry.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import type { ChannelId } from "./types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  const MISSING = Symbol("channel-registry-loader-missing");
  const cache = new Map<ChannelId, TValue | typeof MISSING>();
  let lastRegistryVersion = -1;

  return async (id: ChannelId): Promise<TValue | undefined> => {
    const registryVersion = getActivePluginRegistryVersion();
    if (registryVersion !== lastRegistryVersion) {
      cache.clear();
      lastRegistryVersion = registryVersion;
    }

    if (cache.has(id)) {
      const cached = cache.get(id);
      if (cached === MISSING) {
        return undefined;
      }
      return cached;
    }

    const registry = getActivePluginRegistry();
    const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
    if (!pluginEntry) {
      cache.set(id, MISSING);
      return undefined;
    }

    const resolved = resolveValue(pluginEntry);
    cache.set(id, resolved === undefined ? MISSING : resolved);
    return resolved;
  };
}
