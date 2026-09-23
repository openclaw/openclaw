import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runSqliteTransactionSync } from "./sqlite-transaction-core.js";
import {
  runSqliteImmediateTransactionSync,
  withSqliteWriteAdmissionService,
} from "./sqlite-transaction.js";

const databases: DatabaseSync[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
});
function createDatabase() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE entries (id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}
function readEntries(db: DatabaseSync) {
  return db
    .prepare("SELECT id FROM entries ORDER BY id")
    .all()
    .map((row) => row.id);
}
function createContendedDatabase() {
  const databasePath = path.join(tempDirs.make("sqlite-core-admission-"), "state.sqlite");
  const db = new DatabaseSync(databasePath);
  const writer = new DatabaseSync(databasePath);
  databases.push(db, writer);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE entries(id TEXT PRIMARY KEY)",
  );
  writer.exec("BEGIN IMMEDIATE");
  return { db, writer };
}

describe("SQLite transaction core and default-reporting entry", () => {
  const coreTransaction = <T>(db: DatabaseSync, operation: () => T) =>
    runSqliteTransactionSync(db, operation, "immediate", { logger: { warn() {} } });

  it.each([false, true])(
    "shares nested savepoints across entries (core outer: %s)",
    (coreOuter) => {
      const db = createDatabase();
      const [outer, inner] = coreOuter
        ? [coreTransaction, runSqliteImmediateTransactionSync]
        : [runSqliteImmediateTransactionSync, coreTransaction];
      outer(db, () => {
        db.prepare("INSERT INTO entries VALUES ('outer', 'kept')").run();
        expect(() =>
          inner(db, () => {
            db.prepare("INSERT INTO entries VALUES ('inner', 'rolled back')").run();
            throw new Error("inner failure");
          }),
        ).toThrow("inner failure");
        inner(db, () => db.prepare("INSERT INTO entries VALUES ('after', 'kept')").run());
      });
      expect(readEntries(db)).toEqual(["after", "outer"]);
    },
  );

  it.each([false, true])("shares terminal failure across entries (core outer: %s)", (coreOuter) => {
    const db = createDatabase();
    db.exec("PRAGMA max_page_count=3");
    const [outer, inner] = coreOuter
      ? [coreTransaction, runSqliteImmediateTransactionSync]
      : [runSqliteImmediateTransactionSync, coreTransaction];
    let primaryError: unknown;
    let outerError: unknown;
    try {
      outer(db, () => {
        try {
          inner(db, () => db.prepare("INSERT INTO entries VALUES ('full', zeroblob(65536))").run());
        } catch (error) {
          primaryError = error;
        }
      });
    } catch (error) {
      outerError = error;
    }
    expect(primaryError).toMatchObject({ errcode: 13 });
    expect(outerError).toBe(primaryError);
    expect(db.isOpen).toBe(false);
    for (const transact of [outer, inner]) {
      let reuseError: unknown;
      try {
        transact(db, () => undefined);
      } catch (error) {
        reuseError = error;
      }
      expect(reuseError).toBe(primaryError);
    }
  });

  it("services public admission reservations from the explicit-reporter core", async () => {
    const { db, writer } = createContendedDatabase();
    const releaseWriter = vi.fn(() => writer.exec("COMMIT"));
    await withSqliteWriteAdmissionService(db, releaseWriter, async () => {
      coreTransaction(db, () => db.prepare("INSERT INTO entries VALUES ('core')").run());
    });
    expect(releaseWriter).toHaveBeenCalledOnce();
    expect(db.isTransaction).toBe(false);
    expect(writer.isTransaction).toBe(false);
    expect(db.prepare("SELECT id FROM entries").all()).toEqual([{ id: "core" }]);
  });
});
