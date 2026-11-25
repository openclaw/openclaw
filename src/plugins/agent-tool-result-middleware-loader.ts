import { createSubsystemLogger } from "../logging/subsystem.js";
import type { AgentToolResultMiddlewareRuntime } from "./agent-tool-result-middleware-types.js";
import { listAgentToolResultMiddlewareRegistrations } from "./agent-tool-result-middleware.js";
import { loadPluginRegistryHandle } from "./loader.js";
import type {
  PluginAgentToolResultMiddlewareOwner,
  PluginAgentToolResultMiddlewareRegistration,
} from "./registry-types.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";
import {
  buildPluginRuntimeLoadOptions,
  getPluginRuntimeLoadContext,
} from "./runtime/load-context.js";

const log = createSubsystemLogger("plugins/agent-tool-result-middleware");

export async function loadAgentToolResultMiddlewareRegistrationsForRuntime(params: {
  runtime: AgentToolResultMiddlewareRuntime;
}): Promise<PluginAgentToolResultMiddlewareRegistration[]> {
  const registry = getPluginRegistryForContext();
  const activeRegistrations = listAgentToolResultMiddlewareRegistrations(params.runtime);

  try {
    const activePluginIds = new Set(activeRegistrations.map((entry) => entry.pluginId));
    const missingOwners: PluginAgentToolResultMiddlewareOwner[] = [];
    for (const owner of registry?.agentToolResultMiddlewareOwners ?? []) {
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
    const loadContext = getPluginRuntimeLoadContext(registry ?? undefined);
    // Reuse the owning loader's cache, never a same-id plugin from the process root.
    const runtimeRegistry = loadPluginRegistryHandle({
      ...(loadContext
        ? buildPluginRuntimeLoadOptions(loadContext)
        : { config: (await import("../config/config.js")).getRuntimeConfig() }),
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
    return activeRegistrations;
  }
}
