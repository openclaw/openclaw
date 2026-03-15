import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import type { ProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");

export function resolvePluginProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: PluginLoadOptions["env"];
}): ProviderPlugin[] {
  const registry = loadOpenClawPlugins({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    logger: createPluginLoaderLogger(log),
    activate: false,
  });

  return registry.providers.map((entry) => ({
    ...entry.provider,
    pluginId: entry.pluginId,
  }));
}
