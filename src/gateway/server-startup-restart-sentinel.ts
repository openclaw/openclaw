import type { CliDeps } from "../cli/deps.types.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../infra/delivery-queue-state-context.js";
import { hasRestartSentinel } from "../infra/restart-sentinel.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { refreshLatestUpdateRestartSentinel } from "./server-restart-sentinel.js";
import {
  scheduleGatewayGenerationTimer,
  type GatewayPostReadySidecarHandle,
} from "./server-startup-sidecar-scheduler.js";

const loadGatewayRestartSentinelModule = createLazyRuntimeModule(
  () => import("./server-restart-sentinel.js"),
);

export function scheduleRestartSentinelWakeAfterReady(params: {
  deps: CliDeps;
  context?: DeliveryQueueStateContext;
  log: { warn: (msg: string) => void };
  shouldRun?: () => boolean;
}): GatewayPostReadySidecarHandle {
  const context = params.context ?? captureDeliveryQueueStateContext();
  let stopped = false;
  const imports = new Set<Promise<unknown>>();
  const timer = scheduleGatewayGenerationTimer({
    delayMs: 750,
    origin: "restart-sentinel:wake",
    shouldRun: params.shouldRun,
    run: async (isStopped) => {
      const { scheduleRestartSentinelWake } = await loadGatewayRestartSentinelModule();
      if (isStopped()) {
        return;
      }
      await scheduleRestartSentinelWake({
        deps: params.deps,
        context,
        shouldRun: () => !stopped && !isStopped(),
        trackImport: (work) => {
          imports.add(work);
          void work.then(
            () => imports.delete(work),
            () => imports.delete(work),
          );
        },
      });
    },
    onError: (err) => params.log.warn(`restart sentinel wake failed to schedule: ${String(err)}`),
  });
  return {
    async stop() {
      stopped = true;
      await timer.stop();
      await Promise.all(imports);
    },
  };
}

export async function refreshLatestUpdateRestartSentinelIfPresent(
  env: NodeJS.ProcessEnv = captureDeliveryQueueStateContext().workerContext.environment,
): Promise<Awaited<ReturnType<typeof refreshLatestUpdateRestartSentinel>> | null> {
  if (!(await hasRestartSentinel(env))) {
    return null;
  }
  return await (await loadGatewayRestartSentinelModule()).refreshLatestUpdateRestartSentinel(env);
}
