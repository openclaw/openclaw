import type { StatusSummary } from "../status/summary.js";

/** Render server-reported facts only, including incomplete heap/policy coverage. */
export function buildStatusResourceRows(resources: StatusSummary["resources"]) {
  if (!resources) {
    return [];
  }
  const mib = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MiB`;
  return [
    {
      Item: "Resources",
      Value: `${resources.profile} (${resources.configured}: ${resources.reason}) · ${mib(resources.memoryLimitBytes)} ${resources.memoryLimitSource} · ${resources.cpus} CPUs · ${resources.workerCount} direct workers`,
    },
    ...resources.workerCensus.map((row) => ({
      Item: `Worker ${row.kind}${row.poolId === undefined ? "" : ` #${row.poolId}`}`,
      Value: `${row.count} ${row.workerClass} · floor ${row.floor ?? "unknown"} · cap ${row.cap ?? "unknown"}${row.pointReadCap === undefined ? "" : ` (point reads ${row.pointReadCap})`} · idle ${row.idlePolicy}${row.idleTimeoutMs === undefined ? "" : ` ${row.idleTimeoutMs}ms`}${row.burstIdleTimeoutMs === undefined ? "" : ` / burst ${row.burstIdleTimeoutMs}ms`} · heap ${row.heapUsedBytes === null ? "unavailable" : mib(row.heapUsedBytes)} (${row.heapSampledCount}/${row.count} sampled)`,
    })),
  ];
}
