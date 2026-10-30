import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { enableNodeSqliteKyselyStatementCache } from "./kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasPendingSqliteNativeExecution } from "./sqlite-native-observer.js";
import { runSqliteSchemaReadSnapshotSync } from "./sqlite-pinned-read-snapshot.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";

const runtime = vi.hoisted(() => {
  vi.resetModules();
  return { mainThread: false };
});
// mock-isolation: Exercise the synchronous acquisition boundary without booting a worker;
// the large-WAL Gateway proof covers actual native workers.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  get isMainThread() {
    return runtime.mainThread;
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  runtime.mainThread = false;
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const recovery = () => Object.assign(new Error("database is locked"), { errcode: 261 });

function failInitialSteps(failures: number, failure = recovery(), onReturn?: () => void) {
  // oxlint-disable-next-line typescript/unbound-method -- The wrapper forwards the native receiver with apply.
  const iterate = StatementSync.prototype.iterate;
  let attempts = 0;
  let returned = 0;
  vi.spyOn(StatementSync.prototype, "iterate").mockImplementation(function (
    this: StatementSync,
    ...bindings
  ) {
    const rows = iterate.apply(this, bindings);
    if (this.sourceSQL !== "PRAGMA schema_version") {
      return rows;
    }
    if (attempts <= failures) {
      expect(returned).toBe(attempts);
    }
    attempts += 1;
    const next = rows.next.bind(rows);
    rows.next = () => {
      if (attempts <= failures) {
        throw failure;
      }
      return next();
    };
    const finish = rows.return!.bind(rows);
    rows.return = () => {
      const result = finish();
      returned += 1;
      onReturn?.();
      return result;
    };
    return rows;
  });
  return { attempts: () => attempts, returned: () => returned };
}

it("retries recovery before pinning, finalizes each cursor, and invokes the callback once", () => {
  const probe = failInitialSteps(4);
  using database = openNodeSqliteDatabase(":memory:");
  enableNodeSqliteKyselyStatementCache(database);
  const operation = vi.fn((version: number) => version);
  expect(runSqliteSchemaReadSnapshotSync(database, operation)).toBe(0);
  expect([operation.mock.calls.length, probe.attempts(), probe.returned()]).toEqual([1, 5, 5]);
  expect(hasPendingSqliteNativeExecution(database)).toBe(false);
  expect(runSqliteSchemaReadSnapshotSync(database, operation)).toBe(0);
});

it.each([
  ["exhausted recovery", 261, false, 5],
  ["ordinary busy", 5, false, 1],
  ["locked", 6, false, 1],
  ["main-thread recovery", 261, true, 1],
])("does not replay %s beyond its acquisition bound", (_label, errcode, mainThread, attempts) => {
  runtime.mainThread = mainThread;
  const failure = Object.assign(new Error("native failure"), { errcode });
  const probe = failInitialSteps(10, failure);
  using database = openNodeSqliteDatabase(":memory:");
  const operation = vi.fn();
  expect(() => runSqliteSchemaReadSnapshotSync(database, operation)).toThrow(failure);
  expect([probe.attempts(), probe.returned(), operation.mock.calls.length]).toEqual([
    attempts,
    attempts,
    0,
  ]);
  expect(hasPendingSqliteNativeExecution(database)).toBe(false);
});

it("never replays callback work or a failed cursor cleanup", () => {
  using database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE effects (value INTEGER)");
  const failure = recovery();
  const operation = vi.fn(() => {
    database.exec("INSERT INTO effects VALUES (1)");
    throw failure;
  });
  expect(() => runSqliteSchemaReadSnapshotSync(database, operation)).toThrow(failure);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(database.prepare("SELECT * FROM effects").all()).toEqual([{ value: 1 }]);
  const probe = failInitialSteps(1, failure, () => {
    throw failure;
  });
  expect(() => runSqliteSchemaReadSnapshotSync(database, operation)).toThrow(failure);
  expect([probe.attempts(), probe.returned(), operation.mock.calls.length]).toEqual([1, 1, 1]);
});

it("qualifies fresh schema facts after recovery yields to a sibling commit", () => {
  const filename = path.join(tempDirs.make("sqlite-recovery-snapshot-"), "state.sqlite");
  using writer = openNodeSqliteDatabase(filename);
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE original (id INTEGER)");
  using reader = openNodeSqliteDatabase(filename, { readOnly: true });
  enableNodeSqliteKyselyStatementCache(reader);
  admitSqliteSchema(reader);
  expect(tableExists(reader, "later")).toBe(false);
  const probe = failInitialSteps(1, recovery(), () => {
    if (probe.returned() === 1) {
      writer.exec("CREATE TABLE later (value INTEGER)");
    }
  });
  expect(runSqliteSchemaReadSnapshotSync(reader, () => tableExists(reader, "later"))).toBe(true);
  expect(hasPendingSqliteNativeExecution(reader)).toBe(false);
});
