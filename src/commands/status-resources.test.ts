import { expect, it } from "vitest";
import { buildStatusResourceRows } from "./status-resources.js";

it("renders server resource facts with unknown policies and incomplete heap coverage", () => {
  const rows = buildStatusResourceRows({
    configured: "auto",
    profile: "lean",
    reason: "memory",
    memoryLimitBytes: 1536 * 1024 ** 2,
    memoryLimitSource: "cgroup-v2",
    cpus: 8,
    workerCount: 3,
    workerMemoryScope: "direct",
    workerHeapSampledCount: 1,
    workerCensus: [
      {
        kind: "reader.worker.js",
        poolId: 1,
        workerClass: "reader",
        count: 2,
        floor: 1,
        cap: 2,
        pointReadCap: 3,
        idlePolicy: "retain-one",
        idleTimeoutMs: 60000,
        heapUsedBytes: 10 * 1024 ** 2,
        heapSampledCount: 1,
      },
      {
        kind: "other",
        workerClass: "other",
        count: 1,
        floor: null,
        cap: null,
        idlePolicy: "unknown",
        heapUsedBytes: null,
        heapSampledCount: 0,
      },
    ],
  });
  expect(rows).toEqual([
    {
      Item: "Resources",
      Value: "lean (auto: memory) · 1536 MiB cgroup-v2 · 8 CPUs · 3 direct workers",
    },
    {
      Item: "Worker reader.worker.js #1",
      Value:
        "2 reader · floor 1 · cap 2 (point reads 3) · idle retain-one 60000ms · heap 10 MiB (1/2 sampled)",
    },
    {
      Item: "Worker other",
      Value:
        "1 other · floor unknown · cap unknown · idle unknown · heap unavailable (0/1 sampled)",
    },
  ]);
  expect(buildStatusResourceRows(undefined)).toEqual([]);
});

it("renders lean admission totals and only families with budget activity", () => {
  const MiB = 1024 ** 2;
  const rows = buildStatusResourceRows({
    configured: "auto",
    profile: "lean",
    reason: "memory",
    memoryLimitBytes: 1536 * MiB,
    memoryLimitSource: "cgroup-v2",
    cpus: 8,
    workerCount: 0,
    workerMemoryScope: "direct",
    workerHeapSampledCount: 0,
    workerCensus: [],
    memoryBudget: {
      limitBytes: 1536 * MiB,
      limitSource: "cgroup-v2",
      budgetBytes: 1305 * MiB,
      basis: "cgroup-85",
      usageBytes: 900 * MiB,
      usageSource: "cgroup-v2-working-set",
      floorBytes: 700 * MiB,
      pendingBytes: 38 * MiB,
      baselineBytes: 400 * MiB,
      floorsExceedBudget: false,
      growthAdmissions: 2,
      refusals: 5,
      waits: 3,
      waitingTasks: 1,
      waitMs: 1200,
      maxWaitMs: 800,
      families: [
        {
          family: "session-transcript.worker.js",
          growth: 1,
          growthAdmissions: 2,
          refusals: 5,
          waits: 3,
          waitingTasks: 1,
          waitMs: 1200,
          maxWaitMs: 800,
        },
        {
          family: "provider-prompt-state.worker.js",
          growth: 0,
          growthAdmissions: 0,
          refusals: 0,
          waits: 0,
          waitingTasks: 0,
          waitMs: 0,
          maxWaitMs: 0,
        },
      ],
    },
  });
  expect(rows.slice(1)).toEqual([
    {
      Item: "Worker memory budget",
      Value:
        "1305 MiB (cgroup-85) of 1536 MiB cgroup-v2 · in use 900 MiB (cgroup-v2-working-set) · floors 700 MiB incl. 400 MiB at startup · pending 38 MiB · growth 2 admitted / 5 refused · waits 3 (1 waiting, max 800 ms)",
    },
    {
      Item: "Budget session-transcript.worker.js",
      Value:
        "growth 1 held · 2 admitted / 5 refused · waits 3 (1 waiting, 1200 ms total, max 800 ms)",
    },
  ]);
});
