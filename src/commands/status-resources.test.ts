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
