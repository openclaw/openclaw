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
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { sqliteReaderDatabasePathKey } from "../infra/sqlite-reader-lifecycle.js";
import { onSqliteWalCheckpoint } from "../infra/sqlite-wal-checkpoint.js";
import { observeSqliteWalPeriodicWork } from "../infra/sqlite-wal-scheduler.test-support.js";
import * as walAdmission from "../infra/sqlite-wal-write-admission.js";
import { SqliteWorkerBroker } from "../infra/sqlite-worker-broker.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { storageProcessTestEntrypoints } from "../infra/storage-process-runtime.test-support.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
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
import type { SharedStateWalFixtureOperations } from "./openclaw-state-worker-wal.test-support.js";
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

function makeDatabasePath(name: string) {
  return path.join(tempDirs.make(`state-wal-${name}-`), "openclaw.sqlite");
}

function observeHostSql(db: EngineConnection) {
  const prepare = vi.spyOn(db, "prepare");
  const exec = vi.spyOn(db, "exec");
  return {
    assertIdle() {
      expect(prepare).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    },
    clear() {
      prepare.mockClear();
      exec.mockClear();
    },
  };
}

function ownedMaintenance(pathname: string) {
  const owner = acquireGatewayStateOwner({ databasePath: pathname });
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: owner.assertCurrent,
    assertDatabaseAccess: owner.assertDatabaseAccess,
  });
  return {
    maintenance,
    close: async (pending?: Promise<unknown>) => {
      try {
        await maintenance.close();
      } finally {
        try {
          await pending;
        } finally {
          owner.release();
        }
      }
    },
  };
}

function seedEvent(db: EngineConnection, scope: string) {
  db.prepare(
    "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
  ).run(scope, "preserved", "{}", 1);
}

function readRow(db: EngineConnection, query: string) {
  return db.prepare(query).get();
}

const statsTableQuery = "SELECT name FROM sqlite_schema WHERE name='sqlite_stat1'";
const runStatsQuery = "SELECT stat FROM sqlite_stat1 WHERE idx='idx_audit_events_run_sequence'";

async function pluginStore(namespace: string, value: string) {
  const root = tempDirs.make(`state-wal-${namespace}-`);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const store = createPluginStateKeyedStore<string>("fixture-plugin", {
    namespace,
    maxEntries: 1,
    env,
  });
  await store.register("retained", value);
  return { store, database: openOpenClawStateDatabase({ env }) };
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

async function expectPeriodicCheckpoint(
  database: ReturnType<typeof openOpenClawStateDatabase>,
  periodic: () => unknown,
  signal: AbortSignal,
  check: (observations: string[]) => void,
) {
  const observed = observeCheckpoints(database.path);
  let pending: Promise<unknown> | undefined;
  try {
    pending = Promise.resolve(periodic());
    await observed.wait(signal);
    await pending;
    check(observed.observations);
  } finally {
    await pending;
    observed.stop();
  }
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

it("suspends shared-worker ticks only while maintenance clients retain the actor", async () => {
  const root = tempDirs.make("state-worker-wal-tick-");
  const databasePath = path.join(root, "state", "openclaw.sqlite");
  const context = { environment: { ...process.env, OPENCLAW_STATE_DIR: root } };
  const broker = new SqliteWorkerBroker();
  const firstMaintenance = createOpenClawDatabaseMaintenanceScope();
  const secondMaintenance = createOpenClawDatabaseMaintenanceScope();
  const open = async (maintenance?: typeof firstMaintenance) => {
    const store = await broker.open<SharedStateWalFixtureOperations>(
      {
        moduleUrl: resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.sharedStateWalFixture),
        databasePath,
        input: undefined,
      },
      context,
      undefined,
      { maintenanceScope: maintenance },
    );
    if (!store) {
      throw new Error("Shared-state WAL fixture did not open");
    }
    maintenance?.own(store, "shared-resources", () => store.close());
    return store;
  };
  try {
    const maintained = await open(firstMaintenance);
    const ordinary = await open();
    const overlapping = await open(secondMaintenance);
    const actor = broker.getActorIdentity(ordinary);
    expect(broker.getActorIdentity(maintained)).toBe(actor);
    expect(broker.getActorIdentity(overlapping)).toBe(actor);

    const before = await ordinary.execute({ type: "fixture.seed", input: undefined });
    const heldTick = await ordinary.execute({ type: "fixture.tick", input: undefined });
    expect(heldTick).toEqual(before);
    expect(heldTick.checkpoints).toBe(0);

    let grants = 0;
    await firstMaintenance.run(() =>
      broker.runOperation(
        maintained,
        (worker) =>
          worker.execute({
            type: "database.walMaintenance",
            input: { maxPages: 0, checkpointMode: "PASSIVE" },
          }),
        context,
        undefined,
        () => ({
          nativeLocations: [databasePath],
          admission: createSqliteWorkerOperationAdmission((_request, grant) => {
            if (grant()) {
              grants++;
            }
          }),
        }),
      ),
    );
    const admitted = await ordinary.execute({ type: "fixture.snapshot", input: undefined });
    expect(admitted.actor).toBe(before.actor);
    expect(admitted.digest).not.toBe(before.digest);
    expect(admitted.checkpoints).toBeGreaterThan(0);
    expect(grants).toBeGreaterThan(0);

    const pending = await ordinary.execute({ type: "fixture.seed", input: undefined });
    await firstMaintenance.close();
    expect(await ordinary.execute({ type: "fixture.tick", input: undefined })).toEqual(pending);
    await secondMaintenance.close();
    const resumed = await ordinary.execute({ type: "fixture.tick", input: undefined });
    expect(broker.getActorIdentity(ordinary)).toBe(actor);
    expect(resumed.actor).toBe(pending.actor);
    expect(resumed.digest).not.toBe(pending.digest);
    expect(resumed.checkpoints).toBeGreaterThan(0);
  } finally {
    try {
      await firstMaintenance.close();
      await secondMaintenance.close();
    } finally {
      await broker.close();
    }
  }
});

it("keeps periodic WAL off-host across native contention", async ({ signal }) => {
  const { database, periodic } = openWithPeriodicMaintenance(makeDatabasePath("native-writer"));
  const writer = new DatabaseSync(database.path);
  const { observations, wait, stop } = observeCheckpoints(database.path);
  const sql = observeHostSql(database.db);
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
    sql.assertIdle();
    expect(readRow(writer, statsTableQuery)).toBeUndefined();
  } finally {
    stop();
    if (writer.isTransaction) {
      writer.exec("ROLLBACK");
    }
    writer.close();
    await periodicWork;
  }
  await expectPeriodicCheckpoint(database, periodic, signal, (states) => {
    expect(states[0]).toBe("complete");
    expect(database.walMaintenance.health).toMatchObject({ state: "complete", warning: false });
    sql.assertIdle();
  });
  expect(readRow(database.db, "SELECT tbl FROM sqlite_stat1 WHERE tbl='schema_meta'")).toEqual({
    tbl: "schema_meta",
  });
});

it("refreshes planner stats without changing snapshots or indexes", async () => {
  const { database, periodic } = openWithPeriodicMaintenance(makeDatabasePath("planner"));
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
  let refreshedStatisticsAtCommit: unknown;
  const admission = createSqliteWorkerOperationAdmission((request, grant) => {
    context.admission.assertCurrent();
    if (refuseCommit && request.stage === "commit" && plannerPasses() === 3) {
      refreshedStatisticsAtCommit = readRow(database.db, runStatsQuery);
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
  walAdmission.registerSqliteWalWorkerMaintenance(
    requireNativeSqliteDatabase(database.db),
    async (request) => z.object({ reclaimedPages: z.number() }).parse(execute(request)),
  );
  const statements = vi.spyOn(database.db, "exec");
  const plannerPasses = () =>
    statements.mock.calls.filter(([sql]) => sql.includes("PRAGMA optimize")).length;
  try {
    execute({ maxPages: 0, checkpointMode: "PASSIVE" });
    expect(plannerPasses()).toBe(0);
    reader.exec("BEGIN");
    expect(read.all("run-100", 0)).toEqual(before);
    await periodic();
    expect(plannerPasses()).toBe(1);
    expect(readRow(reader, statsTableQuery)).toBeUndefined();
    expect(read.all("run-100", 0)).toEqual(before);
    reader.exec("COMMIT");
    expect(read.all("run-100", 0)).toEqual(before);
    {
      using fresh = new DatabaseSync(database.path, { readOnly: true });
      expect(readRow(fresh, runStatsQuery)).toEqual({ stat: expect.stringMatching(/^[1-9]\d* /) });
      expect(fresh.prepare(`EXPLAIN QUERY PLAN ${query}`).all("run-100", 0)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.stringContaining("USING INDEX idx_audit_events_run_sequence"),
          }),
        ]),
      );
      expect(fresh.prepare(query).all("run-100", 0)).toEqual(before);
    }
    execute({ maxPages: 512, checkpointMode: "PASSIVE", continuation: true });
    expect(plannerPasses()).toBe(1);
    database.db.exec(`
      WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<64)
      INSERT INTO config_machine_state(state_key,value_json,updated_at_ms)
      SELECT 'bulk-'||n,hex(zeroblob(8192)),1 FROM rows;
      DELETE FROM config_machine_state WHERE state_key LIKE 'bulk-%';
    `);
    expect(Number(readRow(database.db, "PRAGMA freelist_count")?.freelist_count)).toBeGreaterThan(
      8,
    );
    await periodic();
    expect(plannerPasses()).toBe(2);
    // Missing statistics force real maintenance work before the refused commit.
    database.db.exec(`
      DELETE FROM sqlite_stat1 WHERE idx='idx_audit_events_run_sequence';
      ANALYZE sqlite_schema;
    `);
    const statistics = database.db.prepare("SELECT * FROM sqlite_stat1 ORDER BY tbl,idx").all();
    refuseCommit = true;
    await periodic();
    expect(plannerPasses()).toBe(3);
    expect(refreshedStatisticsAtCommit).toEqual({ stat: expect.stringMatching(/^[1-9]\d* /) });
    expect(database.db.prepare("SELECT * FROM sqlite_stat1 ORDER BY tbl,idx").all()).toEqual(
      statistics,
    );
    expect(read.all("run-100", 0)).toEqual(before);
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

it("joins private timer cancellation after publisher failure", async () => {
  const pathname = makeDatabasePath("private-owner");
  const { maintenance, close } = ownedMaintenance(pathname);
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
        const opened = openWithPeriodicMaintenance(pathname);
        database = opened.database;
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.exec(
              "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES ('test:capture-bind','true',1)",
            );
          },
          { database, path: pathname },
        );
        const sql = observeHostSql(database.db);
        scheduledWork = Promise.resolve(opened.periodic());
        sql.assertIdle();

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
    await close(scheduledWork);
  }
  const reopened = openOpenClawStateDatabase({ path: pathname });
  expect(
    readRow(
      reopened.db,
      "SELECT value_json FROM config_machine_state WHERE state_key='test:capture-bind'",
    ),
  ).toEqual({ value_json: "true" });
});

it("keeps periodic WAL after parent adoption", async ({ signal }) => {
  const pathname = makeDatabasePath("adopted-owner");
  const parent = createOpenClawDatabaseMaintenanceScope();
  const child = parent.run(() => createOpenClawDatabaseMaintenanceScope());
  const { database, periodic } = child.run(() => openWithPeriodicMaintenance(pathname));
  const sql = observeHostSql(database.db);
  try {
    const adopt = () => openOpenClawStateDatabase({ path: pathname });
    expect(parent.run(adopt)).toBe(database);
    await child.close();
    expect(database.db.isOpen).toBe(true);
    sql.clear();
    await expectPeriodicCheckpoint(database, periodic, signal, () => {
      expect(database.walMaintenance.health).toMatchObject({ state: "complete", warning: false });
      sql.assertIdle();
    });
  } finally {
    await child.close();
    await parent.close();
    await closeOpenClawStateDatabaseByPathAsync(database.path);
  }
});

it("refuses adoption once cached-handle retirement starts", async () => {
  const pathname = makeDatabasePath("closing-owner");
  const parent = createOpenClawDatabaseMaintenanceScope();
  const child = parent.run(() => createOpenClawDatabaseMaintenanceScope());
  const { database } = child.run(() => openWithPeriodicMaintenance(pathname));
  const entered = createDeferred();
  const released = createDeferred();
  const adopt = () => {
    const open = () => openOpenClawStateDatabase({ path: pathname });
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
    expect(openOpenClawStateDatabase({ path: pathname }).db.isOpen).toBe(true);
  } finally {
    released.resolve();
    await closing;
    cancellation.mockRestore();
    await parent.close();
  }
});

it("does not borrow a timer caller's maintenance authority", async ({ signal }) => {
  const { database, periodic } = openWithPeriodicMaintenance(makeDatabasePath("authority"));
  const { maintenance, close } = ownedMaintenance(database.path);
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
    await close(periodicWork);
  }
  await expectPeriodicCheckpoint(database, periodic, signal, (states) => {
    expect(states[0]).toBe("complete");
  });
});

// Windows cannot rename a directory while SQLite retains its native files.
it.runIf(process.platform !== "win32")(
  "refuses physical replacement after periodic admission yields",
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
    seedEvent(replacement.db, "replacement");
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

it("cancels queued WAL work without replay on synchronous close", async () => {
  const { database, periodic } = openWithPeriodicMaintenance(makeDatabasePath("close"));
  seedEvent(database.db, "maintenance-close");
  const { observations, stop } = observeCheckpoints(database.path);
  const sql = observeHostSql(database.db);
  const periodicWork: Promise<unknown>[] = [];
  try {
    periodicWork.push(Promise.resolve(periodic()));
    periodicWork.push(Promise.resolve(periodic()));
    expect(observations).toEqual([]);
    const closed = closeOpenClawStateDatabaseByPath(database.path);
    expect(closed).toBe(true);
    expect(database.db.isOpen).toBe(false);
    expect(observations).toEqual([]);
    periodicWork.push(Promise.resolve(periodic()));
    await Promise.all(periodicWork);
    expect(observations).toEqual([]);
    sql.assertIdle();
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

it("flushes worker writes before host close without host SQL", async () => {
  const { store, database } = await pluginStore("worker-shutdown", "initial");
  await store.register("retained", "final");
  const sql = observeHostSql(database.db);
  const nativeClose = database.db.close.bind(database.db);
  let walBytesAtHostClose: number | undefined;
  const close = vi.spyOn(database.db, "close").mockImplementation(() => {
    walBytesAtHostClose = fs.statSync(`${database.path}-wal`).size;
    nativeClose();
  });
  try {
    await closeOpenClawStateDatabaseByPathAsync(database.path);
    sql.assertIdle();
    expect(walBytesAtHostClose).toBe(0);
  } finally {
    close.mockRestore();
  }
  using reopened = new DatabaseSync(database.path, { readOnly: true });
  expect(
    readRow(reopened, "SELECT value_json FROM plugin_state_entries WHERE entry_key = 'retained'"),
  ).toEqual({ value_json: '"final"' });
});

it("joins worker retirement before granting raw sole custody", async () => {
  const { database } = await pluginStore("worker-retirement", "value");
  // Every open WAL connection keeps a shared file lock, so only a sole
  // connection can take this exclusive lock.
  const claimSoleCustody = () => {
    using raw = new DatabaseSync(database.path);
    raw.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
  };

  // The synchronous close only starts retirement of the worker's connection.
  closeOpenClawStateDatabaseForTest();
  expect(claimSoleCustody).toThrow(/database is locked/);

  await closeOpenClawStateDatabaseAsync();
  expect(claimSoleCustody).not.toThrow();
});
