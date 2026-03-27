import { GoogleChatChannelConfigSchema } from "../../extensions/googlechat/channel-config-api.js";
import { MSTeamsChannelConfigSchema } from "../../extensions/msteams/channel-config-api.js";
import { WhatsAppChannelConfigSchema } from "../../extensions/whatsapp/channel-config-api.js";
import { bundledChannelPlugins } from "../channels/plugins/bundled.js";
import type {
  ChannelConfigRuntimeSchema,
  ChannelConfigSchema,
} from "../channels/plugins/types.plugin.js";

type BundledChannelRuntimeMap = ReadonlyMap<string, ChannelConfigRuntimeSchema>;
type BundledChannelConfigSchemaMap = ReadonlyMap<string, ChannelConfigSchema>;

const extraBundledChannelSchemas = new Map<string, ChannelConfigSchema>([
  ["googlechat", GoogleChatChannelConfigSchema],
  ["msteams", MSTeamsChannelConfigSchema],
  ["whatsapp", WhatsAppChannelConfigSchema],
]);

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
for (const [channelId, channelSchema] of extraBundledChannelSchemas) {
  bundledChannelConfigSchemaMap.set(channelId, channelSchema);
  if (channelSchema.runtime) {
    bundledChannelRuntimeMap.set(channelId, channelSchema.runtime);
  }
}

export function getBundledChannelRuntimeMap(): BundledChannelRuntimeMap {
  return bundledChannelRuntimeMap;
}

export function getBundledChannelConfigSchemaMap(): BundledChannelConfigSchemaMap {
  return bundledChannelConfigSchemaMap;
}
