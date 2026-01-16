import { createSubsystemLogger } from "../logging.js";
import { loadClawdbotPlugins } from "./loader.js";
import type { ProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");

export function resolvePluginProviders(params: {
  config?: Parameters<typeof loadClawdbotPlugins>[0]["config"];
  workspaceDir?: string;
}): ProviderPlugin[] {
  const registry = loadClawdbotPlugins({
    config: params.config,
    workspaceDir: params.workspaceDir,
    logger: {
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
      debug: (msg) => log.debug(msg),
    },
  });

  return registry.providers.map((entry) => entry.provider);
}
