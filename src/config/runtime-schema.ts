import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listChannelPlugins, type ChannelPlugin } from "../channels/plugins/index.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { loadConfig, readConfigFileSnapshot } from "./config.js";
import type { OpenClawConfig } from "./config.js";
import { buildConfigSchema, type ChannelUiMetadata, type ConfigSchemaResponse } from "./schema.js";

const silentSchemaLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function mapPluginSchemaMetadata(
  config: OpenClawConfig,
  opts?: { activate?: boolean; cache?: boolean },
) {
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  return loadOpenClawPlugins({
    config,
    cache: opts?.cache,
    activate: opts?.activate,
    workspaceDir,
    runtimeOptions: {
      allowGatewaySubagentBinding: true,
    },
    logger: silentSchemaLogger,
  });
}

function mapPluginSchemaMetadataFromRegistry(
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>,
) {
  return pluginRegistry.plugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    configUiHints: plugin.configUiHints,
    configSchema: plugin.configJsonSchema,
  }));
}

function mapChannelSchemaMetadataFromEntries(
  entries: Array<Pick<ChannelPlugin, "id" | "meta" | "configSchema">>,
): ChannelUiMetadata[] {
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.meta.label,
    description: entry.meta.blurb,
    configSchema: entry.configSchema?.schema,
    configUiHints: entry.configSchema?.uiHints,
  }));
}

function mapChannelSchemaMetadataFromRegistry(
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>,
) {
  if (pluginRegistry.channels.length > 0) {
    return mapChannelSchemaMetadataFromEntries(
      pluginRegistry.channels.map((entry) => entry.plugin),
    );
  }
  return mapChannelSchemaMetadataFromEntries(listChannelPlugins());
}

export function loadRuntimeConfigSchema(): ConfigSchemaResponse {
  const cfg = loadConfig();
  const pluginRegistry = mapPluginSchemaMetadata(cfg, { activate: true, cache: true });
  return buildConfigSchema({
    plugins: mapPluginSchemaMetadataFromRegistry(pluginRegistry),
    channels: mapChannelSchemaMetadataFromRegistry(pluginRegistry),
  });
}

export async function readBestEffortRuntimeConfigSchema(): Promise<ConfigSchemaResponse> {
  const snapshot = await readConfigFileSnapshot();
  const fallbackChannels = mapChannelSchemaMetadataFromEntries(listChannelPlugins());

  if (!snapshot.valid) {
    return buildConfigSchema({ channels: fallbackChannels });
  }

  try {
    const pluginRegistry = mapPluginSchemaMetadata(snapshot.config, {
      activate: false,
      cache: false,
    });
    return buildConfigSchema({
      plugins: mapPluginSchemaMetadataFromRegistry(pluginRegistry),
      channels: mapChannelSchemaMetadataFromRegistry(pluginRegistry),
    });
  } catch {
    return buildConfigSchema({ channels: fallbackChannels });
  }
}
