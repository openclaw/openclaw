import * as bundledChannelModule from "../channels/plugins/bundled.js";
import { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
import type {
  ChannelConfigRuntimeSchema,
  ChannelConfigSchema,
} from "../channels/plugins/types.plugin.js";
import { listBundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";
import { MSTeamsConfigSchema } from "./zod-schema.providers-core.js";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

type BundledChannelRuntimeMap = ReadonlyMap<string, ChannelConfigRuntimeSchema>;
type BundledChannelConfigSchemaMap = ReadonlyMap<string, ChannelConfigSchema>;
type BundledChannelPluginShape = {
  id: string;
  configSchema?: ChannelConfigSchema;
};

const staticBundledChannelSchemas = new Map<string, ChannelConfigSchema>([
  ["msteams", buildChannelConfigSchema(MSTeamsConfigSchema)],
  ["whatsapp", buildChannelConfigSchema(WhatsAppConfigSchema)],
]);
let cachedBundledChannelRuntimeMap: Map<string, ChannelConfigRuntimeSchema> | undefined;
let cachedBundledChannelConfigSchemaMap: Map<string, ChannelConfigSchema> | undefined;

function buildBundledChannelRuntimeMap(
  plugins: readonly BundledChannelPluginShape[],
): Map<string, ChannelConfigRuntimeSchema> {
  const runtimeMap = new Map<string, ChannelConfigRuntimeSchema>();

  for (const plugin of plugins) {
    const channelSchema = plugin.configSchema;
    if (!channelSchema?.runtime) {
      continue;
    }
    runtimeMap.set(plugin.id, channelSchema.runtime);
  }

  for (const [channelId, channelSchema] of staticBundledChannelSchemas) {
    if (channelSchema.runtime && !runtimeMap.has(channelId)) {
      runtimeMap.set(channelId, channelSchema.runtime);
    }
  }

  return runtimeMap;
}

function buildBundledChannelConfigSchemaMap(): Map<string, ChannelConfigSchema> {
  const configSchemaMap = new Map<string, ChannelConfigSchema>();

  for (const entry of listBundledPluginMetadata({ includeChannelConfigs: true })) {
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
  }

  return configSchemaMap;
}

function readBundledChannelPlugins(): readonly BundledChannelPluginShape[] | undefined {
  try {
    if (typeof bundledChannelModule.listBundledChannelPlugins !== "function") {
      return undefined;
    }
    const plugins = bundledChannelModule.listBundledChannelPlugins();
    return Array.isArray(plugins) ? (plugins as readonly BundledChannelPluginShape[]) : undefined;
  } catch (error) {
    // Circular bundled channel imports can transiently hit TDZ during test/bootstrap
    // initialization. Fall back to metadata/static schemas until the registry is ready.
    if (error instanceof ReferenceError) {
      return undefined;
    }
    throw error;
  }
}

export function getBundledChannelRuntimeMap(): BundledChannelRuntimeMap {
  const plugins = readBundledChannelPlugins();
  if (plugins && cachedBundledChannelRuntimeMap) {
    return cachedBundledChannelRuntimeMap;
  }

  const runtimeMap = buildBundledChannelRuntimeMap(plugins ?? []);
  // Tests and some import cycles can temporarily expose an incomplete bundled list.
  // Only cache once the exported plugin array is actually available.
  if (plugins) {
    cachedBundledChannelRuntimeMap = runtimeMap;
  }
  return runtimeMap;
}

export function getBundledChannelConfigSchemaMap(): BundledChannelConfigSchemaMap {
  if (!cachedBundledChannelConfigSchemaMap) {
    // Config validation only needs the declared schema surface, which is available
    // directly from bundled plugin manifests and avoids eagerly loading channel code.
    cachedBundledChannelConfigSchemaMap = buildBundledChannelConfigSchemaMap();
  }
  return cachedBundledChannelConfigSchemaMap;
}
