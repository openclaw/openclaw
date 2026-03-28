import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { createSubsystemLogger } from "../logging.js";
import {
  resolveChannelPluginIds,
  resolveConfiguredChannelPluginIds,
} from "../plugins/channel-plugin-ids.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
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

function activeRegistrySatisfiesScope(
  scope: PluginRegistryScope,
  active: ReturnType<typeof getActivePluginRegistry>,
  expectedChannelPluginIds: readonly string[],
): boolean {
  if (!active) {
    return false;
  }
  const activeChannelPluginIds = new Set(active.channels.map((entry) => entry.plugin.id));
  switch (scope) {
    case "configured-channels":
    case "channels":
      return (
        active.channels.length > 0 &&
        expectedChannelPluginIds.every((pluginId) => activeChannelPluginIds.has(pluginId))
      );
    case "all":
      return false;
  }
}

export function ensurePluginRegistryLoaded(options?: { scope?: PluginRegistryScope }): void {
  const scope = options?.scope ?? "all";
  if (scopeRank(pluginRegistryLoaded) >= scopeRank(scope)) {
    return;
  }
  const config = loadConfig();
  const resolvedConfig = applyPluginAutoEnable({ config, env: process.env }).config;
  const workspaceDir = resolveAgentWorkspaceDir(
    resolvedConfig,
    resolveDefaultAgentId(resolvedConfig),
  );
  const expectedChannelPluginIds =
    scope === "configured-channels"
      ? resolveConfiguredChannelPluginIds({
          config: resolvedConfig,
          workspaceDir,
          env: process.env,
        })
      : scope === "channels"
        ? resolveChannelPluginIds({
            config: resolvedConfig,
            workspaceDir,
            env: process.env,
          })
        : [];
  const active = getActivePluginRegistry();
  // Tests (and callers) can pre-seed a registry (e.g. `test/setup.ts`); avoid
  // doing an expensive load when we already have plugins/channels/tools.
  if (
    pluginRegistryLoaded === "none" &&
    activeRegistrySatisfiesScope(scope, active, expectedChannelPluginIds)
  ) {
    pluginRegistryLoaded = scope;
    return;
  }
  const logger: PluginLogger = {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    debug: (msg) => log.debug(msg),
  };
  loadOpenClawPlugins({
    config: resolvedConfig,
    workspaceDir,
    logger,
    throwOnLoadError: true,
    ...(scope === "configured-channels"
      ? {
          onlyPluginIds: expectedChannelPluginIds,
        }
      : scope === "channels"
        ? {
            onlyPluginIds: expectedChannelPluginIds,
          }
        : {}),
  });
  pluginRegistryLoaded = scope;
}
