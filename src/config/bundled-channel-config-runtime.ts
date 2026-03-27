import { bundledChannelPlugins } from "../channels/plugins/bundled.js";
import { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
import type {
  ChannelConfigRuntimeSchema,
  ChannelConfigSchema,
} from "../channels/plugins/types.plugin.js";
import { BUNDLED_PLUGIN_METADATA } from "../plugins/bundled-plugin-metadata.js";
import { MSTeamsConfigSchema } from "./zod-schema.providers-core.js";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

type BundledChannelRuntimeMap = ReadonlyMap<string, ChannelConfigRuntimeSchema>;
type BundledChannelConfigSchemaMap = ReadonlyMap<string, ChannelConfigSchema>;

const bundledChannelRuntimeMap = new Map<string, ChannelConfigRuntimeSchema>();
const bundledChannelConfigSchemaMap = new Map<string, ChannelConfigSchema>();
const staticBundledChannelSchemas = new Map<string, ChannelConfigSchema>([
  ["msteams", buildChannelConfigSchema(MSTeamsConfigSchema)],
  ["whatsapp", buildChannelConfigSchema(WhatsAppConfigSchema)],
]);
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
for (const [channelId, channelSchema] of staticBundledChannelSchemas) {
  if (!bundledChannelConfigSchemaMap.has(channelId)) {
    bundledChannelConfigSchemaMap.set(channelId, channelSchema);
  }
  if (channelSchema.runtime && !bundledChannelRuntimeMap.has(channelId)) {
    bundledChannelRuntimeMap.set(channelId, channelSchema.runtime);
  }
}

export function getBundledChannelRuntimeMap(): BundledChannelRuntimeMap {
  return bundledChannelRuntimeMap;
}

export function getBundledChannelConfigSchemaMap(): BundledChannelConfigSchemaMap {
  return bundledChannelConfigSchemaMap;
}
