import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginServiceCronHost } from "../plugins/service-cron.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import type { GatewayPluginEventBroadcastFn } from "./server-broadcast-types.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

export type GatewayPluginServicesStartup = {
  scheduler: GatewayScheduler;
  cfg: OpenClawConfig;
  pluginRegistry: PluginRegistry;
  defaultWorkspaceDir: string;
  getCronService?: () => PluginServiceCronHost | null | undefined;
  onPluginServices?: (services: PluginServicesHandle | null) => void;
  shouldStartPluginServices?: () => boolean;
  broadcastPluginEvent?: GatewayPluginEventBroadcastFn;
  startupTrace?: GatewayStartupTrace;
  log: { warn: (message: string) => void };
};

/** The startup producer is joined on shutdown; services publish their own cleanup handle. */
export async function startGatewayPluginServices(
  params: GatewayPluginServicesStartup,
): Promise<void> {
  await measureStartup(params.startupTrace, "sidecars.plugin-services", async () => {
    try {
      const { startPluginServices } = await import("../plugins/services.js");
      if (params.shouldStartPluginServices?.() === false) {
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
        onHandle: params.onPluginServices,
      });
    } catch (err) {
      params.log.warn(`plugin services failed to start: ${String(err)}`);
    }
  });
}
