import { bundledChannelPlugins } from "../channels/plugins/bundled.js";
import type {
  ChannelConfigRuntimeSchema,
  ChannelConfigSchema,
} from "../channels/plugins/types.plugin.js";
import { BUNDLED_PLUGIN_METADATA } from "../plugins/bundled-plugin-metadata.js";

type BundledChannelRuntimeMap = ReadonlyMap<string, ChannelConfigRuntimeSchema>;
type BundledChannelConfigSchemaMap = ReadonlyMap<string, ChannelConfigSchema>;

const bundledChannelRuntimeMap = new Map<string, ChannelConfigRuntimeSchema>();
const bundledChannelConfigSchemaMap = new Map<string, ChannelConfigSchema>();
for (const plugin of bundledChannelPlugins) {
  const channelSchema = plugin.configSchema;
  if (!channelSchema) {
    continue;
  }
  bundledChannelConfigSchemaMap.set(plugin.id, channelSchema);
  if (channelSchema.runtime) {
    bundledChannelRuntimeMap.set(plugin.id, channelSchema.runtime);
  }
}
for (const entry of BUNDLED_PLUGIN_METADATA) {
  const channelConfigs = entry.manifest.channelConfigs;
  if (!channelConfigs) {
    continue;
  }
  for (const [channelId, channelConfig] of Object.entries(channelConfigs)) {
    const channelSchema = channelConfig?.schema as Record<string, unknown> | undefined;
    if (!channelSchema) {
      continue;
    }
    if (!bundledChannelConfigSchemaMap.has(channelId)) {
      bundledChannelConfigSchemaMap.set(channelId, { schema: channelSchema });
    }
  }
}

export function getBundledChannelRuntimeMap(): BundledChannelRuntimeMap {
  return bundledChannelRuntimeMap;
}

export function getBundledChannelConfigSchemaMap(): BundledChannelConfigSchemaMap {
  return bundledChannelConfigSchemaMap;
}
