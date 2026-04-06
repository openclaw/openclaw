import { listBundledChannelPlugins } from "../../../src/channels/plugins/bundled.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";

type PluginContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">;
};

let pluginContractRegistryCache: PluginContractEntry[] | undefined;

export function getPluginContractRegistry(): PluginContractEntry[] {
  pluginContractRegistryCache ??= listBundledChannelPlugins().map((plugin) => ({
    id: plugin.id,
    plugin,
  }));
  return pluginContractRegistryCache;
}
