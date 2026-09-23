import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { normalizeSubagentRunState } from "../agents/subagents/registry/subagent-delivery-state.js";
import { registerRequiredQueuedSubagent } from "../agents/subagents/registry/subagent-registry-queued-registration.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "../agents/subagents/registry/subagent-registry-state.js";
import { bindSubagentRunRecord } from "../agents/subagents/registry/subagent-registry.store.codec.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { OpenClawStateOwnershipError } from "../state/openclaw-state-ownership.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  inspectOpenClawStateDatabase,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import { buildFlowRecord } from "../tasks/task-flow-registry.records.js";
import {
  bindTaskFlowRecord,
  upsertTaskFlowRowInDatabase,
} from "../tasks/task-flow-registry.store.kernel.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.js";
import * as nodeSqlite from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { SqliteSchemaVersionError } from "./sqlite-user-version.js";
import { registerSharedStateWorkerAdmissionTests } from "./sqlite-worker-shared-state-admission.test-support.js";
import { closeUnclaimedSharedStateSqliteWorkers } from "./sqlite-worker-store.js";
import { acquireGatewayLifecycleCoordinator } from "./state-database-coordinator.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function context() {
  return captureOpenClawStateWorkerContext({
    env: { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-cold-") },
  });
}

describe("canonical shared-state worker admission", () => {
  it.each(["open", "execute"] as const)(
    "keeps typed %s errors for a reloaded caller of the existing shared worker",
    async (phase) => {
      const captured = context();
      await executeOpenClawStateWorker(captured, {
        type: "flows.list",
        input: { ownerKey: "agent:main:caller-errors" },
      });
      const database = openOpenClawStateDatabase({
        path: captured.admission.databasePath,
        env: captured.environment,
      });
      database.db.exec("PRAGMA user_version = 999999");
      if (phase === "open") {
        await closeOpenClawStateDatabaseAsync();
      }
      vi.resetModules();
      const [worker, contexts, errors] = await Promise.all([
        import("../state/openclaw-state-worker-store.js"),
        import("../state/openclaw-state-worker-context.js"),
        import("./sqlite-user-version.js"),
      ]);
      const current = contexts.captureOpenClawStateWorkerContext({
        path: captured.admission.databasePath,
        env: captured.environment,
      });
      const flow = buildFlowRecord({
        ownerKey: "agent:main:caller-errors",
        syncMode: "managed",
        controllerId: "tests/caller-errors",
        goal: "Refuse before a write to a newer schema",
      });
      let incoming: unknown;
      let failure: unknown;
      try {
        await worker.runOpenClawStateWorkerOperation(current, async (scope) => {
          try {
            return await scope.execute({ type: "flows.createManaged", input: { flow } });
          } catch (error) {
            incoming = error;
            throw error;
          }
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(errors.SqliteSchemaVersionError);
      if (phase === "execute") {
        expect(incoming).toBe(failure);
      }
    },
  );

  it("hydrates concurrent lower-level open refusals in each caller's module graph", async () => {
    const captured = context();
    const database = openOpenClawStateDatabase({
      path: captured.admission.databasePath,
      env: captured.environment,
    });
    database.db.exec("PRAGMA user_version = 999999");
    await closeOpenClawStateDatabaseAsync();
    const first = await Promise.all([
      import("./sqlite-worker-store.js"),
      import("./sqlite-user-version.js"),
    ]);
    vi.resetModules();
    const second = await Promise.all([
      import("./sqlite-worker-store.js"),
      import("./sqlite-user-version.js"),
    ]);
    const options = {
      moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sharedStateStore),
      databasePath: captured.admission.databasePath,
    };
    const outcomes = await Promise.allSettled([
      first[0].openSharedStateSqliteWorkerStore(options, captured),
      second[0].openSharedStateSqliteWorkerStore(options, captured),
    ]);
    for (const result of outcomes) {
      if (result.status === "fulfilled") {
        await result.value?.close();
      }
    }
    const [left, right] = outcomes;
    if (left.status !== "rejected" || right.status !== "rejected") {
      throw new Error("Expected both callers to observe the schema refusal");
    }
    expect(left.reason).toBeInstanceOf(first[1].SqliteSchemaVersionError);
    expect(right.reason).toBeInstanceOf(second[1].SqliteSchemaVersionError);
    expect(left.reason).not.toBe(right.reason);
  });

  it.each(["create", "repair"] as const)(
    "performs cold %s under its Gateway owner without main-thread SQL",
    async (operation) => {
      const captured = context();
      const databasePath = captured.admission.databasePath;
      if (operation === "repair") {
        const database = openOpenClawStateDatabase({
          path: databasePath,
          env: captured.environment,
        });
        database.db.exec("DROP INDEX idx_flow_runs_owner_key");
        await closeOpenClawStateDatabaseAsync();
      }
      const admission = captureOpenClawStateWorkerContext({
        path: databasePath,
        env: captured.environment,
      });
      const gateway = acquireGatewayLifecycleCoordinator({ databasePath });
      const mainSql = observeMainThreadSql();
      try {
        expect(
          await executeOpenClawStateWorker(admission, {
            type: "flows.list",
            input: { ownerKey: "agent:main:main" },
          }),
        ).toEqual([]);
        mainSql.expectIdle();
        expect(admission.admission.identity.key).toMatch(/^file:/);
      } finally {
        mainSql.restore();
        await closeOpenClawStateDatabaseAsync();
        gateway.release();
      }
      const reopened = openOpenClawStateDatabase({ path: databasePath, env: captured.environment });
      expect(
        reopened.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = ?")
          .get("idx_flow_runs_owner_key"),
      ).toEqual({ name: "idx_flow_runs_owner_key" });
    },
  );

  it.each(["Web Push", "task", "GitHub publication"] as const)(
    "keeps metadata inspection and the first %s operation in the same actor",
    async (operation) => {
      const captured = context();
      const value = { generation: "prepared-metadata", plugins: [] };
      writeConfigMachineState("plugins.installedIndex", value, {
        path: captured.admission.databasePath,
        env: captured.environment,
      });
      await closeOpenClawStateDatabaseAsync();
      const reopened = captureOpenClawStateWorkerContext({
        path: captured.admission.databasePath,
        env: captured.environment,
      });
      const messages = vi.spyOn(Worker.prototype, "postMessage");
      await runOpenClawStateWorkerOperation(
        reopened,
        async (scope) => {
          expect(
            await scope.execute({
              type: "plugins.metadata.read",
              input: { selector: "installed-index", artifactPreservingReadOnly: true },
            }),
          ).toEqual({ value_json: JSON.stringify(value) });
          const metadataWorker = messages.mock.contexts[0];
          expect(metadataWorker).toBeInstanceOf(Worker);
          messages.mockClear();
          if (operation === "task") {
            expect(
              await scope.execute({
                type: "tasks.list",
                input: { ownerKey: "agent:main:main" },
              }),
            ).toEqual([]);
          } else if (operation === "Web Push") {
            expect(
              await scope.execute({
                type: "webPush.listTerminalWebPushApprovalDeliveryIds",
                input: {},
              }),
            ).toEqual({ approvalIds: [], nextAfterApprovalId: null, throughApprovalId: null });
          } else {
            expect(
              await scope.execute({
                type: "githubRepository.personalPending",
                input: {
                  ownerProfileId: "profile-first-use",
                  sessionKey: "agent:main:github-first-use",
                  agentId: "main",
                },
              }),
            ).toBeUndefined();
          }
          expect(messages.mock.contexts.length).toBeGreaterThan(0);
          expect(messages.mock.contexts.every((worker) => worker === metadataWorker)).toBe(true);
          expect(
            await scope.execute({
              type: "plugins.metadata.read",
              input: { selector: "installed-index", artifactPreservingReadOnly: true },
            }),
          ).toEqual({ value_json: JSON.stringify(value) });
        },
        { existingOnly: true },
      );
      await closeOpenClawStateDatabaseAsync();
      messages.mockRestore();
    },
  );

  it("leaves a missing database absent for existing-only inspection", async () => {
    const captured = context();
    const inspect = vi.fn(async () => "inspected");
    expect(
      await runOpenClawStateWorkerOperation(captured, inspect, { existingOnly: true }),
    ).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
    expect(
      await inspectOpenClawStateDatabase(captured, {
        type: "database.generationMatches",
        input: {
          generation: {
            database: {
              birthtimeNs: 0n,
              ctimeNs: 0n,
              dev: 0n,
              ino: 0n,
              mtimeNs: 0n,
              size: 0n,
              sha256: "0".repeat(64),
            },
          },
        },
      }),
    ).toBeUndefined();
    expect(existsSync(captured.admission.databasePath)).toBe(false);
  });

  it("preserves future-schema rejection through a cold worker open", async () => {
    const captured = context();
    const database = openOpenClawStateDatabase({
      path: captured.admission.databasePath,
      env: captured.environment,
    });
    database.db.exec("PRAGMA user_version = 999999;");
    await closeOpenClawStateDatabaseAsync();
    const reopened = captureOpenClawStateWorkerContext({
      path: captured.admission.databasePath,
      env: captured.environment,
    });
    await expect(
      executeOpenClawStateWorker(reopened, {
        type: "flows.list",
        input: { ownerKey: "agent:main:main" },
      }),
    ).rejects.toBeInstanceOf(SqliteSchemaVersionError);
  });

  it("retries failed-open native custody through the owning path drain", async () => {
    const captured = context();
    const databasePath = captured.admission.databasePath;
    const database = openOpenClawStateDatabase({ path: databasePath, env: captured.environment });
    database.db.exec("PRAGMA user_version = 999999;");
    await closeOpenClawStateDatabaseAsync();
    const reopened = captureOpenClawStateWorkerContext({
      path: databasePath,
      env: captured.environment,
    });
    const nativeOpen = nodeSqlite.openNodeSqliteDatabase;
    const opened = new Map<string, DatabaseSync>();
    const openSpy = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((location, ...options) => {
        const db = nativeOpen(location, ...options);
        opened.set(location, db);
        return db;
      });
    const gateway = acquireGatewayLifecycleCoordinator({ databasePath });
    openSpy.mockRestore();
    const native = opened.get(gateway.path);
    if (!native) {
      throw new Error("Expected the owned Gateway coordinator connection");
    }
    const failClose = () => {
      throw new Error("Synthetic coordinator close failed");
    };
    vi.spyOn(native, "close").mockImplementationOnce(failClose).mockImplementationOnce(failClose);
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    messages.mockImplementationOnce(function (this: Worker, message, transferList) {
      messages.mockRestore();
      this.postMessage(message, transferList ?? []);
      gateway.release();
    });
    try {
      await expect(
        executeOpenClawStateWorker(reopened, {
          type: "flows.list",
          input: { ownerKey: "agent:main:main" },
        }),
      ).rejects.toThrow();
      expect(native.isOpen).toBe(true);
      await expect(closeOpenClawStateDatabaseByPathAsync(databasePath)).rejects.toThrow();
      expect(native.isOpen).toBe(true);
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      expect(native.isOpen).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await closeUnclaimedSharedStateSqliteWorkers(databasePath);
      gateway.release();
    }
  });

  it.each(["open", "execute"] as const)(
    "preserves external ownership rejection from worker %s",
    async (phase) => {
      const captured = context();
      if (phase === "execute") {
        await executeOpenClawStateWorker(captured, {
          type: "flows.list",
          input: { ownerKey: "agent:main:main" },
        });
      }
      claimOpenClawStateOwnership("synthetic-manager", {
        path: captured.admission.databasePath,
        env: { ...captured.environment, OPENCLAW_SUPERVISOR_MODE: "external" },
      });
      if (phase === "open") {
        await closeOpenClawStateDatabaseAsync();
      }
      const reopened = captureOpenClawStateWorkerContext({
        path: captured.admission.databasePath,
        env: captured.environment,
      });
      await expect(
        executeOpenClawStateWorker(reopened, {
          type: "flows.list",
          input: { ownerKey: "agent:main:main" },
        }),
      ).rejects.toBeInstanceOf(OpenClawStateOwnershipError);
    },
  );

  it("opens a fresh actor for the first new call after the previous worker exits", async () => {
    const captured = context();
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    await executeOpenClawStateWorker(captured, {
      type: "flows.list",
      input: { ownerKey: "agent:main:main" },
    });
    const worker = messages.mock.contexts[0];
    messages.mockRestore();
    if (!(worker instanceof Worker)) {
      throw new Error("Expected the shared-state worker to receive its open request");
    }
    await worker.terminate();
    await expect(
      executeOpenClawStateWorker(captured, {
        type: "flows.list",
        input: { ownerKey: "agent:main:main" },
      }),
    ).resolves.toEqual([]);
    expect(
      await executeOpenClawStateWorker(captured, {
        type: "flows.list",
        input: { ownerKey: "agent:main:main" },
      }),
    ).toEqual([]);
  });

  it("reads persisted records after closing and reopening the worker", async () => {
    const captured = context();
    const database = openOpenClawStateDatabase({
      path: captured.admission.databasePath,
      env: captured.environment,
    });
    upsertTaskFlowRowInDatabase(
      database.db,
      bindTaskFlowRecord({
        flowId: "flow-persisted",
        ownerKey: "agent:main:main",
        syncMode: "managed",
        controllerId: "test/controller",
        revision: 3,
        status: "waiting",
        notifyPolicy: "done_only",
        goal: "Preserve worker state",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    await closeOpenClawStateDatabaseAsync();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = captureOpenClawStateWorkerContext({
        path: captured.admission.databasePath,
        env: captured.environment,
      });
      expect(
        await executeOpenClawStateWorker(reopened, {
          type: "flows.read",
          input: { ownerKey: "agent:main:main", lookup: "id", token: "flow-persisted" },
        }),
      ).toMatchObject({ flowId: "flow-persisted", revision: 3, goal: "Preserve worker state" });
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

registerSharedStateWorkerAdmissionTests(context);

function createRun(runId: string): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "captured task",
    cleanup: "keep",
    createdAt: 100,
    execution: { status: "queued" },
    completion: { required: false },
    delivery: { status: "not_required" },
  };
}

it("commits captured registry rows without host SQL", async () => {
  await withEnvAsync({ OPENCLAW_STATE_DIR: dirs.make("openclaw-registry-worker-") }, async () => {
    const retained = createRun("retained");
    const removed = createRun("removed");
    saveSubagentRegistryToSqlite(
      new Map([
        [retained.runId, retained],
        [removed.runId, removed],
      ]),
    );
    const queued = createRun("queued");
    const capturedTask = 'captured task with "quotes", \\slashes, and 🦞\n'.repeat(256);
    queued.task = capturedTask;
    queued.queuedLaunch = {
      request: { sessionKey: queued.childSessionKey, task: queued.task },
      timeoutMs: 100,
      schedulerGroupKey: "synthetic-group",
      maxConcurrent: 1,
    };
    const terminal = createRun("private-terminal");
    terminal.completionTarget = "parent";
    terminal.execution = { status: "terminal", endedAt: 200 };
    const terminalReply = {
      disposition: "visible" as const,
      text: "[Mon 2026-09-21 12:00 UTC] [Mon 2026-09-21 12:00 UTC] captured reply",
    };
    terminal.completion = {
      required: false,
      resultText: "captured result 🦞\n".repeat(256),
      terminalReply,
    };
    const expected = [queued, terminal].map((entry) =>
      bindSubagentRunRecord(normalizeSubagentRunState(structuredClone(entry))),
    );
    const capturedContext = captureOpenClawStateWorkerContext();
    const sql = observeMainThreadSql();
    try {
      const write = persistSubagentRunsToDiskAsyncOrThrow(
        new Map([queued, terminal].map((entry) => [entry.runId, entry])),
        [queued.runId, terminal.runId, removed.runId],
        { context: capturedContext },
      );
      queued.task = "mutated after capture";
      queued.queuedLaunch.request.task = "mutated descriptor";
      terminal.completion.resultText = "mutated result";
      terminalReply.text = "mutated reply";
      await write;
      sql.expectIdle();
    } finally {
      sql.restore();
      await closeOpenClawStateDatabaseAsync();
    }
    const stored = loadSubagentRegistryFromSqlite();
    expect([...stored.keys()].toSorted()).toEqual(["private-terminal", "queued", "retained"]);
    expect(stored.get("queued")).toMatchObject({
      task: capturedTask,
      execution: { status: "queued" },
      completion: queued.completion,
      delivery: queued.delivery,
    });
    const database = openOpenClawStateDatabase({
      path: capturedContext.admission.databasePath,
      env: capturedContext.environment,
    });
    for (const row of expected) {
      expect(
        database.db.prepare("SELECT * FROM subagent_runs WHERE run_id = ?").get(row.run_id),
      ).toMatchObject(row);
    }
    expect(expected[1]?.payload_json).toContain('"parentCompletion":');
    const calibration = observeMainThreadSql();
    try {
      database.db.exec("BEGIN EXCLUSIVE;");
      database.db.exec("ROLLBACK");
      expect(() => calibration.expectIdle()).toThrow();
    } finally {
      calibration.restore();
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it("awaits the queued registration caller's two writes without host SQL", async () => {
  await withEnvAsync({ OPENCLAW_STATE_DIR: dirs.make("openclaw-queued-caller-") }, async () => {
    const entry = createRun("queued-caller");
    entry.requesterStorePath = "synthetic-requester-store";
    entry.controllerStorePath = "synthetic-controller-store";
    entry.queuedLaunch = {
      request: { sessionKey: entry.childSessionKey },
      timeoutMs: 100,
      schedulerGroupKey: "synthetic-group",
      maxConcurrent: 1,
    };
    const descriptor = structuredClone(entry.queuedLaunch);
    const capturedContext = captureOpenClawStateWorkerContext();
    const runs = new Map([[entry.runId, entry]]);
    saveSubagentRegistryToSqlite(new Map());
    const activate = vi.fn();
    const createTask = vi.fn((): TaskRecord => {
      expect(entry.queuedLaunch).toBeUndefined();
      return {
        taskId: "synthetic-task",
        runtime: "subagent",
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        requesterSessionKey: entry.requesterSessionKey,
        ownerKey: entry.requesterSessionKey,
        scopeKind: "session",
        task: entry.task,
        status: "queued",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: entry.createdAt,
      };
    });
    const sql = observeMainThreadSql();
    try {
      const registration = registerRequiredQueuedSubagent({
        context: capturedContext,
        entry,
        manager: {
          runs,
          getRunsForChildSession: () => runs.values(),
          getRuntimeConfig: () => ({}),
          persistAsyncOrThrow: (writeContext, publication, ...runIds) =>
            persistSubagentRunsToDiskAsyncOrThrow(runs, runIds, {
              context: writeContext,
              ...publication,
            }),
        },
        originals: new Map(),
        captureTaskOwner: (assertCurrent) => ({
          assertCurrent,
          create: createTask,
          finalize: () => [],
        }),
        bindReservation: () => {},
        activate,
      });
      expect(entry.queuedLaunch).toBeUndefined();
      expect(createTask).not.toHaveBeenCalled();
      await registration;
      sql.expectIdle();
      expect(createTask).toHaveBeenCalledOnce();
      expect(activate).toHaveBeenCalledOnce();
      expect(entry.queuedLaunch).toEqual(descriptor);
    } finally {
      sql.restore();
      await closeOpenClawStateDatabaseAsync();
    }
    expect(loadSubagentRegistryFromSqlite().get(entry.runId)).toMatchObject({
      queuedLaunch: descriptor,
      requesterStorePath: entry.requesterStorePath,
      controllerStorePath: entry.controllerStorePath,
    });
    await closeOpenClawStateDatabaseAsync();
  });
});
