import { existsSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import {
  bindTaskFlowRecord,
  upsertTaskFlowRowInDatabase,
} from "../tasks/task-flow-registry.store.kernel.js";
import * as nodeSqlite from "./node-sqlite.js";
import { SqliteSchemaVersionError } from "./sqlite-user-version.js";
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
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const statements = (["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      try {
        expect(
          await executeOpenClawStateWorker(admission, {
            type: "flows.list",
            input: { ownerKey: "agent:main:main" },
          }),
        ).toEqual([]);
        expect(prepare).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
        for (const statement of statements) {
          expect(statement).not.toHaveBeenCalled();
        }
        expect(admission.admission.identity.key).toMatch(/^file:/);
      } finally {
        prepare.mockRestore();
        exec.mockRestore();
        for (const statement of statements) {
          statement.mockRestore();
        }
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

  it("leaves a missing database absent for existing-only inspection", async () => {
    const captured = context();
    const inspect = vi.fn(async () => "inspected");
    expect(
      await runOpenClawStateWorkerOperation(captured, inspect, { existingOnly: true }),
    ).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
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

  it("opens a fresh actor for a new call after the previous worker exits", async () => {
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
    ).rejects.toThrow();
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
