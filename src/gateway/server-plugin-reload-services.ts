import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareMemoryRuntimeReload } from "../plugins/memory-runtime.js";
import { withPluginRegistryPreparationScope } from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import type { prepareGatewayLifecycle } from "./server-lifecycle.js";
import type { createPluginReloadCleanup } from "./server-plugin-reload-cleanup.js";

export function createPluginReloadServices(
  runtime: Pick<
    Awaited<ReturnType<typeof prepareGatewayLifecycle>>,
    | "scheduler"
    | "kernel"
    | "pluginRuntime"
    | "pluginWorkspaceDir"
    | "broadcastPluginEvent"
    | "pluginMetadataSnapshot"
  >,
  stopServices: ReturnType<typeof createPluginReloadCleanup>["stopPreviousServices"],
  previousConfig: OpenClawConfig,
) {
  const generation = runtime.kernel.pluginRuntimeGeneration;
  const previousServices = generation.currentServices();
  const previousRegistry = runtime.pluginRuntime.registry;
  const start = (
    registry: PluginRegistry,
    config: OpenClawConfig,
    onHandle: (handle: PluginServicesHandle) => void,
    deferStartForPluginIds?: ReadonlySet<string>,
  ) =>
    withPluginRegistryPreparationScope(registry, () =>
      startPluginServices({
        scheduler: runtime.scheduler,
        registry,
        config,
        workspaceDir: runtime.pluginWorkspaceDir,
        broadcastPluginEvent: runtime.broadcastPluginEvent,
        getCronService: runtime.kernel.getCronService,
        previous: generation.currentServices(),
        onHandle,
        throwOnStartError: true,
        deferStartForPluginIds,
      }),
    );
  return {
    start,
    // The still-published metadata cache retires at publication with its lazily loaded registries.
    prepareMemory: (previous: PluginRegistry, next: PluginRegistry) =>
      prepareMemoryRuntimeReload(previous, next, runtime.pluginMetadataSnapshot),
    stopForReplacement(
      pluginIds: ReadonlySet<string>,
      restartMemoryIds: ReadonlySet<string>,
      hasResourceHandoff: boolean,
      stopOwner: (strict: boolean, label: string, run: () => Promise<void>) => Promise<void>,
    ) {
      const strict = hasResourceHandoff || restartMemoryIds.size > 0;
      const selected = new Set([...pluginIds, ...restartMemoryIds]);
      return stopOwner(strict, "Plugin service cleanup failed", () =>
        stopServices(generation.currentServices(), strict, selected),
      );
    },
    prepareRetirement(pluginIds: ReadonlySet<string>, stopHooks: () => Promise<void>) {
      // Never resolve current services from a delayed predecessor cleanup.
      return async () => {
        await stopServices(previousServices, true, pluginIds);
        await stopHooks();
      };
    },
    async retainFailedCandidate(candidate: PluginServicesHandle, restorePrevious: boolean) {
      // Retained attempts moved here; preserve custody even if restoration fails.
      generation.setServices(candidate);
      if (restorePrevious) {
        await start(previousRegistry, previousConfig, (handle) => generation.setServices(handle));
      }
    },
    async resumeMemory(
      memory: ReturnType<typeof prepareMemoryRuntimeReload> | undefined,
      config: OpenClawConfig,
      rollback = false,
    ) {
      if (!memory) {
        return;
      }
      const restartPluginIds = rollback ? memory.rollback() : memory.restartPluginIds;
      if (!rollback) {
        memory.commit(runtime.pluginRuntime.registry);
      }
      if (restartPluginIds.size === 0) {
        return;
      }
      // Early rollback may have drained managers before reaching service stop.
      if (rollback) {
        await stopServices(generation.currentServices(), true, restartPluginIds);
      }
      // A retained instance must reacquire managers only after registry adoption
      // and memory admission resume; startup is part of this reload's completion.
      await start(runtime.pluginRuntime.registry, config, (handle) =>
        generation.setServices(handle),
      );
    },
  };
}
