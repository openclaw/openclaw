import fs from "node:fs";
import { performance } from "node:perf_hooks";
import type { DatabaseSyncOptions } from "node:sqlite";
import { setImmediate as realImmediate } from "node:timers/promises";
import { threadId } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "./kysely-sync.js";
import { readSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  sqliteMaintenanceFixture,
  sqliteSchedulerClock,
  sqliteWriteGate,
} from "./sqlite-maintenance-fixture.test-support.js";
import {
  assertNoActiveSqliteReaders,
  readSqliteReaderDiagnosticsForPath,
  retainSqliteReader,
  withSqliteReaderOwner,
} from "./sqlite-reader-lifecycle.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";
import {
  createSqliteWalCheckpoint,
  onSqliteWalCheckpoint,
  publishSqliteWalCheckpointObservation,
  type SqliteWalCheckpointSnapshot,
} from "./sqlite-wal-checkpoint.js";
import {
  cancelSqliteWalWriteAdmission,
  registerSqliteWalWorkerMaintenance,
} from "./sqlite-wal-write-admission.js";
import { configureSqlitePreSchemaPragmas, type SqliteWalMaintenanceOptions } from "./sqlite-wal.js";

const resources = sqliteMaintenanceFixture();
const open = (filename: string, nativeOptions?: DatabaseSyncOptions) =>
  resources.open(filename, nativeOptions, !nativeOptions);

function fixture(
  options: SqliteWalMaintenanceOptions = {},
  nativeOptions?: DatabaseSyncOptions,
  preSchema = false,
) {
  const databasePath = resources.file();
  const writer = resources.open(databasePath, nativeOptions, !nativeOptions);
  if (preSchema) {
    configureSqlitePreSchemaPragmas(writer);
  }
  const maintenance = resources.maintain(writer, {
    databasePath,
    checkpointIntervalMs: 0,
    ...options,
  });
  return { databasePath, writer, maintenance };
}
const valueRows = (...values: string[]) => values.map((value) => ({ value }));

it("retains relayed health across native generations and rejects older observations", () => {
  const databasePath = resources.file();
  const database = open(databasePath);
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE events(value TEXT)");
  const reader = open(databasePath);
  const owner = createSqliteWalCheckpoint(database, { databasePath }, 64 * 1024 * 1024);
  const replacement = createSqliteWalCheckpoint(database, { databasePath }, 64 * 1024 * 1024);
  expect(owner.checkpoint("PASSIVE")).toBe(true);
  const completed = owner.snapshot!;
  expect(completed.lastCompletedAtNs).toBe(completed.observedAtNs);
  replacement.adopt(completed);
  reader.exec("BEGIN");
  reader.prepare("SELECT value FROM events").all();
  database.exec("INSERT INTO events VALUES ('retained')");
  expect(replacement.checkpoint("PASSIVE")).toBe(false);
  owner.adopt(replacement.snapshot!);
  expect(owner.health).toMatchObject({
    state: "blocked",
    consecutiveBlocked: 1,
    lastCompletedAtMs: completed.health.lastCompletedAtMs,
  });
  expect(owner.checkpoint("PASSIVE")).toBe(false);
  const blocked = owner.snapshot;
  expect(blocked?.lastCompletedAtNs).toBe(completed.observedAtNs);
  owner.adopt(completed);
  expect(owner.snapshot).toEqual(blocked);
  expect(owner.health).toMatchObject({ consecutiveBlocked: 2, warning: true });
  reader.exec("ROLLBACK");
  expect(owner.checkpoint("PASSIVE")).toBe(true);
  owner.adopt(replacement.snapshot!);
  expect(owner.health).toMatchObject({ state: "complete", consecutiveBlocked: 0 });
  const recovered = owner.snapshot!;
  const delayed = createSqliteWalCheckpoint(database, { databasePath }, 64 * 1024 * 1024);
  reader.exec("BEGIN");
  reader.prepare("SELECT value FROM events").all();
  database.exec("INSERT INTO events VALUES ('newer')");
  expect(delayed.checkpoint("PASSIVE")).toBe(false);
  const newerBlocked = delayed.snapshot!;
  delayed.adopt(recovered);
  expect(delayed.snapshot).toMatchObject({
    observedAtNs: newerBlocked.observedAtNs,
    lastCompletedAtNs: recovered.observedAtNs,
    health: { state: "blocked" },
  });
  owner.adopt(newerBlocked);
  expect(owner.snapshot?.lastCompletedAtNs).toBe(recovered.observedAtNs);
});

it("recycles an oversized completed WAL during admitted periodic maintenance without waiting for readers", async () => {
  vi.useFakeTimers();
  let admitted = false;
  const { databasePath, writer, maintenance } = fixture(
    {
      autoCheckpointPages: 0,
      busyTimeoutMs: 5_000,
      checkpointIntervalMs: 100,
      runMaintenance: (operation) => admitted && operation(),
    },
    {},
  );
  writer.exec("CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES(zeroblob(1048576));");
  for (let index = 0; index < 65; index++) {
    writer.exec("UPDATE payload SET value=randomblob(1048576)");
  }
  const oversized = fs.statSync(`${databasePath}-wal`).size;
  expect(oversized).toBeGreaterThan(64 * 1024 * 1024);
  await vi.advanceTimersByTimeAsync(100);
  expect(fs.statSync(`${databasePath}-wal`).size).toBe(oversized);
  const reader = open(databasePath, { readOnly: true });
  reader.exec("BEGIN");
  expect(reader.prepare("SELECT length(value) AS bytes FROM payload").get()?.bytes).toBe(1048576);
  admitted = true;
  const started = performance.now();
  await vi.advanceTimersByTimeAsync(100);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(fs.statSync(`${databasePath}-wal`).size).toBe(oversized);
  expect(maintenance.health?.state).toBe("blocked");
  expect(writer.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5_000);
  reader.exec("ROLLBACK");
  await vi.advanceTimersByTimeAsync(100);
  expect(fs.statSync(`${databasePath}-wal`).size).toBeLessThanOrEqual(64 * 1024 * 1024);
  expect(maintenance.health?.state).toBe("complete");
  expect(writer.prepare("SELECT length(value) AS bytes FROM payload").get()?.bytes).toBe(1048576);
});

it("keeps a completed checkpoint successful when file-size observation fails", () => {
  const onCheckpointError = vi.fn();
  const { writer, maintenance } = fixture({ onCheckpointError }, {});
  writer.exec("CREATE TABLE events (value TEXT); INSERT INTO events VALUES ('committed');");
  const failure = new Error("file-size observation unavailable");
  vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
    throw failure;
  });
  expect(maintenance.checkpoint()).toBe(true);
  expect(maintenance.health).toMatchObject({
    state: "complete",
    warning: false,
    error: "file-size observation unavailable",
    lastCompletedAtMs: expect.any(Number),
  });
  expect(onCheckpointError).toHaveBeenCalledWith(failure);
});

it.each([
  { checkpointMode: "TRUNCATE", readBigInts: false, returnArrays: false },
  { checkpointMode: "PASSIVE", readBigInts: true, returnArrays: true },
] as const)(
  "records a $checkpointMode checkpoint blocked by another connection's reader (BigInt=$readBigInts, arrays=$returnArrays)",
  ({ checkpointMode, readBigInts, returnArrays }) => {
    const onCheckpointError = vi.fn();
    const { databasePath, writer, maintenance } = fixture(
      { checkpointMode, databaseLabel: "test-db", onCheckpointError },
      { readBigInts, returnArrays },
    );
    writer.exec(
      "CREATE TABLE events(value TEXT); INSERT INTO events VALUES ('before-reader'); PRAGMA wal_checkpoint(TRUNCATE)",
    );
    const reader = open(databasePath, {});
    reader.exec("BEGIN;");
    reader.prepare("SELECT COUNT(*) FROM events").get();
    writer.exec("INSERT INTO events VALUES ('after-reader')");

    expect(maintenance.checkpoint()).toBe(false);
    if (checkpointMode === "TRUNCATE") {
      expect(onCheckpointError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "test-db WAL checkpoint TRUNCATE remained busy" }),
      );
    }
    expect(maintenance.inspectIdle?.()).toBe("healthy");
    expect(maintenance.health).toMatchObject({
      state: "blocked",
      logFrames: 1,
      checkpointedFrames: 0,
      walBytes: fs.statSync(`${databasePath}-wal`).size,
      databaseBytes: fs.statSync(databasePath).size,
      consecutiveBlocked: 1,
      lastCompletedAtMs: null,
      warning: false,
    });
    expect(maintenance.checkpoint()).toBe(false);
    expect(maintenance.health).toMatchObject({ consecutiveBlocked: 2, warning: true });
    reader.exec("ROLLBACK;");
    expect(maintenance.checkpoint()).toBe(true);
    expect(maintenance.health).toMatchObject({
      state: "complete",
      consecutiveBlocked: 0,
      lastCompletedAtMs: expect.any(Number),
      warning: false,
    });
  },
);

it("refuses retention after a native row-decoding failure until the reader is returned", () => {
  const { databasePath, writer: db, maintenance } = fixture();
  db.exec("CREATE TABLE events(value INTEGER); INSERT INTO events VALUES (9007199254740993)");
  db.exec("PRAGMA query_only=ON");
  const reader = db.prepare("SELECT value FROM events").iterate();
  resources.retain(() => reader.return?.());
  expect(maintenance.inspectIdle?.()).toBe("healthy");
  expect(() => reader.next()).toThrow(RangeError);
  expect(db.isTransaction).toBe(false);
  expect(maintenance.inspectIdle?.()).toBe("retire");
  expect(readSqliteReaderDiagnosticsForPath(databasePath).activeReaders).toEqual([]);
  expect(() => assertNoActiveSqliteReaders(db, "native idle probe")).not.toThrow();
  reader.return?.();
  expect(maintenance.inspectIdle?.()).toBe("healthy");
  expect(readSqliteReaderDiagnosticsForPath(databasePath).activeReaders).toEqual([]);
});

it("does not report unsupported non-WAL maintenance as healthy", () => {
  const db = resources.open();
  const maintenance = resources.maintain(db, { checkpointIntervalMs: 0 });
  expect(db.prepare("PRAGMA journal_mode;").get()).toEqual({ journal_mode: "memory" });
  expect(maintenance.checkpoint()).toBe(true);
  expect(maintenance.inspectIdle).toBeUndefined();
  expect(maintenance.close()).toBe(true);
});

it("bounds named Kysely reader diagnostics without claiming a blocking owner", () => {
  const { databasePath, writer, maintenance } = fixture({ checkpointMode: "PASSIVE" });
  const held: Array<ReturnType<typeof iterateSqliteQuerySync>> = [];
  writer.exec(
    "CREATE TABLE events(value TEXT); INSERT INTO events VALUES ('before-reader'); PRAGMA wal_checkpoint(TRUNCATE)",
  );
  for (let index = 0; index < 10; index++) {
    withSqliteReaderOwner({ operation: `fixture.reader-${index}`, ownerKind: "main" }, () => {
      const reader = open(databasePath);
      const iterator = iterateSqliteQuerySync(
        reader,
        getNodeSqliteKysely<{ events: { value: string } }>(reader).selectFrom("events").selectAll(),
      );
      held.push(iterator);
      resources.retain(() => iterator.return?.());
      iterator.next();
    });
  }
  writer.prepare("INSERT INTO events (value) VALUES (?)").run("after-reader");
  expect(maintenance.checkpoint()).toBe(false);
  expect(maintenance.health).toMatchObject({
    state: "blocked",
    activeReaders: expect.arrayContaining([
      expect.objectContaining({
        operation: "fixture.reader-0",
        ownerKind: "main",
        kind: "iterator",
        connectionId: expect.any(Number),
        threadId,
      }),
    ]),
    readerDiagnostics: [
      expect.objectContaining({
        scope: "current-thread",
        blockingOwner: "unknown",
        nativeStatements: "unobserved",
        threadId,
        connectionCount: 11,
        readerCount: 10,
      }),
    ],
  });
  expect(maintenance.health?.activeReaders).toHaveLength(8);
  expect(maintenance.health?.readerDiagnostics?.[0]?.connections).toHaveLength(8);
  expect(JSON.stringify(maintenance.health)).not.toContain("SELECT");
  for (const iterator of held) {
    iterator.return?.();
  }
  expect(maintenance.checkpoint()).toBe(true);
  expect(maintenance.health?.activeReaders).toBeUndefined();
  expect(readSqliteReaderDiagnosticsForPath(databasePath).activeReaders).toEqual([]);
});

it("observes native transaction state without claiming custody and publishes checkpoint completion", () => {
  const { databasePath, writer, maintenance } = fixture({ busyTimeoutMs: 0 });
  const reader = withSqliteReaderOwner(
    { operation: "fixture.open-reader", ownerKind: "main" },
    () => open(databasePath),
  );
  const seen: SqliteWalCheckpointSnapshot[] = [];
  const unsubscribe = onSqliteWalCheckpoint((observation) => {
    if (observation.databasePath === databasePath) {
      expect(maintenance.health?.state).toBe(observation.health.state);
      seen.push({ health: observation.health, observedAtNs: observation.observedAtNs });
    }
  });
  resources.retain(unsubscribe);
  writer.exec("CREATE TABLE events(value TEXT); INSERT INTO events VALUES ('before');");
  runSqliteDeferredTransactionSync(
    reader,
    () => {
      reader.prepare("SELECT value FROM events").get();
      writer.exec("INSERT INTO events VALUES ('after');");
      expect(maintenance.checkpoint()).toBe(false);
      expect(maintenance.health?.activeReaders).toEqual([]);
      expect(maintenance.health?.readerDiagnostics?.[0]?.connections).toContainEqual(
        expect.objectContaining({
          operation: "fixture.open-reader",
          transactionOpen: true,
          trackedReaders: 0,
        }),
      );
      expect(() => assertNoActiveSqliteReaders(reader, "native transaction probe")).not.toThrow();
      const observed = publishSqliteWalCheckpointObservation(databasePath, seen[0]!);
      expect(observed.health.activeReaders).toHaveLength(0);
      expect(observed.health.readerDiagnostics).toHaveLength(1);
    },
    { operationLabel: "fixture.named-transaction" },
  );
  expect(maintenance.checkpoint()).toBe(true);
  expect(seen.map(({ health }) => health.state)).toEqual(["blocked", "blocked", "complete"]);
  expect(fs.statSync(`${databasePath}-wal`).size).toBe(0);
});

it("does not settle explicit reader custody when forgetting closed connection metadata", () => {
  const databasePath = resources.file();
  const database = open(databasePath);
  const owned = retainSqliteReader(database, "fixture.owned-reader");
  resources.retain(() => owned.release());
  database.close();
  expect(readSqliteReaderDiagnosticsForPath(databasePath).connectionCount).toBe(0);
  expect(() => assertNoActiveSqliteReaders(database, "fixture")).toThrow("fixture.owned-reader");
  owned.release();
  expect(() => assertNoActiveSqliteReaders(database, "fixture")).not.toThrow();
});

it("keeps checkpoint-only reclamation nonblocking without changing the connection lock policy", () => {
  const { writer, maintenance, databasePath } = fixture(
    {
      autoCheckpointPages: 0,
      busyTimeoutMs: 5_000,
    },
    {},
  );
  const peer = resources.open(databasePath);
  writer.exec("CREATE TABLE payload (value TEXT); INSERT INTO payload VALUES ('before');");
  peer.exec("BEGIN; SELECT * FROM payload;");
  writer.exec("INSERT INTO payload VALUES ('after');");
  const admission = vi.fn();
  const observation = observeHostDataSql();
  try {
    const blocked = maintenance.reclaimFreePages({
      checkpointMode: "PASSIVE",
      maxPages: 0,
      beforeMutation: admission,
    });
    expect(blocked).toMatchObject({
      checkpoint: { health: { state: "blocked" } },
      vacuumPasses: 0,
    });
    expect(admission).toHaveBeenCalledOnce();
    expect(observation.queries.filter((sql) => /busy_timeout/i.test(sql))).toEqual([]);
  } finally {
    observation.restore();
  }
  expect(writer.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5_000);
  expect(peer.prepare("SELECT COUNT(*) AS count FROM payload").get()?.count).toBe(1);
  peer.exec("ROLLBACK; BEGIN IMMEDIATE;");
  expect(
    maintenance.reclaimFreePages({ checkpointMode: "PASSIVE", maxPages: 0 }).checkpoint?.health
      .state,
  ).toBe("complete");
  peer.exec("ROLLBACK;");
  expect(() =>
    maintenance.reclaimFreePages({
      checkpointMode: "PASSIVE",
      maxPages: 0,
      beforeMutation: () => {
        throw new Error("revoked");
      },
    }),
  ).toThrow("revoked");
  expect(maintenance.health).toMatchObject({ state: "error", error: "revoked" });
  expect(writer.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5_000);
  expect(writer.prepare("SELECT value FROM payload ORDER BY rowid").all()).toEqual(
    valueRows("before", "after"),
  );
});

it("does not amplify a reader-held WAL on repeated periodic maintenance", async () => {
  vi.useFakeTimers();
  const { writer, maintenance, databasePath } = fixture(
    {
      autoCheckpointPages: 0,
      busyTimeoutMs: 50,
      checkpointIntervalMs: 100,
    },
    {},
    true,
  );
  const reader = resources.open(databasePath, { readOnly: true });
  writer.exec(`CREATE TABLE payload (data BLOB);
      INSERT INTO payload VALUES (zeroblob(4194304));
      DELETE FROM payload;`);
  expect(maintenance.checkpoint()).toBe(true);
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) FROM payload").get();
  writer.exec("INSERT INTO payload VALUES ('retained');");
  const freePages = () => Number(writer.prepare("PRAGMA freelist_count").get()?.freelist_count);
  const before = freePages();
  const walBytes = fs.statSync(`${databasePath}-wal`).size;
  expect(before).toBeGreaterThan(512);
  for (let pass = 0; pass < 3; pass++) {
    await vi.advanceTimersByTimeAsync(100);
    expect(maintenance.health?.state).toBe("blocked");
    expect(freePages()).toBe(before);
    expect(fs.statSync(`${databasePath}-wal`).size).toBe(walBytes);
  }
  expect(writer.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(50);
  reader.exec("ROLLBACK");
  await vi.advanceTimersByTimeAsync(100);
  expect(maintenance.health?.state).toBe("complete");
  expect(before - freePages()).toBeGreaterThan(0);
  expect(before - freePages()).toBeLessThanOrEqual(512);
  expect(maintenance.checkpoint()).toBe(true);
  expect(fs.statSync(`${databasePath}-wal`).size).toBe(0);
  expect(writer.prepare("SELECT data FROM payload").get()?.data).toBe("retained");
});

it("reports bounded page progress and retains the native checkpoint outcome", () => {
  let admitted = true;
  const { writer: database, maintenance } = fixture(
    { runMaintenance: (op) => admitted && op() },
    {},
    true,
  );
  database.exec(`CREATE TABLE payload (data BLOB);
      INSERT INTO payload VALUES (zeroblob(4194304));
      DELETE FROM payload;`);
  const observed: string[] = [];
  const result = maintenance.reclaimFreePages({
    maxPages: 5,
    beforeMutation: () => observed.push(`before:${database.isTransaction}`),
    onCommit: () => observed.push(`commit:${database.isTransaction}`),
    afterCommit: () => observed.push(`settled:${database.isTransaction}`),
  });
  expect(observed).toEqual([
    "before:false",
    "before:true",
    "commit:true",
    "settled:false",
    "before:false",
  ]);
  expect(result).toMatchObject({
    checkpointCompleted: true,
    checkpoint: { health: { state: "complete", walBytes: 0 } },
    checkpointCalls: 2,
    checkpointIncomplete: 0,
    vacuumPasses: 1,
    vacuumPagesRequested: 5,
  });
  expect(result.freePagesBefore! - result.remainingFreePages!).toBeGreaterThan(0);
  expect(result.freePagesBefore! - result.remainingFreePages!).toBeLessThanOrEqual(5);
  admitted = false;
  expect(() => maintenance.reclaimFreePages()).toThrow("reclamation owner is unavailable");
});

function createDatabase() {
  const dbPath = resources.file();
  const db = resources.open(dbPath);
  const pragma = (name: string) => Number(db.prepare(`PRAGMA ${name};`).get()?.[name]);
  return { db, dbPath, pragma };
}

describe("sqlite WAL checkpoint tick", () => {
  it.each(["before", "after"])(
    "cancels delegated checkpoint wakeups when registered %s configuration",
    async (registrationOrder) => {
      const clock = sqliteSchedulerClock();
      const { db, dbPath, pragma } = createDatabase();
      let cancelled = 0;
      const requests: number[] = [];
      const registerWorker = () =>
        registerSqliteWalWorkerMaintenance(
          db,
          async (request) => {
            requests.push(request.maxPages);
            return undefined;
          },
          () => {
            cancelled += 1;
          },
        );
      if (registrationOrder === "before") {
        registerWorker();
      }
      const maintenance = resources.maintain(db, {
        checkpointIntervalMs: 60_000,
        databasePath: dbPath,
      });
      if (registrationOrder === "after") {
        expect(pragma("wal_autocheckpoint")).toBe(16 * 1024);
        expect(clock.armedAtMs).toBe(11_000);
        registerWorker();
      }
      expect(pragma("wal_autocheckpoint")).toBe(0);
      expect(clock.armedAtMs).toBe(61_000);

      await clock.advanceBy(50_000);
      expect(requests).toEqual([]);
      expect(clock.armedAtMs).toBe(61_000);
      await clock.advanceBy(10_000);
      expect(requests).toEqual([512]);
      expect(clock.armedAtMs).toBe(121_000);

      const prepare = vi.spyOn(db, "prepare");
      const exec = vi.spyOn(db, "exec");
      try {
        await cancelSqliteWalWriteAdmission(db);
        expect(cancelled).toBe(1);
        await maintenance.stop();
        expect(maintenance.close()).toBe(false);
        expect(prepare).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
        exec.mockRestore();
      }
      expect(pragma("wal_autocheckpoint")).toBe(0);
      expect(clock.armedAtMs).toBeNull();
    },
  );

  it("joins admitted maintenance before native close and refuses subsequent wakes", async () => {
    vi.useFakeTimers();
    const { db } = createDatabase();
    const maintenance = resources.maintain(db, { checkpointIntervalMs: 100 });
    const gate = sqliteWriteGate();
    resources.retain(gate.release);
    const execute = vi.fn(async () => {
      await gate.wait();
      expect(db.isOpen).toBe(true);
      return undefined;
    });
    registerSqliteWalWorkerMaintenance(db, execute);
    vi.advanceTimersByTime(100);
    await gate.entered;
    const closed = vi.fn();
    const closing = maintenance.stop().then(() => {
      maintenance.close();
      db.close();
      closed();
    });
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    gate.release();
    await closing;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(closed).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("checkpoints on the maintenance tick and vacuums only on the periodic pass", async () => {
    vi.useFakeTimers();
    const { db, dbPath, pragma } = createDatabase();
    const freelistCount = () => pragma("freelist_count");
    // The periodic pass yields between vacuum units on real immediates that fake timers do not own.
    const settle = async () => {
      for (let index = 0; index < 64; index += 1) {
        await realImmediate();
      }
    };
    configureSqlitePreSchemaPragmas(db);
    const maintenance = resources.maintain(db, {
      busyTimeoutMs: 1_000,
      checkpointIntervalMs: 60_000,
      databasePath: dbPath,
    });
    db.exec("CREATE TABLE payload (id INTEGER PRIMARY KEY, value BLOB NOT NULL);");
    const insert = db.prepare("INSERT INTO payload (value) VALUES (?)");
    const value = new Uint8Array(16 * 1024);
    for (let index = 0; index < 64; index += 1) {
      insert.run(value);
    }
    db.exec("DELETE FROM payload;");
    const freeBefore = freelistCount();
    expect(freeBefore).toBeGreaterThan(0);
    // Commits below the inline threshold leave every frame for the maintenance tick.
    expect(maintenance.health).toBeUndefined();

    const reads = resources.count(db, "timeout", /\bbusy_timeout\b/iu);
    const exec = vi.spyOn(db, "exec");
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(reads.counts.timeout).toBe(0);
      expect(exec.mock.calls.some(([sql]) => /\bbusy_timeout\b/iu.test(sql))).toBe(false);
    } finally {
      reads.restore();
      exec.mockRestore();
    }
    expect(readSqliteBusyTimeout(db)).toBe(1_000);

    const ticked = expectDefined(maintenance.health, "WAL tick health");
    expect(ticked).toMatchObject({ state: "complete", checkpointedFrames: ticked.logFrames });
    expect(ticked.checkpointedFrames).toBeGreaterThan(0);
    expect(freelistCount()).toBe(freeBefore);

    await vi.advanceTimersByTimeAsync(50_000);
    await settle();
    expect(freelistCount()).toBeLessThan(freeBefore);
  });
});

const tick = { maxPages: 0, checkpointMode: "PASSIVE" as const };
const openTracked = (filename: string, readOnly = false) =>
  resources.open(filename, { readOnly }, true);
const maintain = resources.maintain;
const countCheckpoints = (db: ReturnType<typeof openTracked>) =>
  resources.count(db, "checkpoint", /wal_checkpoint/iu);

function idleFixture(options: SqliteWalMaintenanceOptions = {}) {
  const { databasePath, writer, maintenance } = fixture({
    checkpointIntervalMs: undefined,
    ...options,
  });
  writer.exec("CREATE TABLE events(value TEXT)");
  return { databasePath, writer, maintenance, sibling: openTracked(databasePath) };
}

describe("idle WAL checkpoint ticks", () => {
  it("disarms clean ticks and keeps the first sibling write deadline through later writes", async () => {
    const clock = sqliteSchedulerClock();
    const { writer, maintenance, sibling } = idleFixture();
    await clock.advanceBy(10_000);
    expect(maintenance.health?.state).toBe("complete");
    const periodicAtMs = 1_000 + 30 * 60_000;
    expect(clock.armedAtMs).toBe(periodicAtMs);
    await clock.advanceBy(10_000);
    expect(clock.armedAtMs).toBe(periodicAtMs);

    sibling.exec("BEGIN; INSERT INTO events VALUES ('first')");
    expect(clock.armedAtMs).toBe(periodicAtMs);
    sibling.exec("COMMIT");
    expect(clock.armedAtMs).toBe(31_000);
    await clock.advanceBy(5_000);
    sibling.exec("INSERT INTO events VALUES ('second')");
    expect(clock.armedAtMs).toBe(31_000);
    await clock.advanceBy(5_000);
    expect(maintenance.health?.state).toBe("complete");
    expect(clock.armedAtMs).toBe(periodicAtMs);

    await maintenance.stop();
    expect(clock.armedAtMs).toBeNull();
    sibling.exec("INSERT INTO events VALUES ('after-stop')");
    expect(clock.armedAtMs).toBeNull();
    expect(writer.prepare("SELECT value FROM events ORDER BY rowid").all()).toEqual(
      valueRows("first", "second", "after-stop"),
    );
  });

  it("skips completed idle ticks and resumes after writes on either connection", async () => {
    vi.useFakeTimers();
    let admitted = true;
    const { writer, maintenance, sibling } = idleFixture({
      autoCheckpointPages: 0,
      runMaintenance: (operation) => admitted && operation(),
    });
    const statements = countCheckpoints(writer);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maintenance.health?.state).toBe("complete");
    expect(statements.counts.checkpoint).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statements.counts.checkpoint).toBe(1);

    sibling.exec("INSERT INTO events VALUES ('sibling')");
    admitted = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statements.counts.checkpoint).toBe(1);
    admitted = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statements.counts.checkpoint).toBe(2);
    expect(maintenance.health?.state).toBe("complete");
    writer.exec("INSERT INTO events VALUES ('owner')");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statements.counts.checkpoint).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statements.counts.checkpoint).toBe(3);
    expect(sibling.prepare("SELECT value FROM events ORDER BY rowid").all()).toEqual(
      valueRows("sibling", "owner"),
    );
  });

  it("retries a blocked checkpoint after its reader releases without another write", async () => {
    vi.useFakeTimers();
    const { writer, maintenance, sibling: reader } = idleFixture({ autoCheckpointPages: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    reader.exec("BEGIN");
    reader.prepare("SELECT value FROM events").all();
    writer.exec("INSERT INTO events VALUES ('retained')");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maintenance.health?.state).toBe("blocked");
    reader.exec("ROLLBACK");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maintenance.health?.state).toBe("complete");
    expect(maintenance.health?.checkpointedFrames).toBeGreaterThan(0);
  });

  it("shares completed frames across maintenance connections and invalidates them on sibling writes", () => {
    const options = { checkpointIntervalMs: 0, autoCheckpointPages: 0 };
    const { databasePath, writer, maintenance, sibling } = idleFixture(options);
    const siblingMaintenance = maintain(sibling, { databasePath, ...options });
    const statements = [writer, sibling].map(countCheckpoints);
    maintenance.maintainPeriodic?.(tick);
    siblingMaintenance.maintainPeriodic?.(tick);
    expect(statements.map(({ counts }) => counts.checkpoint)).toEqual([1, 0]);

    sibling.exec("INSERT INTO events VALUES ('sibling')");
    siblingMaintenance.maintainPeriodic?.(tick);
    maintenance.maintainPeriodic?.(tick);
    expect(statements.map(({ counts }) => counts.checkpoint)).toEqual([1, 1]);

    writer.exec("INSERT INTO events VALUES ('owner')");
    maintenance.maintainPeriodic?.(tick);
    siblingMaintenance.maintainPeriodic?.(tick);
    expect(statements.map(({ counts }) => counts.checkpoint)).toEqual([2, 1]);
    expect(sibling.prepare("SELECT value FROM events ORDER BY rowid").all()).toEqual(
      valueRows("sibling", "owner"),
    );
  });

  it("stops retrying blocked frames after a sibling completes them without another write", () => {
    const options = { checkpointIntervalMs: 0, autoCheckpointPages: 0 };
    const { databasePath, writer, maintenance, sibling } = idleFixture(options);
    const siblingMaintenance = maintain(sibling, { databasePath, ...options });
    const reader = openTracked(databasePath, true);
    const statements = countCheckpoints(writer);
    maintenance.maintainPeriodic?.(tick);
    reader.exec("BEGIN");
    reader.prepare("SELECT value FROM events").all();
    writer.exec("INSERT INTO events VALUES ('retained')");
    maintenance.maintainPeriodic?.(tick);
    siblingMaintenance.maintainPeriodic?.(tick);
    expect(maintenance.health?.state).toBe("blocked");
    expect(siblingMaintenance.health?.state).toBe("blocked");
    reader.exec("ROLLBACK");
    siblingMaintenance.maintainPeriodic?.(tick);
    expect(siblingMaintenance.health?.state).toBe("complete");
    expect(maintenance.maintainPeriodic?.(tick)?.checkpoint).toBeUndefined();
    expect(statements.counts.checkpoint).toBe(2);
  });

  it("keeps checkpointing untracked connections whose write revision is unknown", async () => {
    vi.useFakeTimers();
    const databasePath = resources.file();
    const writer = resources.open(databasePath);
    maintain(writer, { databasePath });
    const statements = countCheckpoints(writer);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statements.counts.checkpoint).toBe(3);
  });
});
