import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { createSubsystemLogger } from "../../logging.js";
import { loadOpenClawPlugins } from "../loader.js";
import type { PluginRegistry } from "../registry.js";
import type { PluginLogger } from "../types.js";

const log = createSubsystemLogger("plugins");

export function loadPluginMetadataRegistrySnapshot(options?: {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  loadModules?: boolean;
}): PluginRegistry {
  const env = options?.env ?? process.env;
  const baseConfig = options?.config ?? loadConfig();
  const autoEnabled = applyPluginAutoEnable({ config: baseConfig, env });
  const resolvedConfig = autoEnabled.config;
  const workspaceDir =
    options?.workspaceDir ??
    resolveAgentWorkspaceDir(resolvedConfig, resolveDefaultAgentId(resolvedConfig));
  const logger: PluginLogger = {
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
    debug: (message) => log.debug(message),
  };

  return loadOpenClawPlugins({
    config: resolvedConfig,
    activationSourceConfig: options?.activationSourceConfig ?? baseConfig,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    env,
    logger,
    throwOnLoadError: true,
    cache: false,
    activate: false,
    mode: "validate",
    loadModules: options?.loadModules,
    ...(options?.onlyPluginIds?.length ? { onlyPluginIds: options.onlyPluginIds } : {}),
  });
}
