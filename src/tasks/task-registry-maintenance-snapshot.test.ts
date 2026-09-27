import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import * as statePaths from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import {
  collectCronHistoryOverflowTaskIds,
  CRON_HISTORY_KEEP_PER_JOB,
} from "./cron-history-retention.js";
import {
  getTaskRegistryMaintenanceSnapshot,
  getTaskRegistryMaintenanceTask,
  TASK_MAINTENANCE_BATCH_SIZE,
  visitTaskRegistryMaintenanceTasks,
} from "./task-registry-maintenance-snapshot.js";
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
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetTaskRegistryForTests({ persist: false });
  });

  it.each(["database", "store", "state directory"] as const)(
    "rejects a changed %s after an awaited visitor before selecting another task",
    async (replacement) => {
      const stored = ["first", "second"].map((taskId) => {
        const task = createStoredTask();
        task.taskId = taskId;
        task.runtime = "cli";
        task.status = "succeeded";
        return task;
      });
      configureTaskRegistryRuntime({
        store: createInMemoryTaskRegistryStore({
          tasks: new Map(stored.map((task) => [task.taskId, task])),
          deliveryStates: new Map(),
        }),
        observers: null,
      });
      const visit = vi.fn(async () => {
        if (replacement === "database") {
          await closeOpenClawStateDatabaseByPathAsync(statePaths.resolveOpenClawStateSqlitePath());
        } else if (replacement === "store") {
          configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
        } else {
          vi.stubEnv("OPENCLAW_STATE_DIR", testState.path("replacement"));
        }
      });
      await expect(
        visitTaskRegistryMaintenanceTasks(
          {
            prepareTaskRegistryRead,
            getTaskRegistryMaintenanceSnapshot,
            getTaskRegistryMaintenanceTask,
          },
          visit,
        ),
      ).rejects.toThrow(/owner|admission/);
      expect(visit).toHaveBeenCalledOnce();
    },
  );

  it("bounds database path resolution while scanning 5,000 retained tasks", async () => {
    const retained = Array.from({ length: 5_000 }, (_, index) => ({
      ...createStoredTask(),
      taskId: `retained-${index}`,
      runtime: "cli" as const,
      status: "succeeded" as const,
      cleanupAfter: Date.now() + 86_400_000,
    }));
    configureTaskRegistryRuntime({
      store: createInMemoryTaskRegistryStore({
        tasks: new Map(retained.map((task) => [task.taskId, task])),
        deliveryStates: new Map(),
      }),
      observers: null,
    });
    await prepareTaskRegistryRead();
    const resolvePath = vi.spyOn(statePaths, "resolveOpenClawStateSqlitePath");
    const visit = vi.fn(async () => {});
    const prepareBatch = vi.fn(async () => {});
    let selectionResolutions = 0;
    let selections = 0;
    const result = await visitTaskRegistryMaintenanceTasks(
      {
        prepareTaskRegistryRead,
        getTaskRegistryMaintenanceSnapshot,
        getTaskRegistryMaintenanceTask: (...args) => {
          const before = resolvePath.mock.calls.length;
          const task = getTaskRegistryMaintenanceTask(...args);
          selectionResolutions += resolvePath.mock.calls.length - before;
          selections += 1;
          return task;
        },
      },
      visit,
      prepareBatch,
    );
    expect(result.deferred).toBe(0);
    expect(visit).not.toHaveBeenCalled();
    expect(prepareBatch).toHaveBeenCalledTimes(retained.length / TASK_MAINTENANCE_BATCH_SIZE);
    expect(selections).toBe(retained.length * 2);
    expect(selectionResolutions).toBe(0);
  });

  it("rechecks batch admission after the preparation promise resumes", async () => {
    const retained = Array.from({ length: TASK_MAINTENANCE_BATCH_SIZE + 1 }, (_, index) => ({
      ...createStoredTask(),
      taskId: `retained-${index}`,
      runtime: "cli" as const,
      status: "succeeded" as const,
      cleanupAfter: Date.now() + 86_400_000,
    }));
    configureTaskRegistryRuntime({
      store: createInMemoryTaskRegistryStore({
        tasks: new Map(retained.map((task) => [task.taskId, task])),
        deliveryStates: new Map(),
      }),
      observers: null,
    });
    let preparations = 0;
    const select = vi.fn(getTaskRegistryMaintenanceTask);
    await expect(
      visitTaskRegistryMaintenanceTasks(
        {
          async prepareTaskRegistryRead() {
            const read = await prepareTaskRegistryRead();
            if (++preparations === 2) {
              queueMicrotask(() => {
                queueMicrotask(() => {
                  configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
                });
              });
            }
            return read;
          },
          getTaskRegistryMaintenanceSnapshot,
          getTaskRegistryMaintenanceTask: select,
        },
        async () => {},
      ),
    ).rejects.toThrow(/owner/);
    expect(select).toHaveBeenCalledTimes(TASK_MAINTENANCE_BATCH_SIZE);
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
    expect(new Set(snapshot.cronHistoryOverflowSelections.keys())).toEqual(
      collectCronHistoryOverflowTaskIds(listed),
    );
    expect(new Set(snapshot.cronHistoryOverflowSelections.keys())).toEqual(
      new Set(partitions.map(({ prefix }) => `${prefix}-0000`)),
    );
  });
});
