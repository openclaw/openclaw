import path from "node:path";
import type { DatabaseSync, DatabaseSyncOptions } from "node:sqlite";
import { afterEach, expect, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewaySchedulerClock } from "../test-utils/gateway-scheduler-clock.js";
import { GatewayScheduler } from "./gateway-scheduler.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { configureSqliteWalMaintenance } from "./sqlite-wal.js";

/** File-local resources retire in reverse acquisition order, before removing their database files. */
export function sqliteMaintenanceFixture() {
  const dirs = createTempDirTracker();
  const dir = (prefix: string) => dirs.make(prefix);
  const cleanup: Array<() => unknown> = [];
  const retain = (close: () => unknown) => {
    cleanup.push(close);
  };
  afterEach(async () => {
    try {
      for (const close of cleanup.splice(0).toReversed()) {
        await close();
      }
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
      dirs.cleanup();
    }
  });
  const file = () => path.join(dirs.make("openclaw-sqlite-maintenance-"), "state.sqlite");
  const open = (filename = ":memory:", options: DatabaseSyncOptions = {}, tracked = false) => {
    const db = tracked
      ? openNodeSqliteDatabase(filename, options)
      : new (requireNodeSqlite().DatabaseSync)(filename, options);
    retain(() => {
      if (db.isOpen) {
        db.close();
      }
    });
    return db;
  };
  const maintain = (
    db: DatabaseSync,
    options: Parameters<typeof configureSqliteWalMaintenance>[1] = {},
  ) => {
    const maintenance = configureSqliteWalMaintenance(db, options);
    retain(async () => {
      await maintenance.stop();
      maintenance.close();
    });
    return maintenance;
  };
  const count = (db: DatabaseSync, label: string, pattern: RegExp) => {
    const counter = trackSqliteStatementExecutions(db, [label], (sql) =>
      pattern.test(sql) ? label : null,
    );
    retain(counter.restore);
    return counter;
  };
  const wal = (
    options: Parameters<typeof configureSqliteWalMaintenance>[1] = {},
    nativeOptions?: DatabaseSyncOptions,
    tracked = false,
  ) => {
    const databasePath = options.databasePath ?? file();
    const writer = open(databasePath, nativeOptions, tracked);
    return {
      databasePath,
      writer,
      maintenance: maintain(writer, { databasePath, checkpointIntervalMs: 0, ...options }),
    };
  };
  const entries = () => {
    const db = open();
    db.exec("CREATE TABLE entries (id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)");
    return db;
  };
  return { file, open, maintain, retain, count, wal, entries, dir };
}

export function sqliteSchedulerClock(nowMs = 1_000) {
  const clock = createGatewaySchedulerClock(nowMs);
  const scheduler = new GatewayScheduler({ clock: clock.clock });
  const scope = GatewayScheduler.prototype.scope.bind(scheduler);
  const scopeSpy = vi.spyOn(GatewayScheduler.prototype, "scope").mockImplementation(() => scope());
  return Object.assign(clock, { restore: () => scopeSpy.mockRestore() });
}

export function sqliteDiagnosticClock() {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return (elapsedMs: number) => {
    now += elapsedMs;
  };
}

export function spySqliteExec(
  db: DatabaseSync,
  before: (sql: string) => void = () => {},
  after: () => void = () => {},
) {
  const exec = db.exec.bind(db);
  return vi.spyOn(db, "exec").mockImplementation((sql) => {
    before(sql);
    exec(sql);
    after();
  });
}

export function thrownBy(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

export function readEntryIds(db: DatabaseSync) {
  return db
    .prepare("SELECT id FROM entries ORDER BY id")
    .all()
    .map((row) => row.id);
}

export function expectSettledEntries(db: DatabaseSync, ids: string[]) {
  expect(db.isTransaction).toBe(false);
  expect(readEntryIds(db)).toEqual(ids);
}

export function sqliteWriteGate() {
  const entered = createDeferredCore();
  const released = createDeferredCore();
  return {
    entered: entered.promise,
    release: released.resolve,
    wait: async () => {
      entered.resolve();
      await released.promise;
    },
  };
}
