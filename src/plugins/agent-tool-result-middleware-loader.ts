// Loads agent tool result middleware from plugin runtime surfaces.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { listAgentToolResultMiddlewareOwnerPluginIds } from "./agent-tool-result-middleware-owners.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareRuntime,
} from "./agent-tool-result-middleware-types.js";
import { listAgentToolResultMiddlewares } from "./agent-tool-result-middleware.js";
import { createPluginActivationSource, normalizePluginsConfig } from "./config-state.js";
import { loadOpenClawPlugins } from "./loader.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";

const log = createSubsystemLogger("plugins/agent-tool-result-middleware");

async function resolveRuntimeConfigContext(): Promise<{
  config: OpenClawConfig;
  activationSourceConfig: OpenClawConfig;
}> {
  const { getRuntimeConfig, getRuntimeConfigSourceSnapshot } = await import("../config/config.js");
  const config = getRuntimeConfig();
  return {
    config,
    activationSourceConfig: getRuntimeConfigSourceSnapshot() ?? config,
  };
}

function listRuntimeMiddlewareOwnerPluginIds(
  registry: PluginRegistry | null | undefined,
  runtime: AgentToolResultMiddlewareRuntime,
): Set<string> {
  const pluginIds = new Set<string>();
  for (const entry of registry?.agentToolResultMiddlewares ?? []) {
    if (entry.runtimes.includes(runtime)) {
      pluginIds.add(entry.pluginId);
    }
  }
  return pluginIds;
}

function listActiveMiddlewareOwnerPluginIds(
  runtime: AgentToolResultMiddlewareRuntime,
): Set<string> {
  return listRuntimeMiddlewareOwnerPluginIds(getActivePluginRegistry(), runtime);
}

function registryHasMiddlewareOwners(params: {
  registry: PluginRegistry | undefined;
  pluginIds: readonly string[];
  runtime: AgentToolResultMiddlewareRuntime;
}): boolean {
  if (!params.registry) {
    return false;
  }
  const ownerPluginIds = listRuntimeMiddlewareOwnerPluginIds(params.registry, params.runtime);
  return params.pluginIds.every((pluginId) => ownerPluginIds.has(pluginId));
}

export async function loadAgentToolResultMiddlewaresForRuntime(params: {
  runtime: AgentToolResultMiddlewareRuntime;
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): Promise<AgentToolResultMiddleware[]> {
  const activeHandlers = listAgentToolResultMiddlewares(params.runtime);

  try {
    const runtimeContext = params.config
      ? { config: params.config, activationSourceConfig: params.config }
      : await resolveRuntimeConfigContext();
    const config = runtimeContext.config;
    const activationSourceConfig =
      params.activationSourceConfig ?? runtimeContext.activationSourceConfig;
    const env = params.env ?? process.env;
    const manifestRegistry =
      params.manifestRegistry ??
      loadPluginManifestRegistry({
        config,
        workspaceDir: params.workspaceDir,
        env,
      });
    const pluginsConfig = normalizePluginsConfig(config.plugins);
    const activationSourcePlugins = normalizePluginsConfig(activationSourceConfig.plugins);
    const activationSource = createPluginActivationSource({
      config: activationSourceConfig,
      plugins: activationSourcePlugins,
    });
    const pluginIds = listAgentToolResultMiddlewareOwnerPluginIds({
      manifestRegistry,
      runtime: params.runtime,
      config,
      pluginsConfig,
      activationSource,
    });
    if (pluginIds.length === 0) {
      return activeHandlers;
    }
    const activePluginIds = listActiveMiddlewareOwnerPluginIds(params.runtime);
    const missingPluginIds = pluginIds.filter((pluginId) => !activePluginIds.has(pluginId));
    if (missingPluginIds.length === 0) {
      return activeHandlers;
    }
    const missingPluginIdSet = new Set(missingPluginIds);

    const loadedRegistry = getLoadedRuntimePluginRegistry({
      workspaceDir: params.workspaceDir,
      env,
      requiredPluginIds: missingPluginIds,
    });
    const runtimeRegistry =
      loadedRegistry &&
      registryHasMiddlewareOwners({
        registry: loadedRegistry,
        pluginIds: missingPluginIds,
        runtime: params.runtime,
      })
        ? loadedRegistry
        : loadOpenClawPlugins({
            config,
            workspaceDir: params.workspaceDir,
            env,
            onlyPluginIds: missingPluginIds,
            manifestRegistry,
            activate: false,
            forceFullRuntimeForChannelPlugins: true,
          });

    const missingHandlers = runtimeRegistry.agentToolResultMiddlewares
      .filter(
        (entry) =>
          missingPluginIdSet.has(entry.pluginId) && entry.runtimes.includes(params.runtime),
      )
      .map((entry) => entry.handler);
    return [...activeHandlers, ...missingHandlers];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(`[${params.runtime}] failed to load tool result middleware plugins: ${detail}`);
    return listAgentToolResultMiddlewares(params.runtime);
  }
}

export const testing = {
  listMiddlewareOwnerPluginIds: listAgentToolResultMiddlewareOwnerPluginIds,
};
export { testing as __testing };
