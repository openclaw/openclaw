import type { GatewayStartupTrace } from "./server-startup-trace.js";
import type { PreparedReadinessChecker } from "./server/readiness.js";

type GatewayReadinessLog = {
  log: { info: (message: string) => void; warn?: (message: string) => void };
  getReadiness: PreparedReadinessChecker;
  isClosing?: () => boolean;
};

/**
 * A launcher-started runtime slot on trial is proven once the Gateway is ready
 * (listening, channels started): clear its trial so later starts keep it, and
 * finish the chat or Control UI update run that flipped to it.
 */
export async function confirmRuntimeSlotOnReady(log: GatewayReadinessLog["log"]) {
  try {
    const { settleRuntimeSlot } = await import("../infra/runtime-slots.js");
    const settled = settleRuntimeSlot();
    if (!settled) {
      return;
    }
    log.info(`runtime slot ${settled.outcome}`);
    if (settled.run) {
      const [{ finishUpdateRunAsync }, { VERSION }] = await Promise.all([
        import("../infra/update-run-write.async.js"),
        import("../version.js"),
      ]);
      await finishUpdateRunAsync(
        settled.run,
        settled.outcome === "confirmed"
          ? { status: "succeeded", after: { version: VERSION } }
          : {
              status: "rolled-back",
              reason: "runtime-slot-rolled-back",
              after: { version: VERSION },
            },
      );
    }
  } catch (error) {
    (log.warn ?? log.info)(`runtime slot confirmation failed: ${String(error)}`);
  }
}

export async function logGatewayReady(
  params: GatewayReadinessLog,
  message = "gateway ready",
): Promise<void> {
  const prepared = await params.getReadiness.prepare();
  if (!params.isClosing?.() && prepared.publish().ready) {
    params.log.info(message);
    await confirmRuntimeSlotOnReady(params.log);
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
      await confirmRuntimeSlotOnReady(params.log);
    }
  };
}
