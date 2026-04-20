import {
  getBundledChannelPlugin,
  listBundledChannelPluginIds,
  listBundledChannelPlugins,
} from "../../../src/channels/plugins/bundled.js";
import type { ChannelId } from "../../../src/channels/plugins/channel-id.types.js";
import { normalizeChannelMeta } from "../../../src/channels/plugins/meta-normalization.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";

type PluginContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">;
};

function toPluginContractEntry(plugin: ChannelPlugin): PluginContractEntry {
  return {
    id: plugin.id,
    plugin: {
      ...plugin,
      meta: normalizeChannelMeta({ id: plugin.id, meta: plugin.meta }),
    },
  };
}

function getBundledChannelPluginIdsForShard(params: {
  shardIndex: number;
  shardCount: number;
}): readonly ChannelId[] {
  return listBundledChannelPluginIds().filter(
    (_id, index) => index % params.shardCount === params.shardIndex,
  );
}

export function getPluginContractRegistry(): PluginContractEntry[] {
  return listBundledChannelPlugins().map(toPluginContractEntry);
}

export function getPluginContractRegistryShard(params: {
  shardIndex: number;
  shardCount: number;
}): PluginContractEntry[] {
  return getBundledChannelPluginIdsForShard(params).flatMap((id) => {
    const plugin = getBundledChannelPlugin(id);
    return plugin ? [toPluginContractEntry(plugin)] : [];
  });
}
