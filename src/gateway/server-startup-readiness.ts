import type { GatewayStartupTrace } from "./server-startup-trace.js";
import type { PreparedReadinessChecker } from "./server/readiness.js";

type GatewayReadinessLog = {
  log: { info: (message: string) => void };
  getReadiness: PreparedReadinessChecker;
  isClosing?: () => boolean;
};

export async function logGatewayReady(
  params: GatewayReadinessLog,
  message = "gateway ready",
): Promise<void> {
  const prepared = await params.getReadiness.prepare();
  if (!params.isClosing?.() && prepared.publish().ready) {
    params.log.info(message);
  }
}

export async function logGatewaySidecarsReady(
  params: GatewayReadinessLog & {
    startupTrace?: GatewayStartupTrace;
    loadedPluginCount: number;
    postReadySidecarCount: number;
  },
): Promise<void> {
  params.startupTrace?.detail("sidecars.ready", [
    ["loadedPluginCount", params.loadedPluginCount],
    ["postReadySidecarCount", params.postReadySidecarCount],
  ]);
  params.startupTrace?.mark("sidecars.ready");
  await logGatewayReady(params);
}

export function createGatewayReadyAnnouncer(
  params: GatewayReadinessLog & {
    isChatSendAvailable: () => boolean;
    areSidecarsReady: () => boolean;
    startupTrace: GatewayStartupTrace;
  },
): () => Promise<void> {
  let readyAnnounced = false;
  return async () => {
    if (
      readyAnnounced ||
      params.isClosing?.() ||
      !params.isChatSendAvailable() ||
      !params.areSidecarsReady()
    ) {
      return;
    }
    const prepared = await params.getReadiness.prepare();
    if (
      !readyAnnounced &&
      params.isChatSendAvailable() &&
      params.areSidecarsReady() &&
      !params.isClosing?.() &&
      prepared.publish().ready
    ) {
      readyAnnounced = true;
      params.startupTrace.mark("ready");
      params.log.info("gateway ready");
    }
  };
}
