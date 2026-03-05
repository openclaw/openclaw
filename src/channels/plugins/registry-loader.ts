import type { PluginChannelRegistration, PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type { ChannelId } from "./types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

const MISSING = Symbol("missing");

export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  const cache = new Map<ChannelId, TValue | typeof MISSING>();
  let lastRegistry: PluginRegistry | null = null;

  return async (id: ChannelId): Promise<TValue | undefined> => {
    const registry = getActivePluginRegistry();
    if (registry !== lastRegistry) {
      cache.clear();
      lastRegistry = registry;
    }

    if (cache.has(id)) {
      const cached = cache.get(id);
      return cached === MISSING ? undefined : cached;
    }

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
