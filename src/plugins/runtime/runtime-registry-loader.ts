import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { createSubsystemLogger } from "../../logging.js";
import {
  resolveChannelPluginIds,
  resolveConfiguredChannelPluginIds,
} from "../channel-plugin-ids.js";
import { loadOpenClawPlugins } from "../loader.js";
import { getActivePluginRegistry } from "../runtime.js";
import type { PluginLogger } from "../types.js";

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
  requestedPluginIds: readonly string[],
): boolean {
  if (!active) {
    return false;
  }
  if (requestedPluginIds.length > 0) {
    const activePluginIds = new Set(
      active.plugins.filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id),
    );
    return requestedPluginIds.every((pluginId) => activePluginIds.has(pluginId));
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

export function ensurePluginRegistryLoaded(options?: {
  scope?: PluginRegistryScope;
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): void {
  const scope = options?.scope ?? "all";
  const requestedPluginIds =
    options?.onlyPluginIds?.map((pluginId) => pluginId.trim()).filter(Boolean) ?? [];
  const scopedLoad = requestedPluginIds.length > 0;
  if (!scopedLoad && scopeRank(pluginRegistryLoaded) >= scopeRank(scope)) {
    return;
  }
  const env = options?.env ?? process.env;
  const baseConfig = options?.config ?? loadConfig();
  const autoEnabled = applyPluginAutoEnable({ config: baseConfig, env });
  const resolvedConfig = autoEnabled.config;
  const workspaceDir = resolveAgentWorkspaceDir(
    resolvedConfig,
    resolveDefaultAgentId(resolvedConfig),
  );
  const expectedChannelPluginIds = scopedLoad
    ? requestedPluginIds
    : scope === "configured-channels"
      ? resolveConfiguredChannelPluginIds({
          config: resolvedConfig,
          workspaceDir,
          env,
        })
      : scope === "channels"
        ? resolveChannelPluginIds({
            config: resolvedConfig,
            workspaceDir,
            env,
          })
        : [];
  const active = getActivePluginRegistry();
  if (
    (pluginRegistryLoaded === "none" || scopedLoad) &&
    activeRegistrySatisfiesScope(scope, active, expectedChannelPluginIds, expectedChannelPluginIds)
  ) {
    if (!scopedLoad) {
      pluginRegistryLoaded = scope;
    }
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
    activationSourceConfig: options?.activationSourceConfig ?? baseConfig,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    logger,
    throwOnLoadError: true,
    ...(expectedChannelPluginIds.length > 0 ? { onlyPluginIds: expectedChannelPluginIds } : {}),
  });
  if (!scopedLoad) {
    pluginRegistryLoaded = scope;
  }
}

export const __testing = {
  resetPluginRegistryLoadedForTests(): void {
    pluginRegistryLoaded = "none";
  },
};
