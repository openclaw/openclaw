import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { loadConfig, readConfigFileSnapshot } from "./config.js";
import type { OpenClawConfig } from "./config.js";
import { buildConfigSchema, type ConfigSchemaResponse } from "./schema.js";

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
  const pluginRegistry = loadOpenClawPlugins({
    config,
    cache: opts?.cache,
    activate: opts?.activate,
    workspaceDir,
    runtimeOptions: {
      allowGatewaySubagentBinding: true,
    },
    logger: silentSchemaLogger,
  });

  return pluginRegistry.plugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    configUiHints: plugin.configUiHints,
    configSchema: plugin.configJsonSchema,
  }));
}

function mapChannelSchemaMetadata() {
  return listChannelPlugins().map((entry) => ({
    id: entry.id,
    label: entry.meta.label,
    description: entry.meta.blurb,
    configSchema: entry.configSchema?.schema,
    configUiHints: entry.configSchema?.uiHints,
  }));
}

export function loadRuntimeConfigSchema(): ConfigSchemaResponse {
  const cfg = loadConfig();
  return buildConfigSchema({
    plugins: mapPluginSchemaMetadata(cfg, { activate: true, cache: true }),
    channels: mapChannelSchemaMetadata(),
  });
}

export async function readBestEffortRuntimeConfigSchema(): Promise<ConfigSchemaResponse> {
  const snapshot = await readConfigFileSnapshot();
  const channels = mapChannelSchemaMetadata();

  if (!snapshot.valid) {
    return buildConfigSchema({ channels });
  }

  try {
    return buildConfigSchema({
      plugins: mapPluginSchemaMetadata(snapshot.config, { activate: false, cache: false }),
      channels,
    });
  } catch {
    return buildConfigSchema({ channels });
  }
}
