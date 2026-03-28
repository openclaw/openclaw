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

const staticBundledChannelSchemas = new Map<string, ChannelConfigSchema>([
  ["msteams", buildChannelConfigSchema(MSTeamsConfigSchema)],
  ["whatsapp", buildChannelConfigSchema(WhatsAppConfigSchema)],
]);
type BundledChannelConfigRuntimeState = {
  configSchemaMap: BundledChannelConfigSchemaMap;
  runtimeMap: BundledChannelRuntimeMap;
  hydratedBundledPlugins: boolean;
};

let bundledChannelConfigRuntimeState: BundledChannelConfigRuntimeState | null = null;

function buildBundledChannelConfigRuntimeState(): BundledChannelConfigRuntimeState {
  const runtimeMap = new Map<string, ChannelConfigRuntimeSchema>();
  const configSchemaMap = new Map<string, ChannelConfigSchema>();
  const hydratedBundledPlugins = Array.isArray(bundledChannelPlugins);
  const channelPlugins = hydratedBundledPlugins ? bundledChannelPlugins : [];

  for (const plugin of channelPlugins) {
    const channelSchema = plugin.configSchema;
    if (!channelSchema) {
      continue;
    }
    configSchemaMap.set(plugin.id, channelSchema);
    if (channelSchema.runtime) {
      runtimeMap.set(plugin.id, channelSchema.runtime);
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
      if (!configSchemaMap.has(channelId)) {
        configSchemaMap.set(channelId, { schema: channelSchema });
      }
    }
  }

  for (const [channelId, channelSchema] of staticBundledChannelSchemas) {
    if (!configSchemaMap.has(channelId)) {
      configSchemaMap.set(channelId, channelSchema);
    }
    if (channelSchema.runtime && !runtimeMap.has(channelId)) {
      runtimeMap.set(channelId, channelSchema.runtime);
    }
  }

  return {
    configSchemaMap,
    runtimeMap,
    hydratedBundledPlugins,
  };
}

function ensureBundledChannelConfigRuntimeState(): BundledChannelConfigRuntimeState {
  // Generated bundled channel entries can import config validation during their own
  // module initialization, so this state must be built lazily and retried once the
  // bundled plugin list finishes hydrating.
  if (
    bundledChannelConfigRuntimeState &&
    (bundledChannelConfigRuntimeState.hydratedBundledPlugins ||
      !Array.isArray(bundledChannelPlugins))
  ) {
    return bundledChannelConfigRuntimeState;
  }
  bundledChannelConfigRuntimeState = buildBundledChannelConfigRuntimeState();
  return bundledChannelConfigRuntimeState;
}

export function getBundledChannelRuntimeMap(): BundledChannelRuntimeMap {
  return ensureBundledChannelConfigRuntimeState().runtimeMap;
}

export function getBundledChannelConfigSchemaMap(): BundledChannelConfigSchemaMap {
  return ensureBundledChannelConfigRuntimeState().configSchemaMap;
}
