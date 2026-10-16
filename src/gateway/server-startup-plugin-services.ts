import { raceWithTimeout } from "../../packages/retry/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginServiceCronHost } from "../plugins/service-cron.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { GatewayPluginEventBroadcastFn } from "./server-broadcast-types.js";
import type { GatewayPluginRuntimeClaim } from "./server-plugin-runtime-generation.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

export type GatewayPluginServicesStartup = {
  scheduler: GatewayScheduler;
  cfg: OpenClawConfig;
  pluginRegistry: PluginRegistry;
  defaultWorkspaceDir: string;
  getCronService?: () => PluginServiceCronHost | null | undefined;
  onPluginServices?: (services: PluginServicesHandle | null) => void;
  shouldStartPluginServices?: (pendingOwner?: PluginServicesHandle) => boolean;
  pluginRuntimeClaim?: GatewayPluginRuntimeClaim;
  broadcastPluginEvent?: GatewayPluginEventBroadcastFn;
  startupTrace?: GatewayStartupTrace;
  log: { warn: (message: string) => void };
};

/** Retain pending service startup and cleanup across Gateway replacement. */
export async function startGatewayPluginServices(
  params: GatewayPluginServicesStartup,
): Promise<void> {
  await params.pluginRuntimeClaim?.waitForUnblocked();
  const shouldStartPluginServices =
    params.pluginRuntimeClaim?.isCurrent() !== false &&
    params.shouldStartPluginServices?.() !== false;
  if (shouldStartPluginServices) {
    let pluginServicesStopRequested = false;
    const ownedPluginServices = createDeferredCore<PluginServicesHandle | null>();
    const pluginServicesOwner: PluginServicesHandle = {
      reload: async (config, serviceIds) => {
        const handle = await ownedPluginServices.promise;
        if (pluginServicesStopRequested || !handle) {
          throw new Error("Plugin services are stopping");
        }
        await handle.reload(config, serviceIds);
      },
      stop: (options) => {
        pluginServicesStopRequested = true;
        // Pending startup owns no services and may be waiting on this replacement.
        ownedPluginServices.resolve(null);
        // Share the service owner, never a caller's expired replacement deadline.
        const stopPromise = ownedPluginServices.promise.then((handle) => handle?.stop(options));
        const deadlineAtMs = options?.strict ? options.deadlineAtMs : undefined;
        if (deadlineAtMs === undefined) {
          return stopPromise;
        }
        return raceWithTimeout(
          stopPromise.catch((error: unknown) => {
            throw error instanceof Error ? error : new Error(String(error));
          }),
          Math.max(0, deadlineAtMs - Date.now()),
          () => {
            throw new AggregateError(
              [new Error("Gateway plugin service startup did not settle before replacement")],
              "Gateway plugin service replacement cleanup failed",
            );
          },
        );
      },
    };
    // Startup may outlive a replacement deadline. Final shutdown retains this
    // owner without making startup rejoin its pending service cleanup.
    params.onPluginServices?.(pluginServicesOwner);
    await measureStartup(params.startupTrace, "sidecars.plugin-services", async () => {
      try {
        const { startPluginServices } = await import("../plugins/services.js");
        await params.pluginRuntimeClaim?.waitForUnblocked();
        if (
          pluginServicesStopRequested ||
          params.pluginRuntimeClaim?.isCurrent() === false ||
          params.shouldStartPluginServices?.(pluginServicesOwner) === false
        ) {
          ownedPluginServices.resolve(null);
          return;
        }
        await startPluginServices({
          registry: params.pluginRegistry,
          config: params.cfg,
          workspaceDir: params.defaultWorkspaceDir,
          startupTrace: params.startupTrace,
          broadcastPluginEvent: params.broadcastPluginEvent,
          getCronService: params.getCronService,
          scheduler: params.scheduler,
          onHandle: (handle) => {
            ownedPluginServices.resolve(handle);
            // Transfer the pending owner to the real service handle before startup yields.
            // A replacement or same-claim recovery must keep its own published handle.
            if (
              params.pluginRuntimeClaim?.isCurrent() !== false &&
              params.shouldStartPluginServices?.(pluginServicesOwner) !== false
            ) {
              params.onPluginServices?.(handle);
            }
          },
        });
      } catch (err) {
        ownedPluginServices.resolve(null);
        params.log.warn(`plugin services failed to start: ${String(err)}`);
      }
    });
  }
}
