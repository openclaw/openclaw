import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createSqliteAuditRecordKernel,
  prepareSqliteAuditRecord,
} from "../infra/sqlite-audit-record.kernel.js";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { buildFlowRecord } from "../tasks/task-flow-registry.records.js";
import { upsertTaskFlowRegistryRecordToSqlite } from "../tasks/task-flow-registry.store.sqlite.js";
import { readTaskRegistrySnapshot } from "../tasks/task-registry.store.kernel.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import { TASK_RUNTIMES, type TaskStatus } from "../tasks/task-registry.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  createSqliteWorkerBackend,
  openExistingSqliteWorkerBackend,
} from "./openclaw-state.worker.js";

let state: OpenClawTestState;
const backends = new Set<ReturnType<typeof createSqliteWorkerBackend>>();
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-flow-summary-", applyEnv: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends) {
    await backend.close();
  }
  backends.clear();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

async function fixture(statuses: readonly TaskStatus[] = ["running"]) {
  const ownerKey = "agent:main:summary";
  const flow = buildFlowRecord({
    controllerId: "tests/summary",
    ownerKey,
    goal: "Synthetic flow",
    createdAt: 100,
  });
  upsertTaskFlowRegistryRecordToSqlite(flow);
  let index = 0;
  for (const runtime of TASK_RUNTIMES) {
    for (const status of statuses) {
      const count =
        runtime === "subagent" && status === "queued"
          ? 3
          : runtime === "cli" && status === "failed"
            ? 2
            : 1;
      for (let copy = 0; copy < count; copy++) {
        upsertTaskWithDeliveryStateToSqlite({
          task: {
            taskId: `task-${index++}`,
            runtime,
            status,
            parentFlowId: flow.flowId,
            ownerKey,
            requesterSessionKey: ownerKey,
            scopeKind: "session",
            task: "Large task ".repeat(1024),
            progressSummary: "Progress ".repeat(1024),
            deliveryStatus: "not_applicable",
            notifyPolicy: "silent",
            createdAt: 100,
          },
        });
      }
    }
  }
  const context = captureOpenClawStateWorkerContext();
  const backend = runWithSqliteWorkerStateContext(context, () =>
    createSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
  );
  backends.add(backend);
  await backend[SQLITE_WORKER_PREPARE_COMMAND]?.("flows.summary");
  const summary = (requestedOwner = ownerKey, flowId = flow.flowId) =>
    runWithSqliteWorkerStateContext(context, () =>
      backend.execute({ type: "flows.summary", input: { ownerKey: requestedOwner, flowId } }),
    );
  const detail = () =>
    runWithSqliteWorkerStateContext(context, () =>
      backend.execute({
        type: "flows.detail",
        input: { ownerKey, lookup: "id", token: flow.flowId },
      }),
    );
  return { summary, detail, database: openOpenClawStateDatabase() };
}

it("counts every status and runtime without mixing another flow, including empty and missing flows", async () => {
  const { summary, database } = await fixture([
    "queued",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "lost",
  ]);
  const expected = {
    total: 31,
    active: 10,
    terminal: 21,
    failures: 13,
    byStatus: {
      queued: 6,
      running: 4,
      succeeded: 4,
      failed: 5,
      timed_out: 4,
      cancelled: 4,
      lost: 4,
    },
    byRuntime: { subagent: 9, acp: 7, cron: 7, cli: 8 },
  };
  expect(summary()).toEqual(expected);
  expect(summary("agent:other:summary")).toBeUndefined();
  expect(summary(undefined, "missing")).toBeUndefined();
  const unrelated = buildFlowRecord({
    controllerId: "tests/summary",
    ownerKey: "agent:main:summary",
    goal: "Empty flow",
    createdAt: 100,
  });
  upsertTaskFlowRegistryRecordToSqlite(unrelated);
  expect(summary(undefined, unrelated.flowId)).toEqual({
    total: 0,
    active: 0,
    terminal: 0,
    failures: 0,
    byStatus: {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
      lost: 0,
    },
    byRuntime: { subagent: 0, acp: 0, cron: 0, cli: 0 },
  });
  database.db
    .prepare("UPDATE task_runs SET parent_flow_id = ? WHERE task_id = 'task-0'")
    .run(unrelated.flowId);
  expect(summary()).toMatchObject({
    total: 30,
    active: 9,
    byStatus: { queued: 5 },
    byRuntime: { subagent: 8 },
  });
});

it("retains the shared native handle until its last actor closes and preserves rows on reopen", async () => {
  const context = captureOpenClawStateWorkerContext();
  const first = runWithSqliteWorkerStateContext(context, () =>
    createSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
  );
  const second = runWithSqliteWorkerStateContext(context, () =>
    openExistingSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
  );
  backends.add(first).add(second);
  await first[SQLITE_WORKER_PREPARE_COMMAND]?.("flows.createManaged");
  await second[SQLITE_WORKER_PREPARE_COMMAND]?.("flows.current");
  const database = openOpenClawStateDatabase();
  const flow = buildFlowRecord({
    controllerId: "tests/native-borrow",
    ownerKey: "agent:main:borrow",
    goal: "Keep the surviving actor usable",
    createdAt: 100,
  });
  runWithSqliteWorkerStateContext(context, () =>
    first.execute({ type: "flows.createManaged", input: { flow } }),
  );
  expect(
    runWithSqliteWorkerStateContext(context, () =>
      second.execute({ type: "flows.current", input: { flowId: flow.flowId } }),
    ),
  ).toMatchObject({ flowId: flow.flowId, revision: 0 });

  await first.close();
  expect(database.db.isOpen).toBe(true);
  expect(
    runWithSqliteWorkerStateContext(context, () =>
      second.execute({
        type: "flows.updateManaged",
        input: {
          flowId: flow.flowId,
          ownerKey: flow.ownerKey,
          expectedRevision: 0,
          patch: { status: "succeeded", updatedAt: 200, endedAt: 200 },
        },
      }),
    ),
  ).toMatchObject({ applied: true, flow: { status: "succeeded", revision: 1 } });
  await second.close();
  expect(database.db.isOpen).toBe(false);

  const reopenedContext = captureOpenClawStateWorkerContext();
  const reopened = runWithSqliteWorkerStateContext(reopenedContext, () =>
    createSqliteWorkerBackend(undefined, { databasePath: reopenedContext.admission.databasePath }),
  );
  backends.add(reopened);
  await reopened[SQLITE_WORKER_PREPARE_COMMAND]?.("flows.current");
  expect(
    runWithSqliteWorkerStateContext(reopenedContext, () =>
      reopened.execute({ type: "flows.current", input: { flowId: flow.flowId } }),
    ),
  ).toMatchObject({ flowId: flow.flowId, status: "succeeded", revision: 1 });
});

it.each(["kv", "task"] as const)(
  "retains a promoted KV actor's native handle when %s closes first",
  async (firstToClose) => {
    const context = captureOpenClawStateWorkerContext();
    const databasePath = context.admission.databasePath;
    const key = { pluginId: "borrow-fixture", namespace: "shared", key: "answer" };
    const kv = runWithSqliteWorkerStateContext(context, () =>
      openExistingSqliteWorkerBackend(undefined, { databasePath }),
    );
    backends.add(kv);
    await kv[SQLITE_WORKER_PREPARE_COMMAND]?.("pluginState.lookup");
    expect(
      runWithSqliteWorkerStateContext(context, () =>
        kv.execute({ type: "pluginState.lookup", input: key }),
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(existsSync(databasePath)).toBe(false);
    const stages: string[] = [];
    const admission = createSqliteWorkerOperationAdmission((request, grant) => {
      stages.push(request.stage);
      context.admission.assertCurrent();
      grant();
    });
    const nativePost = admission.port.postMessage.bind(admission.port);
    // Both native backends share this thread; service the real grant before its synchronous wait.
    const dispatch = vi
      .spyOn(admission.port, "postMessage")
      .mockImplementation((message, transferList) => {
        nativePost(message, transferList);
        admission.service();
      });
    try {
      expect(
        runWithSqliteWorkerStateContext(context, () =>
          withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
            kv.execute({
              type: "pluginState.register",
              input: {
                ...key,
                valueJson: JSON.stringify({ value: 42 }),
                maxEntries: 4,
                overflowPolicy: "reject-new",
              },
            }),
          ),
        ),
      ).toEqual({ ok: true, value: undefined });
      expect(stages).toEqual(["transaction", "commit"]);
    } finally {
      dispatch.mockRestore();
      admission.finish();
    }
    const task = runWithSqliteWorkerStateContext(context, () =>
      createSqliteWorkerBackend(undefined, { databasePath }),
    );
    backends.add(task);
    await task[SQLITE_WORKER_PREPARE_COMMAND]?.("flows.createManaged");
    const database = openOpenClawStateDatabase();
    const flow = buildFlowRecord({
      controllerId: "tests/kv-native-borrow",
      ownerKey: "agent:main:kv-borrow",
      goal: "Keep both state readers available",
      createdAt: 100,
    });
    expect(
      runWithSqliteWorkerStateContext(context, () =>
        task.execute({ type: "flows.createManaged", input: { flow } }),
      ),
    ).toMatchObject({ flowId: flow.flowId, revision: 0 });

    await (firstToClose === "kv" ? kv : task).close();
    expect(database.db.isOpen).toBe(true);
    if (firstToClose === "kv") {
      expect(
        runWithSqliteWorkerStateContext(context, () =>
          task.execute({ type: "flows.current", input: { flowId: flow.flowId } }),
        ),
      ).toMatchObject({ flowId: flow.flowId, revision: 0 });
    } else {
      expect(
        runWithSqliteWorkerStateContext(context, () =>
          kv.execute({ type: "pluginState.lookup", input: key }),
        ),
      ).toEqual({ ok: true, value: { value: 42 } });
    }
    await (firstToClose === "kv" ? task : kv).close();
    expect(database.db.isOpen).toBe(false);

    const reopenedContext = captureOpenClawStateWorkerContext();
    const reopened = runWithSqliteWorkerStateContext(reopenedContext, () =>
      createSqliteWorkerBackend(undefined, { databasePath }),
    );
    backends.add(reopened);
    await reopened[SQLITE_WORKER_PREPARE_COMMAND]?.("pluginState.lookup");
    expect(
      runWithSqliteWorkerStateContext(reopenedContext, () =>
        reopened.execute({ type: "pluginState.lookup", input: key }),
      ),
    ).toEqual({ ok: true, value: { value: 42 } });
    expect(
      runWithSqliteWorkerStateContext(reopenedContext, () =>
        reopened.execute({ type: "flows.current", input: { flowId: flow.flowId } }),
      ),
    ).toMatchObject({ flowId: flow.flowId, revision: 0 });
  },
);

it.each(["config.health.patch", "diagnostic.register"] as const)(
  "retains %s writes from existing-only actors until last close and durably reopens",
  async (operation) => {
    const context = captureOpenClawStateWorkerContext();
    const first = runWithSqliteWorkerStateContext(context, () =>
      openExistingSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
    );
    const second = runWithSqliteWorkerStateContext(context, () =>
      openExistingSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
    );
    backends.add(first).add(second);
    await first[SQLITE_WORKER_PREPARE_COMMAND]?.("config.health.read");
    await second[SQLITE_WORKER_PREPARE_COMMAND]?.(operation);
    expect(
      runWithSqliteWorkerStateContext(context, () =>
        first.execute({ type: "config.health.read", input: { artifactPreserving: false } }),
      ),
    ).toEqual({ state: {}, basis: {} });
    expect(existsSync(context.admission.databasePath)).toBe(false);

    const scope = "tests/health-native-borrow";
    const write = (backend: typeof first, key: string) =>
      runWithSqliteWorkerStateContext(context, () =>
        operation === "config.health.patch"
          ? backend.execute({
              type: operation,
              input: {
                configPath: `/${key}.json`,
                patch: { last_observed_suspicious_signature: key },
                expected: null,
                updatedAtMs: 100,
              },
            })
          : backend.execute({
              type: operation,
              input: {
                scope,
                maxEntries: 10,
                record: prepareSqliteAuditRecord(scope, {
                  key,
                  value: { marker: key },
                  createdAt: 100,
                }),
              },
            }),
      );
    const expectedResult = operation === "config.health.patch" ? true : undefined;
    expect(write(first, "first")).toBe(expectedResult);
    expect(write(second, "second")).toBe(expectedResult);
    const database = openOpenClawStateDatabase();
    await first.close();
    expect(database.db.isOpen).toBe(true);
    expect(write(second, "third")).toBe(expectedResult);
    await second.close();
    expect(database.db.isOpen).toBe(false);

    const reopenedContext = captureOpenClawStateWorkerContext();
    const reopened = runWithSqliteWorkerStateContext(reopenedContext, () =>
      createSqliteWorkerBackend(undefined, {
        databasePath: reopenedContext.admission.databasePath,
      }),
    );
    backends.add(reopened);
    await reopened[SQLITE_WORKER_PREPARE_COMMAND]?.("config.health.read");
    const reopenedDatabase = openOpenClawStateDatabase();
    if (operation === "config.health.patch") {
      expect(
        runWithSqliteWorkerStateContext(reopenedContext, () =>
          reopened.execute({ type: "config.health.read", input: { artifactPreserving: false } }),
        ),
      ).toMatchObject({
        state: {
          entries: {
            "/first.json": { lastObservedSuspiciousSignature: "first" },
            "/second.json": { lastObservedSuspiciousSignature: "second" },
            "/third.json": { lastObservedSuspiciousSignature: "third" },
          },
        },
      });
    } else {
      expect(
        createSqliteAuditRecordKernel(reopenedDatabase.db, { scope, maxEntries: 10 }).entries(),
      ).toEqual([
        { key: "first", value: { marker: "first" }, createdAt: 100 },
        { key: "second", value: { marker: "second" }, createdAt: 100 },
        { key: "third", value: { marker: "third" }, createdAt: 100 },
      ]);
    }
    await reopened.close();
    expect(reopenedDatabase.db.isOpen).toBe(false);
  },
);

it.each(["runtime", "status"] as const)(
  "rejects invalid count input %s only after checking flow ownership",
  async (field) => {
    const { summary, database } = await fixture();
    database.db.exec(`UPDATE task_runs SET ${field} = 'invalid' WHERE task_id = 'task-0'`);
    expect(summary("agent:other:summary")).toBeUndefined();
    expect(summary(undefined, "missing")).toBeUndefined();
    expect(() => summary()).toThrow(`Invalid persisted task ${field}: "invalid"`);
  },
);

it.each([
  ["scope_kind", "scope kind"],
  ["delivery_status", "delivery status"],
  ["notify_policy", "notify policy"],
  ["terminal_outcome", "terminal outcome"],
] as const)("leaves unused %s validation with full record readers", async (field, label) => {
  const { summary, detail, database } = await fixture();
  database.db.exec(`UPDATE task_runs SET ${field} = 'invalid' WHERE task_id = 'task-0'`);
  expect(summary()).toMatchObject({ total: 4, active: 4, terminal: 0, failures: 0 });
  expect(() => detail()).toThrow(`Invalid persisted task ${label}: "invalid"`);
  expect(() => readTaskRegistrySnapshot(database)).toThrow(
    `Invalid persisted task ${label}: "invalid"`,
  );
});
