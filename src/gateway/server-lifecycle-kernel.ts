import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./methods/core-descriptors.js";
import type { GatewayServerLiveState } from "./server-live-state.js";
import type { GatewayPluginRuntimeClaim } from "./server-plugin-runtime-generation.js";

/**
 * Kernel handles for the Gateway lifecycle. This object is the only writer
 * of readiness and advertised-method state; residents use this surface so
 * later ownership splits cannot mutate shared state directly.
 *
 * Extracted from server-lifecycle.ts to keep that file under the max-lines
 * budget while preserving the exact mutation contract.
 */
export function createGatewayKernel(params: {
  pluginRuntimeGeneration: ReturnType<
    typeof import("./server-plugin-runtime-generation.js").createGatewayPluginRuntimeGeneration
  >;
  startupState: { dispatchReady: boolean; sidecarsReady: boolean };
  unavailableGatewayMethods: Set<string>;
  runtimeState: GatewayServerLiveState;
  activeTaskCount: { get: () => number };
  deps: { cron: unknown };
}) {
  const {
    pluginRuntimeGeneration,
    startupState,
    unavailableGatewayMethods,
    runtimeState,
    activeTaskCount,
    deps,
  } = params;
  return {
    pluginRuntimeGeneration,
    setDispatchReady: (ready: boolean) => {
      startupState.dispatchReady = ready;
    },
    markSidecarsReady: () => {
      startupState.sidecarsReady = true;
    },
    unlockStartupMethods: () => {
      for (const method of STARTUP_UNAVAILABLE_GATEWAY_METHODS) {
        unavailableGatewayMethods.delete(method);
      }
    },
    publishMethodSurface: (methods: readonly string[]) => {
      runtimeState.gatewayMethods.splice(0, runtimeState.gatewayMethods.length, ...methods);
    },
    setEarlyRuntimeHandles: (handles: {
      getActiveTaskCount: () => number;
      skillsChangeUnsub: typeof runtimeState.skillsChangeUnsub;
    }) => {
      activeTaskCount.get = handles.getActiveTaskCount;
      runtimeState.skillsChangeUnsub = handles.skillsChangeUnsub;
    },
    swapDiscovery: (next: typeof runtimeState.discovery) => {
      const previous = runtimeState.discovery;
      runtimeState.discovery = next;
      return previous;
    },
    setScheduledServiceHandles: (handles: {
      heartbeatRunner: typeof runtimeState.heartbeatRunner;
      stopDeliveryRecovery: typeof runtimeState.stopDeliveryRecovery;
    }) => {
      runtimeState.heartbeatRunner = handles.heartbeatRunner;
      runtimeState.stopDeliveryRecovery = handles.stopDeliveryRecovery;
    },
    setPostAttachHandles: (
      handles: {
        stopGatewayUpdateCheck: typeof runtimeState.stopGatewayUpdateCheck;
        pluginServices: typeof runtimeState.pluginServices;
      },
      claim: GatewayPluginRuntimeClaim,
    ) => {
      runtimeState.stopGatewayUpdateCheck = handles.stopGatewayUpdateCheck;
      pluginRuntimeGeneration.publishServices(claim, handles.pluginServices);
    },
    setTailscaleCleanup: (cleanup: typeof runtimeState.tailscaleCleanup) => {
      runtimeState.tailscaleCleanup = cleanup;
    },
    setConfigReloaderHandle: (configReloader: typeof runtimeState.configReloader) => {
      runtimeState.configReloader = configReloader;
    },
    getReloadState: () => ({
      hooksConfig: runtimeState.hooksConfig,
      hookClientIpConfig: runtimeState.hookClientIpConfig,
      heartbeatRunner: runtimeState.heartbeatRunner,
      cronState: runtimeState.cronState,
    }),
    setReloadHookState: (next: {
      hooksConfig: typeof runtimeState.hooksConfig;
      hookClientIpConfig: typeof runtimeState.hookClientIpConfig;
    }) => {
      runtimeState.hooksConfig = next.hooksConfig;
      runtimeState.hookClientIpConfig = next.hookClientIpConfig;
    },
    swapHeartbeatRunner: (next: typeof runtimeState.heartbeatRunner) => {
      const previous = runtimeState.heartbeatRunner;
      runtimeState.heartbeatRunner = next;
      return previous;
    },
    swapCronState: (next: typeof runtimeState.cronState) => {
      const previous = runtimeState.cronState;
      runtimeState.cronState = next;
      deps.cron = next.cron;
      return previous;
    },
    setChannelHealthMonitor: (next: typeof runtimeState.channelHealthMonitor) => {
      runtimeState.channelHealthMonitor = next;
    },
    notifyPluginMetadataChanged: () => {
      runtimeState.configReloader.notifyPluginMetadataChanged();
    },
    getConfigReloaderHotReloadStatus: () => runtimeState.configReloader.hotReloadStatus?.(),
    setPostReadySidecars: (sidecars: typeof runtimeState.postReadySidecars) => {
      runtimeState.postReadySidecars = sidecars;
    },
    setGatewayLifetimeSidecars: (sidecars: typeof runtimeState.gatewayLifetimeSidecars) => {
      runtimeState.gatewayLifetimeSidecars = sidecars;
    },
    addGatewayLifetimeSidecar: (sidecar: (typeof runtimeState.gatewayLifetimeSidecars)[number]) => {
      runtimeState.gatewayLifetimeSidecars.push(sidecar);
    },
    setMaintenanceHandles: (handles: NonNullable<typeof runtimeState.maintenance>) => {
      runtimeState.maintenance = handles;
      runtimeState.stopMediaCleanup = handles.stopMediaCleanup;
    },
  };
}
