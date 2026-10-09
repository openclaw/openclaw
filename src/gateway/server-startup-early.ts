// Gateway early-startup runtime helpers.
// Starts discovery, remote skills, and delayed maintenance setup.
import { setSessionMcpRuntimeScheduler } from "../agents/agent-bundle-mcp-manager-api.js";
import { isNixMode } from "../config/paths.js";
import type { GatewayTailscaleMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayDiscovery } from "./server-discovery-runtime.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import type { GatewayPluginRuntimeClaim } from "./server-plugin-runtime-generation.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

type StartGatewayMaintenanceTimers =
  typeof import("./server-maintenance.js").startGatewayMaintenanceTimers;
type GatewayMaintenanceParams = Parameters<StartGatewayMaintenanceTimers>[0];

const loadRemoteSkillsRuntimeModule = async () => await import("../skills/runtime/remote.js");

/** Start early Gateway side runtimes before the main server is fully ready. */
export async function startGatewayEarlyRuntime(params: {
  scheduler: GatewayScheduler;
  minimalTestGateway: boolean;
  isClosing: () => boolean;
  updateCanary?: boolean;
  cfgAtStart: OpenClawConfig;
  port: number;
  gatewayTls: { enabled: boolean; fingerprintSha256?: string };
  gatewayDirectReachable: boolean;
  tailscaleMode: GatewayTailscaleMode;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  logDiscovery: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  nodeRegistry: Parameters<typeof import("../skills/runtime/remote.js").setSkillsRemoteRegistry>[0];
  swapDiscovery: (next: GatewayDiscovery | null) => GatewayDiscovery | null;
  pluginRegistry?: PluginRegistry;
  pluginRuntimeClaim: GatewayPluginRuntimeClaim;
  broadcast: GatewayMaintenanceParams["broadcast"];
  maintenance: Omit<
    GatewayMaintenanceParams,
    | "scheduler"
    | "broadcast"
    | "getRuntimeConfig"
    | "activeWorkInspectors"
    | "isNixMode"
    | "runWorktreeGc"
    | "runDeliveryQueueMediaGc"
    | "runManagedOutgoingMediaGc"
  >;
  getRuntimeConfig: () => OpenClawConfig;
  startupTrace?: GatewayStartupTrace;
}) {
  await setSessionMcpRuntimeScheduler(params.scheduler);
  const startSideRuntimes = !params.minimalTestGateway && !params.updateCanary;
  // Startup failure can occur immediately after discovery; publish its owner first.
  params.swapDiscovery(
    await measureStartup(params.startupTrace, "runtime.early.discovery", async () => {
      if (!startSideRuntimes) {
        return null;
      }
      const machineDisplayName = await measureStartup(
        params.startupTrace,
        "runtime.early.discovery.machine-name",
        async () => (await import("../infra/machine-name.js")).getMachineDisplayName(),
      );
      return await measureStartup(
        params.startupTrace,
        "runtime.early.discovery.start",
        async () => {
          const { startGatewayDiscovery } = await import("./server-discovery-runtime.js");
          return await startGatewayDiscovery({
            machineDisplayName,
            port: params.port,
            gatewayTls: params.gatewayTls.enabled ? params.gatewayTls : undefined,
            gatewayDirectReachable: params.gatewayDirectReachable,
            discovery: params.cfgAtStart.discovery,
            tailscaleMode: params.tailscaleMode,
            gatewayDiscoveryServices: params.pluginRegistry?.gatewayDiscoveryServices,
            pluginRuntimeClaim: params.pluginRuntimeClaim,
            logDiscovery: params.logDiscovery,
          });
        },
      );
    }),
  );
  if (startSideRuntimes) {
    const [{ primeRemoteSkillsCache, setSkillsRemoteRegistry }, { startCronMaintenance }] =
      await measureStartup(params.startupTrace, "runtime.early.lazy-runtime-imports", () =>
        Promise.all([loadRemoteSkillsRuntimeModule(), import("../cron/maintenance.js")]),
      );
    setSkillsRemoteRegistry(params.nodeRegistry);
    void primeRemoteSkillsCache();
    if (!params.isClosing()) {
      startCronMaintenance(params.scheduler);
    }
  }

  const skillsChangeUnsub = !startSideRuntimes
    ? async () => {}
    : await measureStartup(params.startupTrace, "runtime.early.skills-listener", async () => {
        const skillsRuntimePromise = import("../skills/runtime/refresh.js");
        const remoteSkillsRuntimePromise = loadRemoteSkillsRuntimeModule();
        const { closeSkillsWatchers, registerSkillsChangeListener } = await skillsRuntimePromise;
        const { refreshRemoteBinsForConnectedNodes } = await remoteSkillsRuntimePromise;
        const unregister = registerSkillsChangeListener((event) => {
          if (params.isClosing()) {
            return;
          }
          if (event.reason === "watch-available") {
            // Coverage recovery has no new content revision to probe or broadcast.
            return;
          }
          if (event.reason === "remote-node") {
            // The snapshot invalidation runs after remote descriptors/bins change;
            // clients can now refetch authoritative skills.status without racing the probe.
            params.broadcast("skills.changed", { reason: event.reason });
            return;
          }
          // Coalesce local skill changes before refreshing connected remote
          // nodes so bulk plugin/skill updates do not stampede node refreshes.
          params.scheduler.schedule({
            id: "skills.remote-bin-refresh",
            delayMs: 30_000,
            run: async () => {
              if (params.isClosing()) {
                return;
              }
              try {
                await refreshRemoteBinsForConnectedNodes(params.getRuntimeConfig());
              } catch (error) {
                params.log.warn(
                  `failed to refresh remote bins after skills change: ${String(error)}`,
                );
              }
              if (!params.isClosing()) {
                params.broadcast("skills.changed", { reason: event.reason });
              }
            },
          });
        });
        return async () => {
          unregister();
          await closeSkillsWatchers();
        };
      });

  const startMaintenance = async (
    activeWorkInspectors: Partial<GatewayActiveWorkInspectors>,
    resolveGatewayContext?: GatewayContextResolver,
  ) => {
    // Defer periodic maintenance until the caller has finished ready-state
    // wiring, but keep the lazy import owned by this early-runtime bundle.
    if (!startSideRuntimes || params.isClosing()) {
      return null;
    }
    return await measureStartup(params.startupTrace, "post-ready.maintenance", async () => {
      const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
      if (params.isClosing()) {
        return null;
      }
      return withPluginRuntimeGatewayContextResolver(
        resolveGatewayContext,
        () =>
          startGatewayMaintenanceTimers({
            ...params.maintenance,
            scheduler: params.scheduler,
            broadcast: params.broadcast,
            activeWorkInspectors,
            isNixMode,
            getRuntimeConfig: params.getRuntimeConfig,
          }),
        { inheritRequestScope: false },
      );
    });
  };

  return {
    skillsChangeUnsub,
    startMaintenance,
  };
}
