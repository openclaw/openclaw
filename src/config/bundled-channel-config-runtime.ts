import * as bundledChannelModule from "../channels/plugins/bundled.js";
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
type BundledChannelPluginShape = {
  id: string;
  configSchema?: ChannelConfigSchema;
};
type BundledChannelMaps = {
  runtimeMap: Map<string, ChannelConfigRuntimeSchema>;
  configSchemaMap: Map<string, ChannelConfigSchema>;
};

const staticBundledChannelSchemas = new Map<string, ChannelConfigSchema>([
  ["msteams", buildChannelConfigSchema(MSTeamsConfigSchema)],
  ["whatsapp", buildChannelConfigSchema(WhatsAppConfigSchema)],
]);
let cachedBundledChannelMaps: BundledChannelMaps | undefined;

function buildBundledChannelMaps(
  plugins: readonly BundledChannelPluginShape[],
): BundledChannelMaps {
  const runtimeMap = new Map<string, ChannelConfigRuntimeSchema>();
  const configSchemaMap = new Map<string, ChannelConfigSchema>();

  for (const plugin of plugins) {
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

  return { runtimeMap, configSchemaMap };
}

function readBundledChannelPlugins(): readonly BundledChannelPluginShape[] | undefined {
  try {
    return Array.isArray(bundledChannelModule.bundledChannelPlugins)
      ? (bundledChannelModule.bundledChannelPlugins as readonly BundledChannelPluginShape[])
      : undefined;
  } catch (error) {
    // Circular bundled channel imports can transiently hit TDZ during test/bootstrap
    // initialization. Fall back to metadata/static schemas until the registry is ready.
    if (error instanceof ReferenceError) {
      return undefined;
    }
    throw error;
  }
}

function getBundledChannelMaps(): BundledChannelMaps {
  const plugins = readBundledChannelPlugins();
  if (plugins && cachedBundledChannelMaps) {
    return cachedBundledChannelMaps;
  }

  const maps = buildBundledChannelMaps(plugins ?? []);
  // Tests and some import cycles can temporarily expose an incomplete bundled list.
  // Only cache once the exported plugin array is actually available.
  if (plugins) {
    cachedBundledChannelMaps = maps;
  }
  return maps;
}

export function getBundledChannelRuntimeMap(): BundledChannelRuntimeMap {
  return getBundledChannelMaps().runtimeMap;
}

export function getBundledChannelConfigSchemaMap(): BundledChannelConfigSchemaMap {
  return getBundledChannelMaps().configSchemaMap;
}
