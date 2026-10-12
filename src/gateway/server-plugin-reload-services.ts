import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { prepareMemoryRuntimeReload } from "../plugins/memory-runtime.js";
import { withPluginRegistryPreparationScope } from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import type { prepareGatewayLifecycle } from "./server-lifecycle.js";
import type { createPluginReloadCleanup } from "./server-plugin-reload-cleanup.js";

export function createPluginReloadServices(
  runtime: Pick<
    Awaited<ReturnType<typeof prepareGatewayLifecycle>>,
    "scheduler" | "kernel" | "pluginRuntime" | "pluginWorkspaceDir" | "broadcastPluginEvent"
  >,
  stopServices: ReturnType<typeof createPluginReloadCleanup>["stopPreviousServices"],
) {
  const generation = runtime.kernel.pluginRuntimeGeneration;
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
    async resumeMemory(
      memory: ReturnType<typeof prepareMemoryRuntimeReload> | undefined,
      config: OpenClawConfig,
      rollback = false,
    ) {
      if (!memory) {
        return;
      }
      const restartPluginIds = rollback ? memory.rollback() : memory.retainedPluginIds;
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
        generation.publishServices(generation.currentClaim(), handle),
      );
    },
  };
}
