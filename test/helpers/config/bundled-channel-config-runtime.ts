import * as bundledChannelModule from "../../../src/channels/plugins/bundled.js";
import type {
  ChannelConfigRuntimeSchema,
  ChannelConfigSchema,
} from "../../../src/channels/plugins/types.plugin.js";
import { listBundledPluginMetadata } from "../../../src/plugins/bundled-plugin-metadata.js";

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
        configSchemaMap.set(channelId, {
          schema: channelSchema,
          ...(channelConfig.runtime ? { runtime: channelConfig.runtime } : {}),
          ...(channelConfig.uiHints ? { uiHints: channelConfig.uiHints } : {}),
        });
      }
      if (channelConfig.runtime && !runtimeMap.has(channelId)) {
        runtimeMap.set(channelId, channelConfig.runtime);
      }
    }
  }

  return { runtimeMap, configSchemaMap };
}

function readBundledChannelPlugins(): readonly BundledChannelPluginShape[] | undefined {
  try {
    if (typeof bundledChannelModule.listBundledChannelPlugins !== "function") {
      return undefined;
    }
    const plugins = bundledChannelModule.listBundledChannelPlugins();
    return Array.isArray(plugins) ? (plugins as readonly BundledChannelPluginShape[]) : undefined;
  } catch (error) {
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
