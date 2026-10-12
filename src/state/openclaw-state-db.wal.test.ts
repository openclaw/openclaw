import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { sqliteReaderDatabasePathKey } from "../infra/sqlite-reader-lifecycle.js";
import { onSqliteWalCheckpoint } from "../infra/sqlite-wal-checkpoint.js";
import { observeSqliteWalPeriodicWork } from "../infra/sqlite-wal-scheduler.test-support.js";
import * as walAdmission from "../infra/sqlite-wal-write-admission.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  runOutsideOpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseByPathAsync,
} from "./openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { createSqliteWorkerBackend } from "./openclaw-state.worker.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});

beforeAll(() => {
  expect(isMainThread, "Shared-state host admission requires a real process main thread").toBe(
    true,
  );
});

function openWithPeriodicMaintenance(databasePath: string) {
  const scheduled = observeSqliteWalPeriodicWork();
  try {
    const database = openOpenClawStateDatabase({ path: databasePath });
    return { database, periodic: scheduled.periodic };
  } finally {
    scheduled.restore();
  }
}

function observeCheckpoints(pathname: string) {
  const databasePath = sqliteReaderDatabasePathKey(pathname);
  const observations: string[] = [];
  const first = createDeferred();
  const stop = onSqliteWalCheckpoint((observation) => {
    if (observation.databasePath === databasePath) {
      observations.push(observation.health.state);
      first.resolve();
    }
  });
  return {
    observations,
    stop,
    wait: (signal: AbortSignal) => withinTest(first.promise, signal),
  };
}

function sqliteBytes(databasePath: string) {
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].map((suffix) => {
      const file = databasePath + suffix;
      return [
        suffix,
        fs.existsSync(file)
          ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
          : null,
      ];
    }),
  );
}

it("keeps periodic WAL work off the host before and after a competing SQLite writer releases", async ({
  signal,
}) => {
  const { database, periodic } = openWithPeriodicMaintenance(
    path.join(tempDirs.make("state-wal-native-writer-"), "openclaw.sqlite"),
  );
  const writer = new DatabaseSync(database.path);
  const { observations, wait, stop } = observeCheckpoints(database.path);
  const prepare = vi.spyOn(database.db, "prepare");
  const execute = vi.spyOn(database.db, "exec");
  let periodicWork: Promise<unknown> | undefined;
  try {
    writer.exec("BEGIN IMMEDIATE");
    const nextTurn = setImmediate();
    periodicWork = Promise.resolve(periodic());
    expect(observations).toEqual([]);
    await nextTurn;
    await wait(signal);
    await periodicWork;
    expect(writer.isTransaction).toBe(true);
    expect(observations.every((state) => state === "complete" || state === "blocked")).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(
      writer.prepare("SELECT name FROM sqlite_schema WHERE name='sqlite_stat1'").get(),
    ).toBeUndefined();
  } finally {
    stop();
    if (writer.isTransaction) {
      writer.exec("ROLLBACK");
    }
    writer.close();
    await periodicWork;
  }
  const afterRelease = observeCheckpoints(database.path);
  try {
    periodicWork = Promise.resolve(periodic());
    await afterRelease.wait(signal);
    await periodicWork;
    expect(afterRelease.observations[0]).toBe("complete");
    expect(database.walMaintenance.health).toMatchObject({ state: "complete", warning: false });
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await periodicWork;
    prepare.mockRestore();
    execute.mockRestore();
    afterRelease.stop();
  }
  expect(database.db.prepare("SELECT tbl FROM sqlite_stat1 WHERE tbl='schema_meta'").get()).toEqual(
    { tbl: "schema_meta" },
  );
});

it("analyzes once per periodic pass, preserves retained snapshots, and admits run-index plans", async () => {
  const { database, periodic } = openWithPeriodicMaintenance(
    path.join(tempDirs.make("state-wal-planner-"), "openclaw.sqlite"),
  );
  database.db.exec(`
    WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<8192)
    INSERT INTO audit_events(event_id,source_id,source_sequence,occurred_at,kind,action,status,
      actor_type,actor_id,run_id,direction)
    SELECT 'event-'||n,'source-'||n,n,1000+n,'message','message.outbound.finished','succeeded',
      'agent','fixture','run-'||(n/8),CASE WHEN n%10=0 THEN 'inbound' ELSE 'outbound' END FROM rows;
  `);
  expect(database.walMaintenance.checkpoint()).toBe(true);
  const reader = new DatabaseSync(database.path, { readOnly: true });
  const query = `SELECT sequence FROM audit_events WHERE kind='message' AND direction='outbound'
    AND action='message.outbound.finished' AND run_id=? AND occurred_at>=?
    ORDER BY occurred_at,sequence LIMIT 256`;
  const read = reader.prepare(query);
  const before = read.all("run-100", 0);
  expect(before).toHaveLength(7);
  const context = captureOpenClawStateWorkerContext({ path: database.path });
  const backend = runWithSqliteWorkerStateContext(context, () =>
    createSqliteWorkerBackend(undefined, { databasePath: database.path }),
  );
  let refuseCommit = false;
  const admission = createSqliteWorkerOperationAdmission((request, grant) => {
    context.admission.assertCurrent();
    if (refuseCommit && request.stage === "commit" && analyses() === 3) {
      throw new Error("fixture revoked commit");
    }
    grant();
  });
  const nativePost = admission.port.postMessage.bind(admission.port);
  // The real backend runs on this thread so service the grant before its synchronous wait.
  const dispatch = vi
    .spyOn(admission.port, "postMessage")
    .mockImplementation((message, transfers) => {
      nativePost(message, transfers);
      admission.service();
    });
  const execute = (input: walAdmission.SqliteWalPeriodicRequest) =>
    runWithSqliteWorkerStateContext(context, () =>
      withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
        backend.execute({ type: "database.walMaintenance", input }),
      ),
    );
  // Preserve real scheduler continuation and native command execution while exposing SQL counts.
  walAdmission.registerSqliteWalWorkerMaintenance(database.db, async (request) =>
    z.object({ reclaimedPages: z.number() }).parse(execute(request)),
  );
  const statements = vi.spyOn(database.db, "exec");
  const analyses = () =>
    statements.mock.calls.filter(([sql]) => sql.includes("ANALYZE main")).length;
  try {
    execute({ maxPages: 0, checkpointMode: "PASSIVE" });
    expect(analyses()).toBe(0);
    reader.exec("BEGIN");
    expect(read.all("run-100", 0)).toEqual(before);
    await periodic();
    expect(analyses()).toBe(1);
    expect(statements).toHaveBeenCalledWith("PRAGMA analysis_limit=1000; ANALYZE main;");
    expect(
      reader.prepare("SELECT name FROM sqlite_schema WHERE name='sqlite_stat1'").get(),
    ).toBeUndefined();
    expect(read.all("run-100", 0)).toEqual(before);
    reader.exec("COMMIT");
    expect(read.all("run-100", 0)).toEqual(before);
    const fresh = new DatabaseSync(database.path, { readOnly: true });
    try {
      expect(
        fresh
          .prepare("SELECT stat FROM sqlite_stat1 WHERE idx='idx_audit_events_run_sequence'")
          .get(),
      ).toBeDefined();
      expect(fresh.prepare(`EXPLAIN QUERY PLAN ${query}`).all("run-100", 0)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.stringContaining("USING INDEX idx_audit_events_run_sequence"),
          }),
        ]),
      );
      expect(fresh.prepare(query).all("run-100", 0)).toEqual(before);
    } finally {
      fresh.close();
    }
    execute({ maxPages: 512, checkpointMode: "PASSIVE", continuation: true });
    expect(analyses()).toBe(1);
    database.db.exec(`
      WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<64)
      INSERT INTO config_machine_state(state_key,value_json,updated_at_ms)
      SELECT 'bulk-'||n,hex(zeroblob(8192)),1 FROM rows;
      DELETE FROM config_machine_state WHERE state_key LIKE 'bulk-%';
    `);
    expect(
      Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count),
    ).toBeGreaterThan(8);
    await periodic();
    expect(analyses()).toBe(2);
    const statistics = database.db.prepare("SELECT * FROM sqlite_stat1 ORDER BY tbl,idx").all();
    database.db.exec("DELETE FROM audit_events WHERE sequence>4000");
    refuseCommit = true;
    await periodic();
    expect(analyses()).toBe(3);
    expect(database.db.prepare("SELECT * FROM sqlite_stat1 ORDER BY tbl,idx").all()).toEqual(
      statistics,
    );
    expect(database.db.isTransaction).toBe(false);
  } finally {
    statements.mockRestore();
    dispatch.mockRestore();
    admission.finish();
    if (reader.isTransaction) {
      reader.exec("ROLLBACK");
    }
    reader.close();
    await backend.close();
  }
});

it("joins private maintenance timer cancellation before retiring its native handle (publisher failure: true)", async () => {
  const databasePath = path.join(tempDirs.make("state-wal-private-owner-"), "openclaw.sqlite");
  const owner = acquireGatewayStateOwner({ databasePath });
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: owner.assertCurrent,
    assertDatabaseAccess: owner.assertDatabaseAccess,
  });
  let periodicMaintenance: Promise<walAdmission.SqliteWalPeriodicResult | undefined> | undefined;
  let scheduledWork: Promise<unknown> | undefined;
  let periodicSettled = false;
  const register = walAdmission.registerSqliteWalWorkerMaintenance;
  const registration = vi
    .spyOn(walAdmission, "registerSqliteWalWorkerMaintenance")
    .mockImplementation((database, execute, cancel) =>
      register(
        database,
        (request) =>
          (periodicMaintenance = execute(request).then((result) => {
            periodicSettled = true;
            return result;
          })),
        cancel,
      ),
    );
  let database: ReturnType<typeof openOpenClawStateDatabase> | undefined;
  const failure = new Error("publisher failed after durable bind");
  try {
    const publish = () =>
      maintenance.run(() => {
        const opened = openWithPeriodicMaintenance(databasePath);
        database = opened.database;
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.exec(
              "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES ('test:capture-bind','true',1)",
            );
          },
          { database, path: databasePath },
        );
        const prepare = vi.spyOn(database.db, "prepare");
        const execute = vi.spyOn(database.db, "exec");
        try {
          scheduledWork = Promise.resolve(opened.periodic());
          expect(prepare).not.toHaveBeenCalled();
          expect(execute).not.toHaveBeenCalled();
        } finally {
          prepare.mockRestore();
          execute.mockRestore();
        }

        throw failure;
      });

    expect(publish).toThrow(failure);

    await maintenance.close();
    await scheduledWork;
    expect(periodicMaintenance).toBeDefined();
    expect(periodicSettled).toBe(true);
    await expect(periodicMaintenance).resolves.toBeUndefined();
    expect(database?.db.isOpen).toBe(false);
  } finally {
    registration.mockRestore();
    try {
      await maintenance.close();
    } finally {
      try {
        await scheduledWork;
      } finally {
        owner.release();
      }
    }
  }
  const reopened = openOpenClawStateDatabase({ path: databasePath });
  expect(
    reopened.db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key='test:capture-bind'")
      .get(),
  ).toEqual({ value_json: "true" });
});

it("keeps periodic maintenance after a parent caller adopts its cached handle", async ({
  signal,
}) => {
  const databasePath = path.join(tempDirs.make("state-wal-adopted-owner-"), "openclaw.sqlite");
  const parent = createOpenClawDatabaseMaintenanceScope();
  const child = parent.run(() => createOpenClawDatabaseMaintenanceScope());
  const { database, periodic } = child.run(() => openWithPeriodicMaintenance(databasePath));
  const prepare = vi.spyOn(database.db, "prepare");
  const execute = vi.spyOn(database.db, "exec");
  const observed = observeCheckpoints(database.path);
  let periodicWork: Promise<unknown> | undefined;
  try {
    const adopt = () => openOpenClawStateDatabase({ path: databasePath });
    expect(parent.run(adopt)).toBe(database);
    await child.close();
    expect(database.db.isOpen).toBe(true);
    prepare.mockClear();
    execute.mockClear();
    periodicWork = Promise.resolve(periodic());
    await observed.wait(signal);
    await periodicWork;
    expect(database.walMaintenance.health).toMatchObject({ state: "complete", warning: false });
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await periodicWork;
    observed.stop();
    prepare.mockRestore();
    execute.mockRestore();
    await child.close();
    await parent.close();
    await closeOpenClawStateDatabaseByPathAsync(database.path);
  }
});

it("refuses independent adoption after its cached handle starts closing", async () => {
  const databasePath = path.join(tempDirs.make("state-wal-closing-owner-"), "openclaw.sqlite");
  const parent = createOpenClawDatabaseMaintenanceScope();
  const child = parent.run(() => createOpenClawDatabaseMaintenanceScope());
  const { database } = child.run(() => openWithPeriodicMaintenance(databasePath));
  const entered = createDeferred();
  const released = createDeferred();
  const adopt = () => {
    const open = () => openOpenClawStateDatabase({ path: databasePath });
    return runOutsideOpenClawDatabaseMaintenanceScope(open);
  };
  let synchronousAdmission: unknown;
  let inspected = false;
  const cancel = walAdmission.cancelSqliteWalWriteAdmission;
  const cancellation = vi
    .spyOn(walAdmission, "cancelSqliteWalWriteAdmission")
    .mockImplementation(async (target) => {
      if (target === database.db) {
        if (!inspected) {
          inspected = true;
          try {
            synchronousAdmission = adopt();
          } catch (error) {
            synchronousAdmission = error;
          }
        }
        entered.resolve();
        await released.promise;
      }
      await cancel(target);
    });
  const closing = child.close();
  try {
    await entered.promise;
    expect(synchronousAdmission).toMatchObject({
      message: expect.stringMatching(/maintenance.*closed/i),
    });
    expect(adopt).toThrow(/maintenance.*closed/i);
    released.resolve();
    await closing;
    expect(database.db.isOpen).toBe(false);
    expect(openOpenClawStateDatabase({ path: databasePath }).db.isOpen).toBe(true);
  } finally {
    released.resolve();
    await closing;
    cancellation.mockRestore();
    await parent.close();
  }
});

it("refuses checkpoints without borrowing the timer caller's maintenance authority", async ({
  signal,
}) => {
  const { database, periodic } = openWithPeriodicMaintenance(
    path.join(tempDirs.make("state-wal-maintenance-authority-"), "openclaw.sqlite"),
  );
  const owner = acquireGatewayStateOwner({ databasePath: database.path });
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: owner.assertCurrent,
    assertDatabaseAccess: owner.assertDatabaseAccess,
  });
  const before = sqliteBytes(database.path);
  const { observations, wait, stop } = observeCheckpoints(database.path);
  const prepare = vi.spyOn(database.db, "prepare");
  let periodicWork: Promise<unknown> | undefined;
  try {
    periodicWork = Promise.resolve(maintenance.run(() => periodic()));
    await wait(signal);
    expect(observations).toEqual(["error"]);
    expect(database.walMaintenance.health?.error).toContain("offline maintenance");
    expect(prepare).not.toHaveBeenCalled();
    expect(database.walMaintenance.checkpoint()).toBe(false);
    expect(observations).toEqual(["error", "error"]);
    expect(prepare).not.toHaveBeenCalled();
    expect(database.db.isOpen).toBe(true);
    expect(sqliteBytes(database.path)).toEqual(before);
  } finally {
    prepare.mockRestore();
    stop();
    try {
      await maintenance.close();
    } finally {
      try {
        await periodicWork;
      } finally {
        owner.release();
      }
    }
  }
  const afterRelease = observeCheckpoints(database.path);
  try {
    periodicWork = Promise.resolve(periodic());
    await afterRelease.wait(signal);
    await periodicWork;
    expect(afterRelease.observations[0]).toBe("complete");
  } finally {
    await periodicWork;
    afterRelease.stop();
  }
});

// Windows cannot rename a directory while SQLite retains its native files.
it.runIf(process.platform !== "win32")(
  "refuses a physically replaced database after periodic admission yields",
  async ({ signal }) => {
    const root = tempDirs.make("state-wal-replacement-");
    const originalDirectory = path.join(root, "original");
    const replacementDirectory = path.join(root, "replacement");
    const displacedDirectory = path.join(root, "displaced");
    const { database, periodic } = openWithPeriodicMaintenance(
      path.join(originalDirectory, "openclaw.sqlite"),
    );
    const replacement = openOpenClawStateDatabase({
      path: path.join(replacementDirectory, "openclaw.sqlite"),
    });
    replacement.db
      .prepare(
        "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
      )
      .run("replacement", "preserved", "{}", 1);
    await closeOpenClawStateDatabaseByPathAsync(replacement.path);
    const replacementBytes = sqliteBytes(replacement.path);
    const { observations, wait, stop } = observeCheckpoints(database.path);
    let originalMoved = false;
    let replacementInstalled = false;
    let periodicWork: Promise<unknown> | undefined;
    try {
      periodicWork = Promise.resolve(periodic());
      expect(observations).toEqual([]);
      fs.renameSync(originalDirectory, displacedDirectory);
      originalMoved = true;
      fs.renameSync(replacementDirectory, originalDirectory);
      replacementInstalled = true;
      await wait(signal);
      await periodicWork;
      expect(database.walMaintenance.health).toMatchObject({
        state: "error",
        error: expect.stringContaining(
          "SQLite database file identity changed before existing-only open",
        ),
      });
      expect(observations).toEqual(["error"]);
      expect(sqliteBytes(database.path)).toEqual(replacementBytes);
    } finally {
      await periodicWork;
      stop();
      // Restore each SQLite file family before closing the old native connection.
      if (replacementInstalled) {
        fs.renameSync(originalDirectory, replacementDirectory);
      }
      if (originalMoved) {
        fs.renameSync(displacedDirectory, originalDirectory);
      }
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    }
  },
);

it("cancels queued periodic maintenance during synchronous close without replaying it", async () => {
  const { database, periodic } = openWithPeriodicMaintenance(
    path.join(tempDirs.make("state-wal-close-"), "openclaw.sqlite"),
  );
  database.db
    .prepare(
      "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
    )
    .run("maintenance-close", "preserved", "{}", 1);
  const { observations, stop } = observeCheckpoints(database.path);
  const periodicWork: Promise<unknown>[] = [];
  try {
    periodicWork.push(Promise.resolve(periodic()));
    periodicWork.push(Promise.resolve(periodic()));
    expect(observations).toEqual([]);
    const closed = closeOpenClawStateDatabaseByPath(database.path);
    expect(closed).toBe(true);
    expect(database.db.isOpen).toBe(false);
    expect(observations).toEqual(["complete"]);
    periodicWork.push(Promise.resolve(periodic()));
    await Promise.all(periodicWork);
    expect(observations).toEqual(["complete"]);
    const reopened = openOpenClawStateDatabase({ path: database.path });
    expect(
      reopened.db
        .prepare("SELECT event_key FROM diagnostic_events WHERE scope=?")
        .all("maintenance-close"),
    ).toEqual([{ event_key: "preserved" }]);
  } finally {
    stop();
    try {
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    } finally {
      await Promise.all(periodicWork);
    }
  }
});

it("leaves raw access sole custody only after the orderly close joins worker retirement", async () => {
  const root = tempDirs.make("state-wal-worker-retirement-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const store = createPluginStateKeyedStore<string>("fixture-plugin", {
    namespace: "worker-retirement",
    maxEntries: 1,
    env,
  });
  await store.register("retained", "value");
  const databasePath = openOpenClawStateDatabase({ env }).path;
  // Every open WAL connection keeps a shared file lock, so only a sole
  // connection can take this exclusive lock.
  const claimSoleCustody = () => {
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
    } finally {
      raw.close();
    }
  };

  // The synchronous close only starts retirement of the worker's connection.
  closeOpenClawStateDatabaseForTest();
  expect(claimSoleCustody).toThrow(/database is locked/);

  await closeOpenClawStateDatabaseAsync();
  expect(claimSoleCustody).not.toThrow();
});
