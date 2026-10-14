import type { GatewayStartupTrace } from "./server-startup-trace.js";
import type { ReadinessChecker } from "./server/readiness.js";

type GatewayReadinessLog = {
  log: { info: (message: string) => void };
  getReadiness: ReadinessChecker;
};

export function logGatewayReady(params: GatewayReadinessLog, message = "gateway ready"): void {
  if (params.getReadiness().ready) {
    params.log.info(message);
  }
}

export function logGatewaySidecarsReady(
  params: GatewayReadinessLog & {
    startupTrace?: GatewayStartupTrace;
    loadedPluginCount: number;
    postReadySidecarCount: number;
  },
): void {
  params.startupTrace?.detail("sidecars.ready", [
    ["loadedPluginCount", params.loadedPluginCount],
    ["postReadySidecarCount", params.postReadySidecarCount],
  ]);
  params.startupTrace?.mark("sidecars.ready");
  logGatewayReady(params);
}
