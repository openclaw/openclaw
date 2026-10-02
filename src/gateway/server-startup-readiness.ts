import type { GatewayStartupTrace } from "./server-startup-trace.js";
import type { ReadinessChecker } from "./server/readiness.js";

type GatewayReadinessLog = {
  log: { info: (message: string) => void };
  getReadiness: ReadinessChecker;
};

function logReadyResult(
  params: GatewayReadinessLog,
  result: Awaited<ReturnType<ReadinessChecker>>,
  message: string,
): void {
  if (result.ready) {
    params.log.info(message);
  }
}

export function logGatewayReady(
  params: GatewayReadinessLog,
  message = "gateway ready",
): void | Promise<void> {
  const readiness = params.getReadiness();
  if (readiness instanceof Promise) {
    return readiness.then((result) => logReadyResult(params, result, message));
  }
  logReadyResult(params, readiness, message);
}

export function logGatewaySidecarsReady(
  params: GatewayReadinessLog & {
    startupTrace?: GatewayStartupTrace;
    loadedPluginCount: number;
    postReadySidecarCount: number;
  },
): void | Promise<void> {
  params.startupTrace?.detail("sidecars.ready", [
    ["loadedPluginCount", params.loadedPluginCount],
    ["postReadySidecarCount", params.postReadySidecarCount],
  ]);
  params.startupTrace?.mark("sidecars.ready");
  return logGatewayReady(params);
}
