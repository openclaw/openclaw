import type { DiagnosticWorkerCensus } from "./diagnostic-process-types.js";
import type { WorkerPoolClass } from "./worker-pool-sizing.js";

export type WorkerPoolPolicy = {
  /** Retained idle floor after first use, not eager startup workers. */
  floor: number;
  cap: number;
  pointReadCap: number;
  idleTimeoutMs: number;
  burstIdleTimeoutMs?: number;
};

/** Project the live native registry; no second registry or sampling lifecycle. */
export function buildWorkerCensus(
  sources: Iterable<{
    script: string;
    poolId?: number;
    policy?: WorkerPoolPolicy;
    taskMetrics?: { workerClass: WorkerPoolClass | "other" };
    hostedEndpoints?: () => number;
    heap?: { value: { heapUsed: number }; sampledAt: number };
  }>,
) {
  const rows = new Map<string, DiagnosticWorkerCensus>();
  const pools = new Map<number, { poolId: number; script: string; workerCount: number }>();
  let workerCount = 0;
  let workerHeapSampledCount = 0;
  const now = performance.now();
  for (const source of sources) {
    workerCount++;
    if (source.poolId !== undefined) {
      const pool = pools.get(source.poolId);
      if (pool) {
        pool.workerCount++;
      } else {
        pools.set(source.poolId, { poolId: source.poolId, script: source.script, workerCount: 1 });
      }
    }
    const key = `${source.poolId ?? "direct"}:${source.script}`;
    let row = rows.get(key);
    if (!row) {
      const policy = source.policy;
      row = {
        kind: source.script,
        poolId: source.poolId,
        workerClass: source.taskMetrics?.workerClass ?? "other",
        count: 0,
        floor: policy?.floor ?? null,
        cap: policy?.cap ?? null,
        pointReadCap: policy?.pointReadCap,
        idlePolicy: !policy
          ? "unknown"
          : policy.idleTimeoutMs <= 0
            ? "until-close"
            : policy.floor > 0
              ? "retain-one"
              : "timeout",
        idleTimeoutMs: policy?.idleTimeoutMs,
        burstIdleTimeoutMs: policy?.burstIdleTimeoutMs,
        heapUsedBytes: null,
        heapSampledCount: 0,
      };
      rows.set(key, row);
    }
    row.count++;
    if (source.hostedEndpoints) {
      row.hostedEndpoints = (row.hostedEndpoints ?? 0) + source.hostedEndpoints();
    }
    // Same freshness window as diagnostic.memory.sample; missing is not zero.
    if (source.heap && now - source.heap.sampledAt < 60_000) {
      row.heapUsedBytes = (row.heapUsedBytes ?? 0) + source.heap.value.heapUsed;
      row.heapSampledCount++;
      workerHeapSampledCount++;
    }
  }
  return {
    workerCount,
    workerPoolCount: pools.size,
    workerPools: [...pools.values()]
      .toSorted((a, b) => b.workerCount - a.workerCount || a.poolId - b.poolId)
      .slice(0, 100),
    workerMemoryScope: "direct" as const,
    workerHeapSampledCount,
    workerCensus: [...rows.values()].toSorted(
      (a, b) => a.kind.localeCompare(b.kind) || (a.poolId ?? 0) - (b.poolId ?? 0),
    ),
  };
}
