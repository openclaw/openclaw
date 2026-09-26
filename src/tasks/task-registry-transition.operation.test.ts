import { describe, expect, it } from "vitest";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
import {
  runTaskRecordTransitionOperation,
  type TaskRecordTransitionInput,
  type TaskRecordTransitionOperations,
  type TaskRecordTransitionReceipt,
} from "./task-registry-transition.operation.js";
import type {
  TaskPersistenceReceipt,
  TaskRecord,
  TaskRunStateTransitionParams,
} from "./task-registry.types.js";

const running: TaskRecord = {
  taskId: "task-a",
  runtime: "subagent",
  requesterSessionKey: "agent:main:main",
  ownerKey: "agent:main:main",
  scopeKind: "session",
  childSessionKey: "agent:child:main",
  runId: "run-a",
  task: "Synthetic transition",
  status: "running",
  deliveryStatus: "pending",
  notifyPolicy: "done_only",
  createdAt: 100,
  startedAt: 100,
  lastEventAt: 150,
};

const finalization: TaskRecordTransitionInput = {
  kind: "state",
  taskId: running.taskId,
  now: 300,
  params: {
    runId: "run-a",
    status: "succeeded",
    endedAt: 200,
    terminalSummary: "  Finished   work ",
    suppressDelivery: true,
  },
};

function createStore(task: TaskRecord = running) {
  let stored = structuredClone(task);
  const committed: TaskRecordTransitionReceipt[] = [];
  let writes = 0;
  const operations: TaskRecordTransitionOperations = {
    readCurrent: () => stored,
    hasAuthoritativeBacking: () => true,
    write: (operation) => operation(),
    upsertTask(next) {
      stored = structuredClone(next);
      writes += 1;
      return true;
    },
    deferCommit: (publish) => publish(),
    onCommitted: (receipt) => committed.push(receipt),
  };
  return { operations, committed, read: () => stored, writes: () => writes };
}

describe("task transition settlement", () => {
  it.each(["ownerKey", "requesterSessionKey", "childSessionKey"] as const)(
    "redacts Incognito %s progress, notification summaries, and delivery errors without changing cancellation reconciliation",
    (identityKey) => {
      const privateSessionKey = "agent:main:dashboard:incognito-synthetic-transition";
      const store = createStore({
        ...running,
        task: "Incognito task",
        [identityKey]:
          identityKey === "childSessionKey" ? running.childSessionKey : privateSessionKey,
      });
      const content = "Synthetic private transition content";
      const transition = (params: TaskRunStateTransitionParams) =>
        runTaskRecordTransitionOperation(
          { kind: "state", taskId: running.taskId, now: 300, params },
          store.operations,
        );
      transition({
        runId: "run-a",
        ...(identityKey === "childSessionKey" ? { childSessionKey: privateSessionKey } : {}),
        progressSummary: content,
        eventSummary: content,
      });
      expect.soft(store.read().progressSummary).toBeUndefined();
      expect.soft(store.committed[0]?.nextEvent).toBeUndefined();
      runTaskRecordTransitionOperation(
        {
          kind: "delivery",
          taskId: running.taskId,
          now: 300,
          params: { runId: "run-a", deliveryStatus: "failed", error: content },
        },
        store.operations,
      );
      expect.soft(store.read().error).toBe("Incognito task error.");
      transition({
        runId: "run-a",
        status: "cancelled",
        endedAt: 300,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      expect(store.read().error).toBe(SUBAGENT_KILL_TASK_ERROR);
      transition({ runId: "run-a", status: "succeeded", endedAt: 400, terminalSummary: content });
      expect(store.read().status).toBe("succeeded");
      expect.soft(store.read().terminalSummary).toBeUndefined();
      expect.soft(store.committed.at(-1)?.nextEvent?.summary).toBeUndefined();
      expect.soft(JSON.stringify(store.committed)).not.toContain(content);
    },
  );

  it.each([
    { taskId: "successor" },
    { runtime: "acp" as const },
    { ownerKey: "agent:other:main" },
    { scopeKind: "system" as const },
    { runId: "different-run" },
    { childSessionKey: "agent:other:child" },
    { createdAt: 101 },
    { taskKind: "different-kind" },
  ])("refuses a changed persisted identity before any authority callback: %j", (changed) => {
    const store = createStore({ ...running, ...changed });
    const expectedTask: TaskPersistenceReceipt = {
      taskId: running.taskId,
      runtime: running.runtime,
      ownerKey: running.ownerKey,
      scopeKind: running.scopeKind,
      runId: "run-a",
      childSessionKey: running.childSessionKey,
      createdAt: running.createdAt,
    };
    let admitted = false;
    const result = runTaskRecordTransitionOperation(
      { ...finalization, expectedTask },
      {
        ...store.operations,
        assertCurrent: () => {
          admitted = true;
        },
      },
    );
    expect(result).toBeNull();
    expect(store.writes()).toBe(0);
    expect(store.committed).toHaveLength(0);
    expect(admitted).toBe(false);
  });

  it("still requires live authority when the persisted receipt matches", () => {
    const store = createStore();
    const expectedTask: TaskPersistenceReceipt = {
      taskId: running.taskId,
      runtime: running.runtime,
      ownerKey: running.ownerKey,
      scopeKind: running.scopeKind,
      runId: "run-a",
      childSessionKey: running.childSessionKey,
      createdAt: running.createdAt,
    };
    expect(() =>
      runTaskRecordTransitionOperation(
        { ...finalization, expectedTask },
        {
          ...store.operations,
          assertCurrent: () => {
            throw new Error("Task owner retired");
          },
        },
      ),
    ).toThrow("Task owner retired");
    expect(store.writes()).toBe(0);
    expect(store.committed).toHaveLength(0);
  });

  it("keeps no-op repair receipts without repeating a terminal write or delivery", () => {
    const store = createStore();
    runTaskRecordTransitionOperation(finalization, store.operations);
    runTaskRecordTransitionOperation(finalization, store.operations);

    expect(store.writes()).toBe(1);
    expect(store.read()).toMatchObject({
      status: "succeeded",
      endedAt: 200,
      lastEventAt: 200,
      terminalSummary: "Finished work",
      deliveryStatus: "not_applicable",
      cleanupAfter: 200 + 7 * 24 * 60 * 60_000,
    });
    expect(store.committed).toHaveLength(2);
    expect(store.committed[0]).toMatchObject({
      persisted: true,
      becomesTerminal: true,
      deliver: false,
    });
    expect(store.committed[1]).toMatchObject({
      persisted: false,
      becomesTerminal: false,
      deliver: false,
    });
  });

  it("retains earlier row settlement when the next selected row loses live authority", () => {
    const first = createStore();
    const second = createStore({ ...running, taskId: "task-b" });
    runTaskRecordTransitionOperation(finalization, first.operations);
    const authorityFailure = new Error("Task owner retired");
    expect(() =>
      runTaskRecordTransitionOperation(
        { ...finalization, taskId: "task-b" },
        {
          ...second.operations,
          assertCurrent: () => {
            throw authorityFailure;
          },
        },
      ),
    ).toThrow(authorityFailure);

    expect(first.read().status).toBe("succeeded");
    expect(first.committed).toHaveLength(1);
    expect(second.read().status).toBe("running");
    expect(second.writes()).toBe(0);
    expect(second.committed).toHaveLength(0);
  });

  it("records a confirmed row before a later transaction cleanup error escapes", () => {
    const store = createStore();
    const cleanupFailure = new Error("Writer cleanup failed after commit");
    expect(() =>
      runTaskRecordTransitionOperation(finalization, {
        ...store.operations,
        write(operation) {
          operation();
          throw cleanupFailure;
        },
      }),
    ).toThrow(cleanupFailure);

    expect(store.read().status).toBe("succeeded");
    expect(store.writes()).toBe(1);
    expect(store.committed).toHaveLength(1);
    expect(store.committed[0]?.task).toEqual(store.read());
  });

  it("preserves the last canonical outcome when a delayed running event arrives", () => {
    const store = createStore();
    runTaskRecordTransitionOperation(finalization, store.operations);
    const before = store.read();
    const result = runTaskRecordTransitionOperation(
      {
        kind: "state",
        taskId: running.taskId,
        now: 400,
        params: { runId: "run-a", status: "running", startedAt: 350 },
      },
      store.operations,
    );

    expect(result).toBeNull();
    expect(store.read()).toEqual(before);
    expect(store.writes()).toBe(1);
    expect(store.committed).toHaveLength(1);
  });
});
