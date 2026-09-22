import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import {
  collectCronHistoryOverflowTaskIds,
  CRON_HISTORY_KEEP_PER_JOB,
} from "./cron-history-retention.js";
import { getTaskRegistryMaintenanceSnapshot } from "./task-registry-maintenance-snapshot.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { listTaskRecords } from "./task-registry.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import { createStoredTask } from "./task-registry.test-support.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

describe("task-registry maintenance snapshot", () => {
  let testState: OpenClawTestState;

  beforeAll(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-task-maintenance-snapshot-",
    });
  });

  afterAll(async () => {
    await testState.cleanup();
  });

  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
  });

  it("preserves task order and raw cron partitions in maintenance snapshots", async () => {
    const base: TaskRecord = {
      ...createStoredTask(),
      runtime: "cron",
      status: "succeeded",
      endedAt: 100,
    };
    const partitions: { prefix: string; sourceId: string; detail: TaskRecord["detail"] }[] = [
      { prefix: "empty-history", sourceId: "job", detail: { kind: "cron-run", storeKey: "" } },
      { prefix: "empty-quiet", sourceId: "job", detail: { storeKey: "" } },
      { prefix: "space-store", sourceId: "job", detail: { kind: "cron-run", storeKey: " " } },
      { prefix: "missing-store", sourceId: "job", detail: { kind: "cron-run" } },
      { prefix: "padded-job", sourceId: " job ", detail: { kind: "cron-run", storeKey: "" } },
      { prefix: "space-job", sourceId: " ", detail: { kind: "cron-run", storeKey: "" } },
    ];
    const storedTasks: TaskRecord[] = [
      ...partitions.flatMap(({ prefix, sourceId, detail }) =>
        Array.from({ length: CRON_HISTORY_KEEP_PER_JOB + 1 }, (_, index) => ({
          ...base,
          taskId: `${prefix}-${String(index).padStart(4, "0")}`,
          sourceId,
          detail,
        })),
      ),
      ...Array.from(["newer-first", "newer-last"], (taskId) => ({
        ...base,
        taskId,
        runtime: "cli" as const,
        createdAt: 200,
        lastEventAt: 200,
        endedAt: 200,
      })),
      { ...base, taskId: "older", createdAt: 50, lastEventAt: 50, endedAt: 50 },
      { ...base, taskId: "missing-source", sourceId: undefined },
      { ...base, taskId: "empty-source", sourceId: "" },
      ...Array.from(["queued", "running", "lost"] as const, (status) => ({
        ...base,
        taskId: `excluded-${status}`,
        sourceId: "job",
        status,
        createdAt: 300,
        lastEventAt: 300,
        endedAt: status === "lost" ? 300 : undefined,
        detail: { kind: "cron-run", storeKey: "" },
      })),
    ];
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map(storedTasks.map((task) => [task.taskId, task])),
          deliveryStates: new Map(),
        }),
      },
      observers: null,
    });
    const listed = listTaskRecords();
    const read = await prepareTaskRegistryRead();
    if (!read) {
      throw new Error("Expected prepared maintenance snapshot");
    }
    const snapshot = getTaskRegistryMaintenanceSnapshot(read);
    expect(snapshot.taskIds).toEqual(listed.map((task) => task.taskId));
    expect(snapshot.taskIds.slice(0, 5)).toEqual([
      "excluded-lost",
      "excluded-running",
      "excluded-queued",
      "newer-last",
      "newer-first",
    ]);
    expect(snapshot.taskIds.at(-1)).toBe("older");
    expect([...snapshot.cronHistoryOverflowTaskIds]).toEqual([
      ...collectCronHistoryOverflowTaskIds(listed),
    ]);
    expect(snapshot.cronHistoryOverflowTaskIds).toEqual(
      new Set(partitions.map(({ prefix }) => `${prefix}-0000`)),
    );
  });
});
