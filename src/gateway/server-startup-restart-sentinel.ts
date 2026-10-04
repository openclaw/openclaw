import type { CliDeps } from "../cli/deps.types.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../infra/delivery-queue-state-context.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  scheduleGatewayGenerationTimer,
  type GatewayPostReadySidecarHandle,
} from "./server-startup-sidecar-scheduler.js";

export function scheduleRestartSentinelWakeAfterReady(params: {
  scheduler: GatewayScheduler;
  deps: CliDeps;
  context?: DeliveryQueueStateContext;
  log: { warn: (msg: string) => void };
  shouldRun?: () => boolean;
}): GatewayPostReadySidecarHandle {
  const context = params.context ?? captureDeliveryQueueStateContext();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, params.scheduler.signal]);
  const pending = new Set<Promise<unknown>>();
  const timer = scheduleGatewayGenerationTimer({
    scheduler: params.scheduler,
    delayMs: 750,
    origin: "restart-sentinel:wake",
    shouldRun: params.shouldRun,
    run: async (isStopped) => {
      const { scheduleRestartSentinelWake } = await import("./server-restart-sentinel.js");
      if (isStopped()) {
        return;
      }
      await scheduleRestartSentinelWake({
        scheduler: params.scheduler,
        signal,
        deps: params.deps,
        context,
        shouldRun: () => !signal.aborted && !isStopped(),
        trackWork: (work) => {
          pending.add(work);
          void work.then(
            () => pending.delete(work),
            () => pending.delete(work),
          );
        },
      });
    },
    onError: (err) => params.log.warn(`restart sentinel wake failed to schedule: ${String(err)}`),
  });
  return {
    async stop() {
      controller.abort();
      await timer.stop();
      await Promise.all(pending);
    },
  };
}
