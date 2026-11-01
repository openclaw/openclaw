import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readSqliteDatabaseScopedWriteToken,
  readSqliteDatabasePendingScopedWriteToken,
  withSqliteDatabaseWriteScope,
  prepareSqliteDatabaseScopedWriteRevisionForPath,
} from "./sqlite-database-admission.js";
import { withSqlitePreparedNativeMutation } from "./sqlite-native-observer.js";
import {
  stageSqliteTransactionState,
  withSqlitePostCommitPublications,
} from "./sqlite-post-commit.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { hasSqliteWorkerOutcomeUnknown } from "./sqlite-worker-error.js";

describe("scoped SQLite write receipts", () => {
  const { openDatabase, tempDirs } = useSqliteSchemaTestFixture();

  it("keeps prepared epochs settled, scoped, and bounded by their retained owner", () => {
    const location = path.join(tempDirs.make("prepared-write-revision-"), "state.sqlite");
    const database = openDatabase(undefined, true, location);
    const prepared = prepareSqliteDatabaseScopedWriteRevisionForPath(location, ["entry"])!;
    try {
      const initial = prepared.read();
      expect(initial).toBeDefined();
      withSqliteDatabaseWriteScope(database, ["sibling"], () =>
        database.exec("INSERT INTO original VALUES (1)"),
      );
      expect(prepared.read()).toBe(initial);
      runSqliteImmediateTransactionSync(database, () => {
        database.exec("INSERT INTO original VALUES (2)");
        expect(prepared.read()).toBeUndefined();
      });
      const changed = prepared.read();
      expect(changed).toBeDefined();
      expect(changed).not.toBe(initial);
      expect(() =>
        runSqliteImmediateTransactionSync(database, () => {
          database.exec("INSERT INTO original VALUES (3)");
          expect(prepared.read()).toBeUndefined();
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(prepared.read()).toBeDefined();
      expect(database.prepare("SELECT id FROM original ORDER BY id").all()).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
    } finally {
      prepared.release();
    }
    expect(prepared.read()).toBeUndefined();
  });

  it.each(["commit", "rollback", "savepoint rollback", "nested rollback", "temp"])(
    "predicts the committed data and schema generation after %s",
    (outcome) => {
      const database = openDatabase(
        undefined,
        true,
        path.join(tempDirs.make("write-receipt-"), "state.sqlite"),
      );
      readSqliteDatabaseScopedWriteToken(database, "entry");
      let pending: string | undefined;
      const transact = () =>
        runSqliteImmediateTransactionSync(database, () => {
          if (outcome === "savepoint rollback") {
            database.exec("SAVEPOINT repair");
          }
          if (outcome === "nested rollback") {
            expect(() =>
              runSqliteImmediateTransactionSync(database, () => {
                database.exec("CREATE TABLE added(id INTEGER)");
                throw new Error("synthetic nested rollback");
              }),
            ).toThrow("synthetic nested rollback");
          } else {
            database.exec(`CREATE ${outcome === "temp" ? "TEMP " : ""}TABLE added(id INTEGER)`);
          }
          if (outcome === "savepoint rollback") {
            database.exec("ROLLBACK TO repair; RELEASE repair");
          }
          withSqliteDatabaseWriteScope(database, ["entry"], () => {
            database.exec("INSERT INTO original VALUES (1)");
          });
          pending = readSqliteDatabasePendingScopedWriteToken(database, "entry");
          if (outcome === "rollback") {
            throw new Error("synthetic rollback");
          }
        });
      if (outcome === "rollback") {
        expect(transact).toThrow("synthetic rollback");
      } else {
        transact();
      }
      expect(pending).toBeDefined();
      expect(readSqliteDatabaseScopedWriteToken(database, "entry") === pending).toBe(
        outcome !== "rollback",
      );
      if (outcome !== "rollback") {
        using sibling = openDatabase("", true, database.location()!);
        withSqliteDatabaseWriteScope(sibling, ["entry"], () => {
          sibling.exec("INSERT INTO original VALUES (2)");
        });
        expect(readSqliteDatabaseScopedWriteToken(database, "entry")).not.toBe(pending);
      }
    },
  );

  it.each([
    ["preparation", "preparation rejected"],
    ["reentrant", "must execute exactly one data statement"],
    ["constraint", "UNIQUE constraint failed"],
    ["full", "Prepared SQLite mutation outcome is unknown"],
  ])("retains receipts only for definite no-effect prepared failures: %s", (failure, message) => {
    const database = openDatabase(
      "CREATE TABLE original(id INTEGER PRIMARY KEY, value BLOB); INSERT INTO original VALUES(1, NULL); PRAGMA max_page_count=3",
    );
    const before = readSqliteDatabaseScopedWriteToken(database, "entry");
    const statement = database.prepare("INSERT INTO original VALUES (?, zeroblob(?))");
    const callbacks = { commit: vi.fn(), rollback: vi.fn(), invalidate: vi.fn() };
    const mutate = vi.fn(() =>
      withSqlitePostCommitPublications(database, () =>
        withSqliteDatabaseWriteScope(database, ["entry"], () =>
          withSqlitePreparedNativeMutation(
            database,
            () => {
              stageSqliteTransactionState(database, callbacks);
              if (failure === "preparation") {
                throw new Error("preparation rejected");
              }
              if (failure === "reentrant") {
                statement.run(3, 0);
              }
            },
            () => statement.run(failure === "constraint" ? 1 : 2, failure === "full" ? 65536 : 0),
          ),
        ),
      ),
    );
    expect(mutate).toThrow(message);
    const observedError: unknown = mutate.mock.results[0]?.value;
    expect(callbacks.commit).not.toHaveBeenCalled();
    expect(callbacks.rollback.mock.calls.length > 0).toBe(failure !== "full");
    expect(callbacks.invalidate.mock.calls.length > 0).toBe(failure === "full");
    expect(hasSqliteWorkerOutcomeUnknown(observedError)).toBe(failure === "full");
    if (failure === "full") {
      expect(observedError).toMatchObject({ cause: { message: "database or disk is full" } });
    }
    expect(database.prepare("SELECT id FROM original").all()).toEqual([{ id: 1 }]);
    const after = readSqliteDatabaseScopedWriteToken(database, "entry");
    expect(after === before).toBe(failure !== "full");
    withSqliteDatabaseWriteScope(database, ["entry"], () => statement.run(2, 0));
    expect(readSqliteDatabaseScopedWriteToken(database, "entry")).not.toBe(after);
  });

  it("isolates scoped receipts while raw writes and native callbacks revoke incomplete coverage", () => {
    const database = openDatabase();
    const first = readSqliteDatabaseScopedWriteToken(database, "first");
    const second = readSqliteDatabaseScopedWriteToken(database, "second");
    let pending: string | undefined;
    withSqlitePostCommitPublications(database, () =>
      runSqliteImmediateTransactionSync(database, () =>
        withSqliteDatabaseWriteScope(database, ["second"], () => {
          database.exec("INSERT INTO original VALUES (2)");
          pending = readSqliteDatabasePendingScopedWriteToken(database, "second");
        }),
      ),
    );
    expect(readSqliteDatabaseScopedWriteToken(database, "first")).toBe(first);
    expect(readSqliteDatabaseScopedWriteToken(database, "second")).toBe(pending);
    expect(pending).not.toBe(second);

    database.function("uncovered_write", () => {
      database.exec("INSERT INTO original VALUES (1)");
      return 1;
    });
    withSqliteDatabaseWriteScope(database, ["second"], () =>
      database.prepare("SELECT uncovered_write()").get(),
    );
    expect(readSqliteDatabaseScopedWriteToken(database, "first")).not.toBe(first);
    const afterCallback = readSqliteDatabaseScopedWriteToken(database, "second");
    expect(afterCallback).not.toBe(pending);

    database.exec("INSERT INTO original VALUES (3)");
    expect(readSqliteDatabaseScopedWriteToken(database, "second")).not.toBe(afterCallback);
  });
});
