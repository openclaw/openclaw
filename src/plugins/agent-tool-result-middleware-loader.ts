import { createSubsystemLogger } from "../logging/subsystem.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import type { AgentToolResultMiddlewareRuntime } from "./agent-tool-result-middleware-types.js";
import { listAgentToolResultMiddlewareRegistrations } from "./agent-tool-result-middleware.js";
import { loadPluginRegistryHandle } from "./loader.js";
import type {
  PluginAgentToolResultMiddlewareOwner,
  PluginAgentToolResultMiddlewareRegistration,
  PluginRegistry,
} from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";

const log = createSubsystemLogger("plugins/agent-tool-result-middleware");

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

export async function loadAgentToolResultMiddlewareRegistrationsForRuntime(params: {
  runtime: AgentToolResultMiddlewareRuntime;
}): Promise<PluginAgentToolResultMiddlewareRegistration[]> {
  const activeRegistrations = listAgentToolResultMiddlewareRegistrations(params.runtime);

  try {
    const activeRegistry = getActivePluginRegistry();
    const activePluginIds = listRuntimeMiddlewareOwnerPluginIds(activeRegistry, params.runtime);
    const missingOwners: PluginAgentToolResultMiddlewareOwner[] = [];
    for (const owner of activeRegistry?.agentToolResultMiddlewareOwners ?? []) {
      if (
        owner.runtimes.includes(params.runtime) &&
        !activePluginIds.has(owner.pluginId) &&
        !missingOwners.some((entry) => entry.pluginId === owner.pluginId)
      ) {
        missingOwners.push(owner);
      }
    }
    if (missingOwners.length === 0) {
      return activeRegistrations;
    }
    const missingPluginIds = missingOwners.map((owner) => owner.pluginId);
    const missingPluginIdSet = new Set(missingPluginIds);

    const loadedRegistry = getLoadedRuntimePluginRegistry({
      requiredPluginIds: missingPluginIds,
    });
    const loadedPluginIds = listRuntimeMiddlewareOwnerPluginIds(loadedRegistry, params.runtime);
    const runtimeRegistry =
      loadedRegistry && missingPluginIds.every((pluginId) => loadedPluginIds.has(pluginId))
        ? loadedRegistry
        : loadPluginRegistryHandle({
            config: (await import("../config/config.js")).getRuntimeConfig(),
            onlyPluginIds: missingPluginIds,
            manifestRegistry: {
              plugins: missingOwners.map((owner) => owner.manifest),
              diagnostics: [],
            },
            channelPluginLoadIntent: "full",
          });

    const missingRegistrations = runtimeRegistry.agentToolResultMiddlewares.filter(
      (entry) => missingPluginIdSet.has(entry.pluginId) && entry.runtimes.includes(params.runtime),
    );
    return [...activeRegistrations, ...missingRegistrations];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(`[${params.runtime}] failed to load tool result middleware plugins: ${detail}`);
    return listAgentToolResultMiddlewareRegistrations(params.runtime);
  }
}
