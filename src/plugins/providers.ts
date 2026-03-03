import type { ProviderPlugin } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadBotPlugins, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";

const log = createSubsystemLogger("plugins");

export function resolvePluginProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
}): ProviderPlugin[] {
  const registry = loadBotPlugins({
    config: params.config,
    workspaceDir: params.workspaceDir,
    logger: createPluginLoaderLogger(log),
  });

  return registry.providers.map((entry) => entry.provider);
}
