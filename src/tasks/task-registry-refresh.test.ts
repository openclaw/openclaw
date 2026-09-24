import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getTaskById } from "./task-registry-query.js";
import { runTaskRegistryWorkerMutation, taskDeliveryStates, tasks } from "./task-registry-state.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import type { TaskRegistryMutationScope } from "./task-registry.store.types.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  resetTaskRegistryForTests({ persist: false });
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
  await state.cleanup();
});

function holdMutations(scopes: TaskRegistryMutationScope[]) {
  const store = getTaskRegistryStore();
  const context = captureOpenClawStateWorkerContext();
  const release = createDeferred();
  const pending = scopes.map((scope) =>
    runTaskRegistryWorkerMutation(
      {
        admission: context.admission,
        scope,
        publicationRecords: () => new Map(),
      },
      () => release.promise,
      async () => store.loadSnapshot(),
    ),
  );
  return async () => {
    release.resolve();
    await Promise.all(pending);
  };
}

it.each([1, 2])("refreshes 50 dirty scopes in one read (copies: %i)", async (copies) => {
  const records = Array.from({ length: 50 }, (_, index) =>
    createTaskFixture("cli", {
      task: `Task ${index}`,
      runId: `run-${index}`,
      childSessionKey: `agent:main:child-${index}`,
      notifyPolicy: "silent",
    }),
  );
  const updated = expectDefined(records[0], "expected a task to update");
  const deleted = expectDefined(records[1], "expected a task to delete");
  const store = getTaskRegistryStore();
  const onEvent = vi.fn();
  configureTaskRegistryRuntime({ observers: { onEvent } });
  const settle = holdMutations(
    Array.from({ length: copies }, () =>
      records.map((record) => ({
        taskId: record.taskId,
        runId: record.runId,
        childSessionKey: record.childSessionKey,
      })),
    ).flat(),
  );
  let runIdReads = 0;
  const read = expectDefined(store.loadMutationSnapshot, "expected the SQLite scoped reader");
  const load = vi.spyOn(store, "loadMutationSnapshot").mockImplementation((scopes) => {
    const snapshot = read(scopes);
    for (const record of snapshot.tasks.values()) {
      const runId = record.runId;
      Object.defineProperty(record, "runId", {
        enumerable: true,
        get() {
          runIdReads += 1;
          return runId;
        },
      });
    }
    return snapshot;
  });
  const fullLoad = vi.spyOn(store, "loadSnapshot");
  try {
    store.upsertTaskWithDeliveryState({ task: { ...updated, task: "Updated" } });
    store.deleteTaskWithDeliveryState(deleted.taskId);
    expect(getTaskById(updated.taskId)?.task).toBe("Updated");
    expect(tasks.has(deleted.taskId)).toBe(false);
    expect(tasks.size).toBe(49);
    expect(onEvent).not.toHaveBeenCalled();
    expect(fullLoad).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toHaveLength(50);
    // Count record visits, not wall time, so a quadratic union install fails deterministically.
    expect(runIdReads).toBeLessThan(records.length * 12);
  } finally {
    await settle();
  }
});

it("refreshes overlapping scopes without retaining moved-out rows or removing related owners", async () => {
  const create = (name: string) =>
    createTaskFixture("cli", {
      task: name,
      runId: `${name}-run`,
      ...(name === "moved" ? { childSessionKey: "agent:main:child" } : {}),
      ownerKey: "agent:main:child",
      notifyPolicy: "silent",
    });
  const moved = create("moved");
  const removed = create("removed");
  const related = create("related");
  const store = getTaskRegistryStore();
  const settle = holdMutations([
    { taskId: "missing-moved", runId: "moved-run" },
    { taskId: "missing-removed", runId: "removed-run" },
    { taskId: "missing-new", runId: "new-run" },
    { taskId: "missing-child", childSessionKey: "agent:main:child" },
  ]);
  try {
    store.upsertTaskWithDeliveryState({
      task: { ...moved, runId: "new-run", childSessionKey: undefined },
      deliveryState: { taskId: moved.taskId, lastNotifiedEventAt: 123 },
    });
    store.upsertTaskWithDeliveryState({ task: { ...removed, runId: "outside" } });
    expect(getTaskById(moved.taskId)?.runId).toBe("new-run");
    expect(taskDeliveryStates.get(moved.taskId)?.lastNotifiedEventAt).toBe(123);
    expect(tasks.has(removed.taskId)).toBe(false);
    expect(tasks.get(related.taskId)).toEqual(related);
  } finally {
    await settle();
  }
});
