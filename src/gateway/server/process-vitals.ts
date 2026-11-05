import type { SystemInfoResult } from "../../../packages/gateway-protocol/src/schema/system-info.js";
import { createLazyPromise } from "../../shared/lazy-runtime.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

const loadWorkerPoolOwners = createLazyPromise(() =>
  Promise.all([
    import("../../config/sessions/session-transcript-reconcile-pool.js"),
    import("../../agents/prepared-model-catalog-worker.js"),
  ]),
);

export async function readGatewayWorkerPoolFacts() {
  const [transcripts, catalogs] = await loadWorkerPoolOwners();
  return {
    transcriptReconciliation: transcripts.getSessionTranscriptReconcileWorkerPoolSnapshot(),
    modelCatalog: catalogs.getPreparedModelCatalogWorkerPoolSnapshot(),
  };
}

export async function collectGatewayWorkerPoolMetrics(): Promise<Array<readonly [string, number]>> {
  return Object.entries(await readGatewayWorkerPoolFacts()).flatMap(([owner, facts]) =>
    Object.entries(facts).map(
      ([name, value]) => [`${owner}${name[0]!.toUpperCase()}${name.slice(1)}`, value] as const,
    ),
  );
}

/** Read process counters without projecting sessions, tasks, or channel state. */
export function readGatewayProcessVitals(
  getEventLoopHealth: (() => GatewayEventLoopHealth | undefined) | undefined,
): Pick<SystemInfoResult, "eventLoop" | "processMemory"> {
  const eventLoop = getEventLoopHealth?.();
  const memory = process.memoryUsage();
  return {
    ...(eventLoop ? { eventLoop } : {}),
    processMemory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
  };
}
