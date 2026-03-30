import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskRecord,
  deleteTaskRecordById,
  findTaskByRunId,
  resetTaskRegistryForTests,
} from "./task-registry.js";
import { configureTaskRegistryRuntime, type TaskRegistryHookEvent } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

function createStoredTask(): TaskRecord {
  return {
    taskId: "task-restored",
    runtime: "acp",
    sourceId: "run-restored",
    requesterSessionKey: "agent:main:main",
    childSessionKey: "agent:codex:acp:restored",
    runId: "run-restored",
    task: "Restored task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 100,
    lastEventAt: 100,
  };
}

describe("task-registry store runtime", () => {
  afterEach(() => {
    resetTaskRegistryForTests();
  });

  it("uses the configured task store for restore and save", () => {
    const storedTask = createStoredTask();
    const loadSnapshot = vi.fn(() => new Map([[storedTask.taskId, storedTask]]));
    const saveSnapshot = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot,
        saveSnapshot,
      },
    });

    expect(findTaskByRunId("run-restored")).toMatchObject({
      taskId: "task-restored",
      task: "Restored task",
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    createTaskRecord({
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-new",
      task: "New task",
      status: "running",
      deliveryStatus: "pending",
    });

    expect(saveSnapshot).toHaveBeenCalled();
    const latestSnapshot = saveSnapshot.mock.calls.at(-1)?.[0] as ReadonlyMap<string, TaskRecord>;
    expect(latestSnapshot.size).toBe(2);
    expect(latestSnapshot.get("task-restored")?.task).toBe("Restored task");
  });

  it("emits incremental hook events for restore, mutation, and delete", () => {
    const events: TaskRegistryHookEvent[] = [];
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => new Map([[createStoredTask().taskId, createStoredTask()]]),
        saveSnapshot: () => {},
      },
      hooks: {
        onEvent: (event) => {
          events.push(event);
        },
      },
    });

    expect(findTaskByRunId("run-restored")).toBeTruthy();
    const created = createTaskRecord({
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-new",
      task: "New task",
      status: "running",
      deliveryStatus: "pending",
    });
    expect(deleteTaskRecordById(created.taskId)).toBe(true);

    expect(events.map((event) => event.kind)).toEqual(["restored", "upserted", "deleted"]);
    expect(events[0]).toMatchObject({
      kind: "restored",
      tasks: [expect.objectContaining({ taskId: "task-restored" })],
    });
    expect(events[1]).toMatchObject({
      kind: "upserted",
      task: expect.objectContaining({ taskId: created.taskId }),
    });
    expect(events[2]).toMatchObject({
      kind: "deleted",
      taskId: created.taskId,
    });
  });

  it("restores persisted tasks from the default sqlite store", () => {
    const created = createTaskRecord({
      runtime: "cron",
      requesterSessionKey: "agent:main:main",
      sourceId: "job-123",
      runId: "run-sqlite",
      task: "Run nightly cron",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("run-sqlite")).toMatchObject({
      taskId: created.taskId,
      sourceId: "job-123",
      task: "Run nightly cron",
    });
  });
});
