import type { PreparedReadinessChecker } from "./health/types.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";
import { announceGatewayInstallationReady } from "./stale-install.js";

type GatewayReadinessLog = {
  log: { info: (message: string) => void };
  getReadiness: PreparedReadinessChecker;
  isClosing?: () => boolean;
  startupTrace?: GatewayStartupTrace;
};

export async function logGatewayReady(
  params: GatewayReadinessLog,
  updateCanary = false,
): Promise<void> {
  if (params.isClosing?.()) {
    return;
  }
  if (!updateCanary) {
    await announceGatewayInstallationReady(params.getReadiness);
  }
  const prepared = await params.getReadiness.prepare();
  if (!params.isClosing?.() && prepared.publish().ready) {
    params.startupTrace?.mark("ready");
    params.log.info(
      updateCanary ? "candidate gateway ready; autonomous sidecars suppressed" : "gateway ready",
    );
  }
}

export async function logGatewaySidecarsReady(
  params: GatewayReadinessLog & {
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
