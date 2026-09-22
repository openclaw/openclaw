import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskRegistryMutationScope } from "./task-registry.store.types.js";
import type { TaskRecord } from "./task-registry.types.js";

vi.mock("../state/openclaw-state-db.js", () => {
  throw new Error("A connection-bound kernel imported the global database owner");
});
vi.mock("../state/openclaw-state-db-readonly.js", () => {
  throw new Error("A connection-bound kernel imported global read admission");
});
vi.mock("../plugins/loader-runtime-load.js", () => {
  throw new Error("A connection-bound kernel imported plugin runtime ownership");
});

it("preserves ordered scoped tasks and their exact delivery rows", async () => {
  const [tasks, { OPENCLAW_STATE_SCHEMA_SQL }, { runSqliteImmediateTransactionSync }] =
    await Promise.all([
      import("./task-registry.store.kernel.js"),
      import("../state/openclaw-state-schema.js"),
      import("../infra/sqlite-transaction.js"),
    ]);
  const db = new DatabaseSync(":memory:");
  const record = (taskId: string, patch: Partial<TaskRecord> = {}): TaskRecord => ({
    taskId,
    runtime: "cli",
    requesterSessionKey: "agent:main:fixture",
    ownerKey: "agent:main:fixture",
    scopeKind: "session",
    task: "Scoped task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "silent",
    createdAt: 100,
    ...patch,
  });
  const direct = record("direct", { createdAt: 50 });
  const runFirst = record("run\0first", {
    runId: "shared-run",
    childSessionKey: "shared-child",
  });
  const runSecond = record("run-second", { runId: "shared-run", createdAt: 200 });
  const literalEscape = record("run\\u0000first", { runId: "shared-run" });
  const child = record("child", { childSessionKey: "shared-child" });
  const unrelated = record("unrelated", {
    requesterSessionKey: "requester-only",
  });
  const broad = Array.from({ length: 64 }, (_, index) =>
    record(`broad-${String(index).padStart(3, "0")}`, { runId: "broad-run" }),
  );
  const cases: Array<{ scope: TaskRegistryMutationScope; expected: TaskRecord[] }> = [
    { scope: { taskId: direct.taskId }, expected: [direct] },
    { scope: { taskId: "absent" }, expected: [] },
    {
      scope: { taskId: direct.taskId, runId: " ", childSessionKey: "\t\n" },
      expected: [direct],
    },
    { scope: { taskId: "absent", runId: " ", childSessionKey: " " }, expected: [] },
    {
      scope: { taskId: direct.taskId, runId: " shared-run ", childSessionKey: " shared-child " },
      expected: [direct, child, runFirst, literalEscape, runSecond],
    },
    { scope: { taskId: "absent", runId: "broad-run" }, expected: broad },
  ];
  const prepare = vi.spyOn(db, "prepare");
  try {
    db.exec(OPENCLAW_STATE_SCHEMA_SQL);
    runSqliteImmediateTransactionSync(db, () => {
      for (const task of [
        unrelated,
        runSecond,
        literalEscape,
        runFirst,
        child,
        direct,
        ...broad.toReversed(),
      ]) {
        tasks.upsertTaskWithDeliveryStateInDatabase(
          { db },
          {
            task,
            ...(task === child
              ? {}
              : {
                  deliveryState: { taskId: task.taskId, lastNotifiedEventAt: task.createdAt + 1 },
                }),
          },
        );
      }
    });
    expect(tasks.readTaskRecord(db, runFirst.taskId)).toEqual(runFirst);
    for (const { scope, expected } of cases) {
      prepare.mockClear();
      const snapshot = tasks.readTaskRegistryMutationSnapshotInDatabase(db, scope);
      expect([...snapshot.tasks.values()]).toEqual(expected);
      expect([...snapshot.deliveryStates.values()]).toEqual(
        expected
          .filter((task) => task !== child)
          .map((task) => ({ taskId: task.taskId, lastNotifiedEventAt: task.createdAt + 1 }))
          .toSorted((left, right) =>
            left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
          ),
      );
      const taskQueries = prepare.mock.calls
        .map(([query]) => query)
        .filter((query) => query.includes('from "task_runs"'));
      expect(taskQueries.length).toBeGreaterThan(0);
      for (const query of taskQueries) {
        const plan = db
          .prepare(`EXPLAIN QUERY PLAN ${query}`)
          .all(
            JSON.stringify([scope.taskId]),
            ...[scope.runId?.trim(), scope.childSessionKey?.trim()]
              .filter((value): value is string => Boolean(value))
              .map((value) => JSON.stringify([value])),
          )
          .map((row) => row.detail)
          .join("\n");
        expect(plan).toContain("SEARCH task_runs USING INDEX");
        expect(plan).not.toContain("SCAN task_runs");
        if (scope.runId?.trim()) {
          expect(plan).toContain("idx_task_runs_run_id");
        }
        if (scope.childSessionKey?.trim()) {
          expect(plan).toContain("idx_task_runs_child_session_key");
        }
      }
    }
    for (const [key, expected] of [
      ["requester-only", true],
      ["agent:main:fixture", true],
      ["shared-child", true],
      ["absent", false],
    ] as const) {
      prepare.mockClear();
      expect(tasks.hasTaskSessionOwnerInDatabase(db, key)).toBe(expected);
      const ownershipQueries = prepare.mock.calls
        .map(([query]) => query)
        .filter((query) => query.includes('from "task_runs"'));
      expect(ownershipQueries).toHaveLength(1);
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${ownershipQueries[0]}`)
        .all(key, key, key, 1)
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain("SEARCH task_runs USING INDEX");
      expect(plan).not.toContain("SCAN task_runs");
    }
  } finally {
    prepare.mockRestore();
    db.close();
  }
});

it("reads a large scope union in one query with exact delivery membership and binary ordering", async () => {
  const [tasks, { OPENCLAW_STATE_SCHEMA_SQL }] = await Promise.all([
    import("./task-registry.store.kernel.js"),
    import("../state/openclaw-state-schema.js"),
  ]);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(OPENCLAW_STATE_SCHEMA_SQL);
    for (const [index, taskId] of ["𐀀", "\ue000", "no-delivery"].entries()) {
      tasks.upsertTaskWithDeliveryStateInDatabase(
        { db },
        {
          task: {
            taskId,
            runtime: "cli",
            requesterSessionKey: "owner",
            ownerKey: "owner",
            scopeKind: "session",
            task: "Synthetic scoped task",
            runId: "shared-run",
            childSessionKey: "shared-child",
            status: "running",
            deliveryStatus: "pending",
            notifyPolicy: "silent",
            createdAt: index + 1,
          },
          ...(taskId === "no-delivery" ? {} : { deliveryState: { taskId } }),
        },
      );
    }
    const scopes: TaskRegistryMutationScope[] = Array.from({ length: 40_000 }, (_, index) => ({
      taskId: `absent-${index}`,
      runId: `absent-run-${index}`,
      childSessionKey: `absent-child-${index}`,
    }));
    scopes.push({ taskId: "𐀀", runId: "shared-run" });
    scopes.push({ taskId: "𐀀", childSessionKey: "shared-child" });
    const prepare = vi.spyOn(db, "prepare");
    const exec = vi.spyOn(db, "exec");
    const snapshot = tasks.readTaskRegistryMutationSnapshotInDatabase(db, scopes);
    expect([...snapshot.tasks.keys()]).toEqual(["𐀀", "\ue000", "no-delivery"]);
    expect([...snapshot.deliveryStates.values()]).toEqual([{ taskId: "\ue000" }, { taskId: "𐀀" }]);
    expect(prepare.mock.calls.filter(([sql]) => sql.startsWith("select "))).toHaveLength(1);
    expect(exec.mock.calls).toEqual([["BEGIN"], ["COMMIT"]]);
    expect(tasks.readTaskRegistryMutationSnapshotInDatabase(db, [])).toEqual({
      tasks: new Map(),
      deliveryStates: new Map(),
    });
    prepare.mockRestore();
    exec.mockRestore();
  } finally {
    db.close();
  }
});

it("isolates supplied connections and rolls back compound task, flow, delivery, and binding writes", async () => {
  // Cold evaluation proves the dependency boundary even if setup previously loaded a store.
  vi.resetModules();
  const [
    tasks,
    flows,
    { OPENCLAW_STATE_SCHEMA_SQL },
    { runSqliteImmediateTransactionSync },
    { enableNodeSqliteKyselyStatementCache },
  ] = await Promise.all([
    import("./task-registry.store.kernel.js"),
    import("./task-flow-registry.store.kernel.js"),
    import("../state/openclaw-state-schema.js"),
    import("../infra/sqlite-transaction.js"),
    import("../infra/kysely-sync.js"),
  ]);
  const first = new DatabaseSync(":memory:");
  const second = new DatabaseSync(":memory:");
  const task: TaskRecord = {
    taskId: "task-a",
    runtime: "cron",
    taskKind: "fixture",
    sourceId: "source-a",
    requesterSessionKey: "agent:main:fixture",
    ownerKey: "agent:main:fixture",
    scopeKind: "session",
    task: "Original task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "silent",
    createdAt: 100,
    detail: { result: null, values: ["text", 1] },
  };
  const flow: TaskFlowRecord = {
    flowId: "flow-a",
    syncMode: "managed",
    ownerKey: task.ownerKey,
    controllerId: "fixture/controller",
    revision: 0,
    status: "running",
    notifyPolicy: "silent",
    goal: "Original flow",
    stateJson: { step: 0 },
    waitJson: null,
    createdAt: 100,
    updatedAt: 100,
  };
  const origin = { channel: "test-channel", to: "synthetic-target" };
  const snapshot = () => ({
    tasks: tasks.readTaskRegistrySnapshot({ db: first, path: ":memory:" }),
    flows: flows.readTaskFlowRegistrySnapshot(first),
    bindings: first
      .prepare("SELECT * FROM execution_owner_lifecycle_bindings ORDER BY owner_kind, owner_id")
      .all(),
  });
  try {
    for (const db of [first, second]) {
      enableNodeSqliteKyselyStatementCache(db);
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      runSqliteImmediateTransactionSync(db, () => {
        tasks.upsertTaskWithDeliveryStateInDatabase(
          { db },
          {
            task: { ...task, task: db === first ? task.task : "Other connection" },
            deliveryState: { taskId: task.taskId, requesterOrigin: origin },
          },
        );
        flows.upsertTaskFlowRowInDatabase(db, flows.bindTaskFlowRecord(flow));
      });
    }
    expect(tasks.readTaskRecord(first, task.taskId)).toEqual(task);
    expect(tasks.readTaskRecord(second, task.taskId)?.task).toBe("Other connection");
    expect(flows.readTaskFlowRecord(first, flow.flowId)).toEqual(flow);
    expect(tasks.readTaskRegistrySnapshotIfReady({ db: first, path: ":memory:" }).state).toBe(
      "ready",
    );
    expect(tasks.listTaskRecordsByOwnerKeyInDatabase(first, task.ownerKey)).toEqual([task]);
    expect(tasks.listTaskRecordsByRuntimeSourceIdInDatabase(first, "cron", "source-a")).toEqual([
      task,
    ]);

    const otherTask: TaskRecord = {
      ...task,
      taskId: "task-b",
      runtime: "subagent",
      sourceId: "source-b",
      ownerKey: "owner-b",
    };
    const otherFlow: TaskFlowRecord = { ...flow, flowId: "flow-b", ownerKey: "owner-b" };
    runSqliteImmediateTransactionSync(first, () => {
      tasks.upsertTaskRunRowInDatabase({ db: first }, tasks.bindTaskRecord(otherTask));
      flows.upsertTaskFlowRowInDatabase(first, flows.bindTaskFlowRecord(otherFlow));
    });
    expect(tasks.readTaskRecord(first, otherTask.taskId)).toEqual(otherTask);
    expect(tasks.readTaskRecord(first, "missing")).toBeUndefined();
    expect(tasks.readTaskRecord(first, task.taskId)).toEqual(task);
    expect(flows.readTaskFlowRecord(first, otherFlow.flowId)).toEqual(otherFlow);
    expect(flows.readTaskFlowRecord(first, "missing")).toBeUndefined();
    expect(flows.readTaskFlowRecord(first, flow.flowId)).toEqual(flow);
    expect(tasks.listTaskRecordsByRuntimeSourceIdInDatabase(first, "cron")).toEqual([task]);
    expect(tasks.listTaskRecordsByRuntimeSourceIdInDatabase(first, "subagent")).toEqual([
      otherTask,
    ]);
    expect(tasks.listTaskRecordsByRuntimeSourceIdInDatabase(first, "cron", "")).toEqual([]);
    expect(tasks.listTaskRecordsByRuntimeSourceIdInDatabase(first, "subagent", "source-a")).toEqual(
      [],
    );
    expect(tasks.listTaskRecordsByRuntimeSourceIdInDatabase(first, "cron", "source-b")).toEqual([]);
    expect(tasks.listTaskRecordsByRuntimeSourceIdInDatabase(first, "subagent", "source-b")).toEqual(
      [otherTask],
    );
    expect(tasks.listTaskRecordsByOwnerKeyInDatabase(first, "owner-b")).toEqual([otherTask]);
    expect(tasks.listTaskRecordsByOwnerKeyInDatabase(first, "missing")).toEqual([]);
    expect(tasks.listTaskRecordsByOwnerKeyInDatabase(first, task.ownerKey)).toEqual([task]);
    runSqliteImmediateTransactionSync(first, () => {
      tasks.deleteTaskRowsWithDeliveryState(first, otherTask.taskId);
      flows.deleteTaskFlowRowInDatabase(first, otherFlow.flowId);
    });

    const before = snapshot();
    const replacement = { ...task, task: "Updated task", detail: null };
    const nextFlow = { ...flow, revision: 1, stateJson: { step: 1 } };
    const binding = { contextId: "context-fixture", executionId: "execution-fixture" };
    const commit = () =>
      runSqliteImmediateTransactionSync(first, () => {
        tasks.upsertTaskWithDeliveryStateInDatabase(
          { db: first },
          { task: replacement, deliveryState: { taskId: task.taskId, lastNotifiedEventAt: 200 } },
        );
        expect(tasks.bindTaskRunExecutionInDatabase(first, task.taskId, binding)).toBe("bound");
        expect(flows.bindTaskFlowExecutionInDatabase(first, flow.flowId, binding)).toBe("bound");
        flows.upsertTaskFlowRowInDatabase(first, flows.bindTaskFlowRecord(nextFlow));
      });
    first.exec(`
      CREATE TEMP TRIGGER reject_flow BEFORE INSERT ON flow_runs
      BEGIN SELECT RAISE(ABORT, 'synthetic compound failure'); END;
    `);
    expect(commit).toThrow("synthetic compound failure");
    expect(snapshot()).toEqual(before);
    first.exec("DROP TRIGGER reject_flow");
    commit();
    expect(tasks.readTaskRecord(first, task.taskId)).toEqual(replacement);
    expect(flows.readTaskFlowRecord(first, flow.flowId)).toEqual(nextFlow);
    expect(snapshot().bindings).toHaveLength(2);
    expect(tasks.readTaskRecord(second, task.taskId)?.task).toBe("Other connection");

    runSqliteImmediateTransactionSync(first, () => {
      tasks.deleteTaskRowsWithDeliveryState(first, task.taskId);
      flows.deleteTaskFlowRowInDatabase(first, flow.flowId);
    });
    const deleted = snapshot();
    expect(deleted.tasks.tasks.size).toBe(0);
    expect(deleted.tasks.deliveryStates.size).toBe(0);
    expect(deleted.flows.flows.size).toBe(0);
    expect(deleted.bindings).toEqual([]);
    expect(tasks.readTaskRecord(second, task.taskId)).toBeDefined();
  } finally {
    first.close();
    second.close();
  }
});
