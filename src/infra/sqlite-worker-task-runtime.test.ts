import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { resetRuntimeTaskTestState } from "../plugins/runtime/runtime-task-test-harness.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  acquireOpenClawStateDatabaseFileExclusion,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db-cache.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { buildFlowRecord } from "../tasks/task-flow-registry.records.js";
import { upsertTaskFlowRegistryRecordToSqlite } from "../tasks/task-flow-registry.store.sqlite.js";
import { configureTaskFlowRegistryRuntime } from "../tasks/task-flow-registry.store.test-support.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  deleteTaskFlowRecordById,
  reloadTaskFlowRegistryFromStoreAsync,
} from "../tasks/task-flow-runtime-internal.js";
import { getTaskById } from "../tasks/task-registry.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { SqliteSchemaVersionError } from "./sqlite-user-version.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
  SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import * as workerStore from "./sqlite-worker-store.js";
import type { SqliteWorkerTransferFrame } from "./sqlite-worker-transfer.js";

const ownerKey = "agent:main:async-reader";
let state: OpenClawTestState;

function task(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    runtime: "acp",
    requesterSessionKey: ownerKey,
    ownerKey,
    scopeKind: "session",
    task: "Synthetic task",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 100,
    parentFlowId: "flow-a",
    runId: "run-a",
    requesterAgentId: "main",
    ...overrides,
  };
}

function flow(flowId: string, overrides: Partial<TaskFlowRecord> = {}): TaskFlowRecord {
  return {
    flowId,
    syncMode: "managed",
    controllerId: "tests/async-reads",
    ownerKey,
    revision: 1,
    status: "running",
    notifyPolicy: "silent",
    goal: "Synthetic flow",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-task-async-", applyEnv: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await resetRuntimeTaskTestState();
  await state.cleanup();
});

describe("registered tasks.async runtime", () => {
  it.each(["valid", "invalid"] as const)(
    "prepares a cold bare-owner SDK read with %s config without main-thread SQLite",
    async (shape) => {
      await state.writeConfig(
        shape === "valid"
          ? { gateway: { mode: "local" }, agents: { entries: { ops: {} } } }
          : { gateway: { port: "invalid" } },
      );
      vi.spyOn(process, "cwd").mockReturnValue(state.workspaceDir);
      upsertTaskWithDeliveryStateToSqlite({
        task: task("bare", {
          ownerKey: "global",
          requesterSessionKey: "global",
          requesterAgentId: undefined,
          runId: "bare-run",
          parentFlowId: undefined,
        }),
      });
      closeOpenClawStateDatabase();
      expect(getRuntimeConfigSnapshot()).toBeNull();
      const native = requireNodeSqlite();
      const counters = [
        vi.spyOn(native.DatabaseSync.prototype, "prepare"),
        vi.spyOn(native.DatabaseSync.prototype, "exec"),
        ...(["iterate", "get", "all", "run"] as const).map((method) =>
          vi.spyOn(native.StatementSync.prototype, method),
        ),
      ];
      await withPluginCache(createPluginCache(), async () => {
        const runs = createPluginRuntime().tasks.async.runs.bindSession({
          sessionKey: "global",
          agentId: "ops",
        });
        const detail = await runs.get("bare");
        const listed = await runs.list();
        const latest = await runs.findLatest();
        const resolved = await runs.resolve("bare-run");
        if (shape === "valid") {
          expect([detail?.id, latest?.id, resolved?.id]).toEqual(["bare", "bare", "bare"]);
          expect(listed.map((entry) => entry.id)).toEqual(["bare"]);
          expect(getRuntimeConfigSnapshot()?.agents?.entries).toHaveProperty("ops");
        } else {
          expect([detail, latest, resolved]).toEqual([undefined, undefined, undefined]);
          expect(listed).toEqual([]);
          expect(getRuntimeConfigSnapshot()).toBeNull();
        }
      });
      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    },
  );

  it.each([4, 8])("keeps reconciliation linear for %s unrelated managed writes", async (count) => {
    const managed = createPluginRuntime().tasks.async.managedFlows.bindSession({
      sessionKey: ownerKey,
    });
    await managed.list();
    const commands = new Map<string, number>();
    const original = workerStore.runSqliteWorkerStoreOperation;
    vi.spyOn(workerStore, "runSqliteWorkerStoreOperation").mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        store: SqliteWorkerStore<Operations>,
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[2],
        assertCurrent?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[3],
      ) =>
        original(
          store,
          (scope) =>
            operation({
              execute: (command, options) => {
                const kind = String(command.type);
                commands.set(kind, (commands.get(kind) ?? 0) + 1);
                return scope.execute(command, options);
              },
            }),
          stateContext,
          assertCurrent,
        ),
    );
    const created = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        managed.createManaged({
          controllerId: "tests/concurrent",
          goal: `Concurrent flow ${index}`,
        }),
      ),
    );
    expect(new Set(created.map((record) => record.flowId)).size).toBe(count);
    expect(created.every((record) => record.ownerKey === ownerKey && record.revision === 0)).toBe(
      true,
    );
    expect(new Set((await managed.list()).map((record) => record.flowId))).toEqual(
      new Set(created.map((record) => record.flowId)),
    );
    console.log("Concurrent managed-flow worker commands", {
      count,
      commands: Object.fromEntries(commands),
    });
    expect(commands.get("flows.createManaged")).toBe(count);
    expect(commands.get("flows.current")).toBeLessThanOrEqual(count * 2);
  });

  it.each(["read", "update", "delete", "refresh"] as const)(
    "does not overwrite a synchronous %s with a delayed worker observation",
    async (intervening) => {
      const runtime = createPluginRuntime();
      const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
      const legacy = runtime.tasks.managedFlows.bindSession({ sessionKey: ownerKey });
      const created = await managed.createManaged({
        controllerId: "tests/coexistence",
        goal: "Original flow",
      });
      expect(legacy.get(created.flowId)?.revision).toBe(0);
      const tieIds = [
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
        "00000000-0000-4000-8000-000000000001",
      ] as const;
      if (intervening === "update") {
        const randomId = vi
          .spyOn(crypto, "randomUUID")
          .mockReturnValueOnce(tieIds[0])
          .mockReturnValueOnce(tieIds[1]);
        try {
          legacy.createManaged({
            controllerId: "tests/ties",
            goal: "First inserted",
            createdAt: 100,
          });
          legacy.createManaged({
            controllerId: "tests/ties",
            goal: "Second inserted",
            createdAt: 100,
          });
        } finally {
          randomId.mockRestore();
        }
        expect(
          legacy
            .list()
            .filter((record) => record.controllerId === "tests/ties")
            .map((record) => record.flowId),
        ).toEqual(tieIds);
      }
      const held = createDeferredCore();
      const release = createDeferredCore();
      const original = workerStore.runSqliteWorkerStoreOperation;
      let paused = false;
      vi.spyOn(workerStore, "runSqliteWorkerStoreOperation").mockImplementation(
        <Operations extends SqliteWorkerOperations, T>(
          store: SqliteWorkerStore<Operations>,
          operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
          stateContext?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[2],
          assertCurrent?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[3],
        ) =>
          original(
            store,
            (scope) =>
              operation({
                execute: async (command, options) => {
                  const result = await scope.execute(command, options);
                  const target =
                    intervening === "refresh" ? "flows.current" : "flows.updateManaged";
                  if (!paused && command.type === target) {
                    paused = true;
                    held.resolve();
                    await release.promise;
                  }
                  return result;
                },
              }),
            stateContext,
            assertCurrent,
          ),
      );
      const onEvent = vi.fn();
      configureTaskFlowRegistryRuntime({ observers: { onEvent } });
      const pending = managed.finish({ flowId: created.flowId, expectedRevision: 0, endedAt: 100 });
      try {
        await held.promise;
        if (intervening !== "refresh") {
          expect(legacy.get(created.flowId)).toMatchObject({ revision: 1, status: "succeeded" });
        }
        if (intervening === "update") {
          expect(
            legacy
              .list()
              .filter((record) => record.controllerId === "tests/ties")
              .map((record) => record.flowId),
          ).toEqual(tieIds);
          expect(
            legacy.resume({ flowId: created.flowId, expectedRevision: 1, status: "running" }),
          ).toMatchObject({ applied: true, flow: { revision: 2, status: "running" } });
        } else if (intervening === "delete") {
          expect(deleteTaskFlowRecordById(created.flowId)).toBe(true);
        } else if (intervening === "refresh") {
          const { db } = openOpenClawStateDatabase();
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .updateTable("flow_runs")
              .set({ revision: 2, goal: "Refreshed canonical flow" })
              .where("flow_id", "=", created.flowId),
          );
          await reloadTaskFlowRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
        }
        onEvent.mockClear();
        release.resolve();
        expect(await pending).toMatchObject({
          applied: true,
          flow: { revision: 1, status: "succeeded" },
        });
        if (intervening === "delete") {
          expect(legacy.get(created.flowId)).toBeUndefined();
        } else {
          expect(legacy.get(created.flowId)).toMatchObject({
            revision: intervening === "read" ? 1 : 2,
            ...(intervening === "read" || intervening === "update"
              ? { status: intervening === "read" ? "succeeded" : "running" }
              : { goal: "Refreshed canonical flow" }),
          });
        }
        if (intervening === "read") {
          expect(onEvent).toHaveBeenCalledExactlyOnceWith({
            kind: "upserted",
            flow: expect.objectContaining({ revision: 1, status: "succeeded" }),
            previous: expect.objectContaining({ revision: 0, status: "queued" }),
          });
        } else {
          expect(onEvent).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it("keeps the application loop running while the worker waits for SQLite write admission", async () => {
    const managed = createPluginRuntime().tasks.async.managedFlows.bindSession({
      sessionKey: ownerKey,
    });
    const created = await managed.createManaged({
      controllerId: "tests/contention",
      goal: "Contended flow",
    });
    const { DatabaseSync } = requireNodeSqlite();
    const blocker = new DatabaseSync(openOpenClawStateDatabase().path);
    let pending: ReturnType<typeof managed.finish> | undefined;
    try {
      blocker.exec("BEGIN IMMEDIATE");
      let settled = false;
      const started = performance.now();
      pending = managed.finish({ flowId: created.flowId, expectedRevision: 0 }).finally(() => {
        settled = true;
      });
      let ticks = 0;
      for (let count = 0; count < 3; count += 1) {
        await delay(20);
        ticks += 1;
        expect(settled).toBe(false);
      }
      const heldMs = performance.now() - started;
      blocker.exec("COMMIT");
      expect(await pending).toMatchObject({
        applied: true,
        flow: { revision: 1, status: "succeeded" },
      });
      console.log("Managed-flow worker SQLite contention timing", {
        heldMs,
        elapsedMs: performance.now() - started,
        mainLoopTicks: ticks,
      });
    } finally {
      if (blocker.isTransaction) {
        blocker.exec("ROLLBACK");
      }
      blocker.close();
      await pending;
    }
  });

  it("persists managed creation and revision mutations without warmed main-thread SQLite", async () => {
    const runtime = createPluginRuntime();
    const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    const legacy = runtime.tasks.managedFlows.bindSession({ sessionKey: ownerKey });
    await managed.list();
    const native = requireNodeSqlite();
    for (const method of ["prepare", "exec"] as const) {
      vi.spyOn(native.DatabaseSync.prototype, method).mockImplementation(() => {
        throw new Error("Unexpected warmed main-thread SQLite");
      });
    }
    for (const method of ["iterate", "get", "all", "run"] as const) {
      vi.spyOn(native.StatementSync.prototype, method).mockImplementation(() => {
        throw new Error("Unexpected warmed main-thread SQLite");
      });
    }
    const created = await managed.createManaged({
      controllerId: "tests/worker-write",
      goal: "Worker-owned flow",
      createdAt: 100,
    });
    expect(created).toMatchObject({ ownerKey, status: "queued", revision: 0, createdAt: 100 });
    const stateJson = { unicode: "雪" };
    const waiting = managed.setWaiting({
      flowId: created.flowId,
      expectedRevision: 0,
      stateJson,
      waitJson: { prompt: "Approval" },
      updatedAt: 110,
    });
    stateJson.unicode = "Changed after admission";
    expect(await waiting).toMatchObject({
      applied: true,
      flow: { revision: 1, status: "waiting", stateJson: { unicode: "雪" } },
    });
    expect(
      await managed.resume({
        flowId: created.flowId,
        expectedRevision: 1,
        status: "running",
        updatedAt: 120,
      }),
    ).toMatchObject({ applied: true, flow: { revision: 2, status: "running" } });
    expect(
      await managed.requestCancel({
        flowId: created.flowId,
        expectedRevision: 2,
        cancelRequestedAt: 130,
      }),
    ).toMatchObject({ applied: true, flow: { revision: 3, cancelRequestedAt: 130 } });
    expect(
      await managed.fail({ flowId: created.flowId, expectedRevision: 3, endedAt: 140 }),
    ).toMatchObject({ applied: true, flow: { revision: 4, status: "failed", endedAt: 140 } });
    expect(
      await managed.finish({ flowId: created.flowId, expectedRevision: 4, endedAt: 150 }),
    ).toMatchObject({ applied: true, flow: { revision: 5, status: "succeeded", endedAt: 150 } });
    expect(await managed.finish({ flowId: created.flowId, expectedRevision: 4 })).toMatchObject({
      applied: false,
      code: "revision_conflict",
      current: { revision: 5, endedAt: 150 },
    });
    vi.restoreAllMocks();
    expect(legacy.get(created.flowId)).toMatchObject({
      revision: 5,
      status: "succeeded",
      endedAt: 150,
      stateJson: { unicode: "雪" },
    });
    await closeOpenClawStateDatabaseAsync();
    expect(await managed.get(created.flowId)).toMatchObject({
      revision: 5,
      status: "succeeded",
      endedAt: 150,
    });
  });

  it("keeps canonical scope and previous state after a rejected worker update", async () => {
    const runtime = createPluginRuntime();
    const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    const created = await managed.createManaged({
      controllerId: "tests/rejection",
      goal: "Retained flow",
      createdAt: 100,
    });
    const foreign = runtime.tasks.async.managedFlows.bindSession({
      sessionKey: "agent:other:other",
    });
    expect(await foreign.finish({ flowId: created.flowId, expectedRevision: 0 })).toEqual({
      applied: false,
      code: "not_found",
    });
    const db = openOpenClawStateDatabase().db;
    db.exec(
      "CREATE TRIGGER reject_flow_update BEFORE UPDATE ON flow_runs BEGIN SELECT RAISE(ABORT, 'synthetic flow write failure'); END",
    );
    const onEvent = vi.fn();
    configureTaskFlowRegistryRuntime({ observers: { onEvent } });
    try {
      expect(await managed.finish({ flowId: created.flowId, expectedRevision: 0 })).toMatchObject({
        applied: false,
        code: "persist_failed",
        current: { revision: 0, status: "queued" },
      });
      expect(onEvent).not.toHaveBeenCalled();
      expect(await managed.get(created.flowId)).toMatchObject({ revision: 0, status: "queued" });
    } finally {
      db.exec("DROP TRIGGER reject_flow_update");
    }
    expect(
      await managed.finish({ flowId: created.flowId, expectedRevision: 0, endedAt: 200 }),
    ).toMatchObject({ applied: true, flow: { revision: 1, status: "succeeded", endedAt: 200 } });
  });

  it.each(["shutdown", "update"] as const)(
    "retains a committed result when its observer initiates a synchronous %s",
    async (action) => {
      const runtime = createPluginRuntime();
      const managed = runtime.tasks.async.managedFlows.bindSession({
        sessionKey: ownerKey,
      });
      const legacy = runtime.tasks.managedFlows.bindSession({ sessionKey: ownerKey });
      await managed.list();
      let closing: Promise<void> | undefined;
      const observedRevisions: number[] = [];
      configureTaskFlowRegistryRuntime({
        observers: {
          onEvent: (event) => {
            if (event.kind === "upserted") {
              observedRevisions.push(event.flow.revision);
              if (action === "shutdown") {
                closing = drainGlobalSingletonLifecycleState("restart");
              } else if (event.flow.revision === 0) {
                legacy.resume({
                  flowId: event.flow.flowId,
                  expectedRevision: 0,
                  status: "running",
                });
              }
            }
          },
        },
      });
      const created = await managed.createManaged({
        controllerId: "tests/close",
        goal: "Committed before close",
      });
      expect(created.revision).toBe(0);
      expect(observedRevisions).toEqual(action === "shutdown" ? [0] : [0, 1]);
      if (action === "shutdown") {
        expect(closing).toBeDefined();
      } else {
        expect(legacy.get(created.flowId)).toMatchObject({ revision: 1, status: "running" });
      }
      await closing;
      configureTaskFlowRegistryRuntime({ observers: null });
      expect(await managed.get(created.flowId)).toMatchObject({
        flowId: created.flowId,
        goal: "Committed before close",
        revision: action === "shutdown" ? 0 : 1,
      });
    },
  );

  it("preserves canonical schema error identity when a large managed command reaches staged EOF", async () => {
    const managed = createPluginRuntime().tasks.async.managedFlows.bindSession({
      sessionKey: ownerKey,
    });
    expect(await managed.list()).toEqual([]);
    const context = captureOpenClawStateWorkerContext();
    const database = openOpenClawStateDatabase();
    const version = database.db.prepare("PRAGMA user_version").get()?.user_version;
    if (typeof version !== "number") {
      throw new Error("Expected the synthetic database schema version");
    }
    const input = {
      controllerId: "tests/staged-schema",
      goal: "Reject before the managed write",
      stateJson: { text: "s".repeat(36 * 1024 * 1024) },
      waitJson: { text: "w".repeat(36 * 1024 * 1024) },
    };
    const stagedFlow = buildFlowRecord({ ...input, ownerKey, syncMode: "managed" });
    const frames: SqliteWorkerRequest["type"][] = [];
    let receivedEof = false;
    // oxlint-disable-next-line typescript/unbound-method -- The saved method is called with the intercepted worker below.
    const originalPost = Worker.prototype.postMessage;
    const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      frames.push(request.type);
      if (request.type === "execute-frame") {
        const frame = deserialize(request.input) as SqliteWorkerTransferFrame;
        receivedEof ||= frame.done;
      }
      return originalPost.call(this, request, transferList);
    });
    try {
      database.db.exec("PRAGMA user_version = 999999");
      await expect(
        runOpenClawStateWorkerOperation(context, (scope) =>
          scope.execute({ type: "flows.createManaged", input: { flow: stagedFlow } }),
        ),
      ).rejects.toBeInstanceOf(SqliteSchemaVersionError);
      expect(frames.filter((kind) => kind === "execute-start")).toHaveLength(1);
      expect(receivedEof).toBe(true);
      expect(
        database.db
          .prepare("SELECT flow_id FROM flow_runs WHERE flow_id = ?")
          .get(stagedFlow.flowId),
      ).toBeUndefined();
      await expect(managed.createManaged(input)).rejects.toThrow("TaskFlow persistence failed.");
      expect(database.db.prepare("SELECT COUNT(*) AS count FROM flow_runs").get()?.count).toBe(0);
    } finally {
      post.mockRestore();
      database.db.exec(`PRAGMA user_version = ${version}`);
    }
  });

  it.each(["tryCreateManaged", "createManaged"] as const)(
    "preserves a committed %s outcome when reply loss is wrapped by retirement",
    async (method) => {
      const managed = createPluginRuntime().tasks.async.managedFlows.bindSession({
        sessionKey: ownerKey,
      });
      expect(await managed.list()).toEqual([]);
      let creatorThreadId: number | undefined;
      let requestId: number | undefined;
      let stopped: Promise<number> | undefined;
      let attempts = 0;
      let droppedReply = false;
      // oxlint-disable-next-line typescript/unbound-method -- Both saved methods retain the actual intercepted worker receiver.
      const originalPost = Worker.prototype.postMessage;
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the actual worker receiver below.
      const originalEmit = Worker.prototype.emit;
      const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker,
        request: SqliteWorkerRequest,
        transferList,
      ) {
        if (request.type === "execute") {
          const command: unknown = deserialize(request.input);
          if (
            command &&
            typeof command === "object" &&
            "type" in command &&
            command.type === "flows.createManaged"
          ) {
            creatorThreadId = this.threadId;
            requestId = request.id;
            attempts += 1;
          }
        }
        return originalPost.call(this, request, transferList);
      });
      const emit = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
        this: Worker,
        event: string | symbol,
        ...args: unknown[]
      ) {
        const reply = args[0];
        if (
          !droppedReply &&
          this.threadId === creatorThreadId &&
          event === "message" &&
          reply &&
          typeof reply === "object" &&
          "id" in reply &&
          reply.id === requestId &&
          "ok" in reply &&
          reply.ok === true
        ) {
          // The successful reply proves commit; withhold it from the broker and join native exit.
          droppedReply = true;
          stopped = this.terminate();
          return false;
        }
        return Reflect.apply(originalEmit, this, [event, ...args]);
      });
      let outcomes: PromiseSettledResult<unknown>[];
      try {
        outcomes = await Promise.allSettled([
          managed[method]({ controllerId: "tests/uncertain-create", goal: "Committed once" }),
        ]);
      } finally {
        post.mockRestore();
        emit.mockRestore();
        await stopped;
      }
      expect(droppedReply).toBe(true);
      expect(attempts).toBe(1);
      await closeOpenClawStateDatabaseAsync();
      const records = await managed.list();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ goal: "Committed once", revision: 0 });
      expect(outcomes).toEqual([{ status: "rejected", reason: expect.any(Error) }]);
      if (outcomes[0]?.status === "rejected") {
        expect(collectNestedErrorCandidates(outcomes[0].reason).map(extractErrorCode)).toContain(
          "outcome-unknown",
        );
      }
    },
  );

  it("preserves large managed state and wait payloads across worker creation and reopen", async () => {
    const runtime = createPluginRuntime();
    const legacy = runtime.tasks.managedFlows.bindSession({ sessionKey: ownerKey });
    const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    const input = {
      controllerId: "tests/large-managed-input",
      goal: "Preserve complete managed payloads",
      stateJson: { text: "s".repeat(36 * 1024 * 1024), unicode: "雪" },
      waitJson: { text: "w".repeat(36 * 1024 * 1024), unicode: "🌊" },
    };
    const digest = (value: unknown) =>
      crypto
        .createHash("sha256")
        .update(JSON.stringify(value) ?? "")
        .digest("hex");
    const expected = { state: digest(input.stateJson), wait: digest(input.waitJson) };
    const assertPayload = (record: TaskFlowRecord) => {
      expect(record).toMatchObject({ ownerKey, revision: 0, goal: input.goal });
      expect(digest(record.stateJson)).toBe(expected.state);
      expect(digest(record.waitJson)).toBe(expected.wait);
    };

    {
      const accepted = legacy.createManaged(input);
      assertPayload(accepted);
      expect(legacy.list()).toHaveLength(1);
      expect(deleteTaskFlowRecordById(accepted.flowId)).toBe(true);
    }

    let flowId: string;
    {
      const created = await managed.createManaged(input);
      assertPayload(created);
      flowId = created.flowId;
    }
    expect((await managed.list()).map((record) => record.flowId)).toEqual([flowId]);
    await closeOpenClawStateDatabaseAsync();
    await reloadTaskFlowRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
    {
      const reopened = await managed.get(flowId);
      if (!reopened) {
        throw new Error("Expected the complete managed flow after reopening its database");
      }
      assertPayload(reopened);
    }

    {
      const waitingState = { ...input.stateJson, phase: "waiting" };
      const waitingPayload = { ...input.waitJson, approval: "synthetic-approval" };
      const waiting = await managed.setWaiting({
        flowId,
        expectedRevision: 0,
        stateJson: waitingState,
        waitJson: waitingPayload,
      });
      if (!waiting.applied) {
        throw new Error(`Large waiting transition failed: ${waiting.code}`);
      }
      expect(waiting.flow).toMatchObject({ revision: 1, status: "waiting" });
      expect(digest(waiting.flow.stateJson)).toBe(digest(waitingState));
      expect(digest(waiting.flow.waitJson)).toBe(digest(waitingPayload));
    }

    const resumedState = { ...input.stateJson, phase: "resumed" };
    {
      const resumed = await managed.resume({
        flowId,
        expectedRevision: 1,
        status: "running",
        stateJson: resumedState,
      });
      if (!resumed.applied) {
        throw new Error(`Large resume transition failed: ${resumed.code}`);
      }
      expect(resumed.flow).toMatchObject({ revision: 2, status: "running" });
      expect(digest(resumed.flow.stateJson)).toBe(digest(resumedState));
      expect(resumed.flow.waitJson).toBeNull();
    }
    await closeOpenClawStateDatabaseAsync();
    await reloadTaskFlowRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
    {
      const restored = await managed.get(flowId);
      expect(restored).toMatchObject({ revision: 2, status: "running" });
      expect(digest(restored?.stateJson)).toBe(digest(resumedState));
      expect(restored?.waitJson).toBeNull();
    }
    expect((await managed.list()).map((record) => record.flowId)).toEqual([flowId]);
  });

  it("refuses a sealed read before cold native admission", async () => {
    const database = openOpenClawStateDatabase();
    const runs = createPluginRuntime().tasks.async.runs.bindSession({ sessionKey: ownerKey });
    const exclusion = await acquireOpenClawStateDatabaseFileExclusion(database.path);
    const prepare = vi.spyOn(requireNodeSqlite().DatabaseSync.prototype, "prepare");
    try {
      await expect(runs.list()).rejects.toThrow(/admission is closed/);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      exclusion.release();
    }
  });

  it("keeps the selected state across the asynchronous module boundary", async () => {
    const other = await createOpenClawTestState({
      prefix: "openclaw-task-other-",
      applyEnv: false,
    });
    try {
      upsertTaskWithDeliveryStateToSqlite({ task: task("selected", { task: "Selected state" }) });
      const runs = createPluginRuntime().tasks.async.runs.bindSession({ sessionKey: ownerKey });
      const pending = runs.get("selected");
      vi.stubEnv("OPENCLAW_STATE_DIR", other.stateDir);
      expect((await pending)?.title).toBe("Selected state");
      expect(existsSync(other.statePath("state", "openclaw.sqlite"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await other.cleanup();
    }
  });

  it("opens a fresh worker after the global restart lifecycle drains the broker", async () => {
    upsertTaskWithDeliveryStateToSqlite({ task: task("retained") });
    const runs = createPluginRuntime().tasks.async.runs.bindSession({ sessionKey: ownerKey });
    expect((await runs.get("retained"))?.id).toBe("retained");
    await drainGlobalSingletonLifecycleState("restart");
    expect((await runs.get("retained"))?.id).toBe("retained");
  });

  it("repairs an old additive task shape before querying retained rows", async () => {
    upsertTaskWithDeliveryStateToSqlite({ task: task("retained") });
    openOpenClawStateDatabase().db.exec("ALTER TABLE task_runs DROP COLUMN tool_use_count");
    closeOpenClawStateDatabase();
    const runs = createPluginRuntime().tasks.async.runs.bindSession({ sessionKey: ownerKey });
    expect((await runs.get("retained"))?.id).toBe("retained");
  });

  it("rejects a cold schema failure instead of returning an empty list", async () => {
    openOpenClawStateDatabase().db.exec("PRAGMA user_version = 9999");
    closeOpenClawStateDatabase();
    const runs = createPluginRuntime().tasks.async.runs.bindSession({ sessionKey: ownerKey });
    await expect(runs.list()).rejects.toThrow(/newer schema version 9999/);
  });

  it("preserves all 14 read payloads while warmed native queries execute off the main thread", async () => {
    upsertTaskFlowRegistryRecordToSqlite(flow("flow-a"));
    upsertTaskWithDeliveryStateToSqlite({
      task: task("task-a", { progressSummary: "Persisted progress" }),
    });
    const runtime = createPluginRuntime();
    const runs = runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey });
    const flows = runtime.tasks.async.flows.fromToolContext({ sessionKey: ownerKey });
    const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    const legacyRuns = runtime.tasks.runs.bindSession({ sessionKey: ownerKey });
    const legacyFlows = runtime.tasks.flows.bindSession({ sessionKey: ownerKey });
    const legacyManaged = runtime.tasks.managedFlows.bindSession({ sessionKey: ownerKey });
    const expectedRun = legacyRuns.get("task-a");
    const expectedFlow = legacyFlows.get("flow-a");
    const expectedManaged = legacyManaged.get("flow-a");
    const summary = legacyFlows.getTaskSummary("flow-a");
    await runs.get("task-a");
    const native = requireNodeSqlite();
    // A Promise wrapper around synchronous SQL fails here. The independent
    // worker uses its own native prototype and reads the real fixture database.
    vi.spyOn(native.DatabaseSync.prototype, "prepare").mockImplementation(() => {
      throw new Error("Unexpected warmed main-thread SQLite prepare");
    });
    vi.spyOn(native.DatabaseSync.prototype, "exec").mockImplementation(() => {
      throw new Error("Unexpected warmed main-thread SQLite exec");
    });
    for (const method of ["iterate", "get", "all", "run"] as const) {
      vi.spyOn(native.StatementSync.prototype, method).mockImplementation(() => {
        throw new Error("Unexpected warmed main-thread SQLite statement execution");
      });
    }
    const results = await Promise.all([
      runs.get("task-a"),
      runs.list(),
      runs.findLatest(),
      runs.resolve("run-a"),
      flows.get("flow-a"),
      flows.list(),
      flows.findLatest(),
      flows.resolve(ownerKey),
      flows.getTaskSummary("flow-a"),
      managed.get("flow-a"),
      managed.list(),
      managed.findLatest(),
      managed.resolve(ownerKey),
      managed.getTaskSummary("flow-a"),
    ]);
    expect(results).toEqual([
      expectedRun,
      [expectedRun],
      expectedRun,
      expectedRun,
      expectedFlow,
      [legacyFlows.list()[0]],
      expectedFlow,
      expectedFlow,
      summary,
      expectedManaged,
      [expectedManaged],
      expectedManaged,
      expectedManaged,
      summary,
    ]);
    expect(getTaskById("task-a")?.progressSummary).toBe("Persisted progress");
  });

  it("keeps scope and lookup precedence with deterministic equal-timestamp ordering", async () => {
    for (const record of [
      task("task-a"),
      task("task-z"),
      task("foreign", {
        ownerKey: "agent:other:reader",
        requesterAgentId: "other",
        createdAt: 50,
      }),
    ]) {
      upsertTaskWithDeliveryStateToSqlite({ task: record });
    }
    upsertTaskFlowRegistryRecordToSqlite(flow("flow-z"));
    upsertTaskFlowRegistryRecordToSqlite(flow("flow-a", { status: "succeeded", endedAt: 100 }));
    const runtime = createPluginRuntime();
    const runs = runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey });
    const flows = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    expect((await runs.list()).map((item) => item.id)).toEqual(["task-z", "task-a"]);
    expect((await runs.findLatest())?.id).toBe("task-z");
    expect((await runs.resolve("task-a"))?.id).toBe("task-a");
    // Run selection is global before owner access: a foreign preferred run
    // cannot be replaced by a less-preferred visible match.
    expect(await runs.resolve("run-a")).toBeUndefined();
    expect(await runs.get("foreign")).toBeUndefined();
    expect((await flows.list()).map((item) => item.flowId)).toEqual(["flow-a", "flow-z"]);
    expect((await flows.findLatest())?.flowId).toBe("flow-a");
    expect((await flows.resolve(ownerKey))?.flowId).toBe("flow-z");
    expect(await flows.resolve("agent:other:reader")).toBeUndefined();
  });

  it("preserves managed JSON while DTO lists and summaries expose only their public fields", async () => {
    const stateJson = { payload: "s".repeat(4096) };
    const waitJson = { payload: "w".repeat(4096) };
    upsertTaskFlowRegistryRecordToSqlite(flow("flow-a", { stateJson, waitJson }));
    for (const record of [
      task("running"),
      task("succeeded", { runtime: "subagent", status: "succeeded" }),
      task("failed", { runtime: "cli", status: "failed" }),
    ]) {
      upsertTaskWithDeliveryStateToSqlite({ task: record });
    }
    const runtime = createPluginRuntime();
    const views = runtime.tasks.async.flows.bindSession({ sessionKey: ownerKey });
    const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    expect((await managed.list())[0]).toMatchObject({ stateJson, waitJson });
    expect(await views.list()).toEqual(
      runtime.tasks.flows.bindSession({ sessionKey: ownerKey }).list(),
    );
    const expected = runtime.tasks.managedFlows
      .bindSession({ sessionKey: ownerKey })
      .getTaskSummary("flow-a");
    expect(expected).toMatchObject({
      total: 3,
      active: 1,
      terminal: 2,
      failures: 1,
      byStatus: { running: 1, succeeded: 1, failed: 1 },
      byRuntime: { acp: 1, cli: 1, subagent: 1, cron: 0 },
    });
    expect(await views.getTaskSummary("flow-a")).toEqual(expected);
    expect(await managed.getTaskSummary("flow-a")).toEqual(expected);
    expect(
      await runtime.tasks.async.flows
        .bindSession({ sessionKey: "agent:other:reader" })
        .getTaskSummary("flow-a"),
    ).toBeUndefined();
  });

  it("preserves owner-visible fallback between ID, run, and related-session lookup tiers", async () => {
    for (const record of [
      task("owned-by-run", { runId: "collision" }),
      task("collision", {
        ownerKey: "agent:other:reader",
        requesterAgentId: "other",
        runId: "foreign-run",
      }),
      task("foreign-by-run", {
        ownerKey: "agent:other:reader",
        requesterAgentId: "other",
        runId: ownerKey,
      }),
      task("owned-latest", { runId: "latest-run", createdAt: 400 }),
    ]) {
      upsertTaskWithDeliveryStateToSqlite({ task: record });
    }
    const runtime = createPluginRuntime();
    const syncRuns = runtime.tasks.runs.bindSession({ sessionKey: ownerKey });
    const asyncRuns = runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey });
    expect(syncRuns.resolve("collision")?.id).toBe("owned-by-run");
    expect((await asyncRuns.resolve("collision"))?.id).toBe("owned-by-run");
    expect(syncRuns.resolve(ownerKey)?.id).toBe("owned-latest");
    expect((await asyncRuns.resolve(ownerKey))?.id).toBe("owned-latest");
  });

  it("keeps cold reads off-thread and observes later persisted changes without replacing the sync cache", async () => {
    const native = requireNodeSqlite();
    const prepare = vi.spyOn(native.DatabaseSync.prototype, "prepare");
    const runtime = createPluginRuntime();
    const runs = runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey });
    expect(await runs.list()).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    upsertTaskWithDeliveryStateToSqlite({ task: task("fresh") });
    expect(getTaskById("fresh")).toBeUndefined();
    prepare.mockClear();
    expect((await runs.get("fresh"))?.id).toBe("fresh");
    expect(prepare).not.toHaveBeenCalled();
    expect(getTaskById("fresh")).toBeUndefined();
    expect(openOpenClawStateDatabase().db.isOpen).toBe(true);
  });
});
