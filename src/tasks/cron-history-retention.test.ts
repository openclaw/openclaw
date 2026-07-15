import { describe, expect, it } from "vitest";
import {
  collectCronHistoryOverflowTaskIds,
  CRON_HISTORY_KEEP_PER_JOB,
} from "./cron-history-retention.js";
import type { TaskRecord } from "./task-registry.types.js";

function cronHistoryTask(params: {
  taskId: string;
  sourceId: string;
  endedAt: number;
  storeKey?: string;
}): TaskRecord {
  return {
    taskId: params.taskId,
    runtime: "cron",
    sourceId: params.sourceId,
    requesterSessionKey: "agent:main:main",
    ownerKey: "system:cron:test",
    scopeKind: "system",
    task: "cron history",
    status: "succeeded",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: params.endedAt,
    endedAt: params.endedAt,
    lastEventAt: params.endedAt,
    detail: params.storeKey ? { storeKey: params.storeKey } : undefined,
  };
}

describe("collectCronHistoryOverflowTaskIds", () => {
  it("keeps same-id cron history scoped to each configured store", () => {
    const sourceId = "shared-explicit-job-id";
    const storeA = Array.from({ length: CRON_HISTORY_KEEP_PER_JOB + 1 }, (_, index) =>
      cronHistoryTask({
        taskId: `store-a-${index}`,
        sourceId,
        storeKey: "store:a",
        endedAt: index + 2,
      }),
    );
    const storeB = cronHistoryTask({
      taskId: "store-b-only-row",
      sourceId,
      storeKey: "store:b",
      endedAt: 1,
    });

    expect(collectCronHistoryOverflowTaskIds([...storeA, storeB])).toEqual(new Set(["store-a-0"]));
  });

  it("keeps legacy rows without a store key in one per-job retention bucket", () => {
    const tasks = Array.from({ length: CRON_HISTORY_KEEP_PER_JOB + 1 }, (_, index) =>
      cronHistoryTask({
        taskId: `legacy-${index}`,
        sourceId: "legacy-job",
        endedAt: index,
      }),
    );

    expect(collectCronHistoryOverflowTaskIds(tasks)).toEqual(new Set(["legacy-0"]));
  });
});
