import fs from "node:fs";
import { performance } from "node:perf_hooks";
import type { DatabaseSyncOptions } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "./kysely-sync.js";
import { sqliteMaintenanceFixture } from "./sqlite-maintenance-fixture.test-support.js";
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
import type { SqliteWalMaintenanceOptions } from "./sqlite-wal.js";

const resources = sqliteMaintenanceFixture();
const open = (filename: string, nativeOptions?: DatabaseSyncOptions) =>
  resources.open(filename, nativeOptions, !nativeOptions);

const fixture = (options: SqliteWalMaintenanceOptions = {}, nativeOptions?: DatabaseSyncOptions) =>
  resources.wal(options, nativeOptions, !nativeOptions);

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
