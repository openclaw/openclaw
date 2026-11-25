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
    ...(resources.memoryBudget
      ? [
          {
            Item: "Worker memory budget",
            Value: `${mib(resources.memoryBudget.budgetBytes)} (${resources.memoryBudget.basis}) of ${mib(resources.memoryBudget.limitBytes)} ${resources.memoryBudget.limitSource} · in use ${resources.memoryBudget.usageBytes === null ? "unknown" : mib(resources.memoryBudget.usageBytes)} (${resources.memoryBudget.usageSource}) · floors ${mib(resources.memoryBudget.floorBytes)} incl. ${mib(resources.memoryBudget.baselineBytes)} at startup${resources.memoryBudget.floorsExceedBudget ? " (exceed budget)" : ""} · pending ${mib(resources.memoryBudget.pendingBytes)} · growth ${resources.memoryBudget.growthAdmissions} admitted / ${resources.memoryBudget.refusals} refused · waits ${resources.memoryBudget.waits} (${resources.memoryBudget.waitingTasks} waiting, max ${Math.round(resources.memoryBudget.maxWaitMs)} ms)`,
          },
          ...resources.memoryBudget.families
            .filter((row) => row.refusals > 0 || row.growthAdmissions > 0)
            .map((row) => ({
              Item: `Budget ${row.family}`,
              Value: `growth ${row.growth} held · ${row.growthAdmissions} admitted / ${row.refusals} refused · waits ${row.waits} (${row.waitingTasks} waiting, ${Math.round(row.waitMs)} ms total, max ${Math.round(row.maxWaitMs)} ms)`,
            })),
        ]
      : []),
    ...resources.workerCensus.map((row) => ({
      Item: `Worker ${row.kind}${row.poolId === undefined ? "" : ` #${row.poolId}`}`,
      Value: `${row.count} ${row.workerClass} · floor ${row.floor ?? "unknown"} · cap ${row.cap ?? "unknown"}${row.pointReadCap === undefined ? "" : ` (point reads ${row.pointReadCap})`} · idle ${row.idlePolicy}${row.idleTimeoutMs === undefined ? "" : ` ${row.idleTimeoutMs}ms`}${row.burstIdleTimeoutMs === undefined ? "" : ` / burst ${row.burstIdleTimeoutMs}ms`}${row.hostedEndpoints === undefined ? "" : ` · hosts ${row.hostedEndpoints} endpoints`} · heap ${row.heapUsedBytes === null ? "unavailable" : mib(row.heapUsedBytes)} (${row.heapSampledCount}/${row.count} sampled)`,
    })),
  ];
}
