import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { ChannelId } from "./channel-id.types.js";

/**
 * Creates a lazy loader that resolves one value from the authoritative channel registry.
 */
export function createChannelRegistryLoader<TValue>(
  resolveValue: (entry: PluginChannelRegistration) => TValue | undefined,
): (id: ChannelId) => Promise<TValue | undefined> {
  return async (id: ChannelId): Promise<TValue | undefined> => {
    const registry =
      getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
    const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
    return pluginEntry ? resolveValue(pluginEntry) : undefined;
  };
}
