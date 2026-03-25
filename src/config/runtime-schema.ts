import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { loadConfig } from "./config.js";
import { buildConfigSchema, type ConfigSchemaResponse } from "./schema.js";

const silentSchemaLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export function loadRuntimeConfigSchema(): ConfigSchemaResponse {
  const cfg = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const pluginRegistry = loadOpenClawPlugins({
    config: cfg,
    cache: true,
    workspaceDir,
    runtimeOptions: {
      allowGatewaySubagentBinding: true,
    },
    logger: silentSchemaLogger,
  });

  return buildConfigSchema({
    plugins: pluginRegistry.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      configUiHints: plugin.configUiHints,
      configSchema: plugin.configJsonSchema,
    })),
    channels: listChannelPlugins().map((entry) => ({
      id: entry.id,
      label: entry.meta.label,
      description: entry.meta.blurb,
      configSchema: entry.configSchema?.schema,
      configUiHints: entry.configSchema?.uiHints,
    })),
  });
}
