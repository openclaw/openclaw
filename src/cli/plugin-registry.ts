import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listPotentialConfiguredChannelIds } from "../channels/config-presence.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginLogger } from "../plugins/types.js";

const log = createSubsystemLogger("plugins");
let pluginRegistryLoaded: "none" | "configured-channels" | "channels" | "all" = "none";

export type PluginRegistryScope = "configured-channels" | "channels" | "all";

function scopeRank(scope: typeof pluginRegistryLoaded): number {
  switch (scope) {
    case "none":
      return 0;
    case "configured-channels":
      return 1;
    case "channels":
      return 2;
    case "all":
      return 3;
  }
}

function resolveChannelPluginIds(params: {
  config: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  return loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .plugins.filter((plugin) => plugin.channels.length > 0)
    .map((plugin) => plugin.id);
}

function resolveConfiguredChannelPluginIds(params: {
  config: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()),
  );
  if (configuredChannelIds.size === 0) {
    return [];
  }
  return resolveChannelPluginIds(params).filter((pluginId) => configuredChannelIds.has(pluginId));
}

export function ensurePluginRegistryLoaded(options?: { scope?: PluginRegistryScope }): void {
  const scope = options?.scope ?? "all";
  if (scopeRank(pluginRegistryLoaded) >= scopeRank(scope)) {
    return;
  }
  const active = getActivePluginRegistry();
  // Tests (and callers) can pre-seed a registry (e.g. `test/setup.ts`); avoid
  // doing an expensive load when we already have plugins/channels/tools.
  if (
    pluginRegistryLoaded === "none" &&
    active &&
    (active.plugins.length > 0 || active.channels.length > 0 || active.tools.length > 0)
  ) {
    pluginRegistryLoaded = "all";
    return;
  }
  const config = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const logger: PluginLogger = {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    debug: (msg) => log.debug(msg),
  };
  loadOpenClawPlugins({
    config,
    workspaceDir,
    logger,
    ...(scope === "configured-channels"
      ? {
          onlyPluginIds: resolveConfiguredChannelPluginIds({
            config,
            workspaceDir,
            env: process.env,
          }),
        }
      : scope === "channels"
        ? {
            onlyPluginIds: resolveChannelPluginIds({
              config,
              workspaceDir,
              env: process.env,
            }),
          }
        : {}),
  });
  pluginRegistryLoaded = scope;
}
