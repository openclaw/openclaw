import { describe, expect, it } from "vitest";
import {
  readSqliteDatabaseScopedWriteToken,
  readSqliteDatabasePendingScopedWriteToken,
  withSqliteDatabaseWriteScope,
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
  const { openDatabase } = useSqliteSchemaTestFixture();

  it.each(["preparation", "reentrant", "constraint", "full"] as const)(
    "retains receipts only for definite no-effect prepared failures: %s",
    (failure) => {
      const database = openDatabase(
        "CREATE TABLE original(id INTEGER PRIMARY KEY, value BLOB); INSERT INTO original VALUES(1, NULL); PRAGMA max_page_count=3",
      );
      const before = readSqliteDatabaseScopedWriteToken(database, "entry");
      const statement = database.prepare("INSERT INTO original VALUES (?, zeroblob(?))");
      let installed = false;
      let rolledBack = false;
      let invalidated = false;
      let observedError: unknown;
      expect(() => {
        try {
          withSqlitePostCommitPublications(database, () =>
            withSqliteDatabaseWriteScope(database, ["entry"], () =>
              withSqlitePreparedNativeMutation(
                database,
                () => {
                  stageSqliteTransactionState(database, {
                    commit: () => {
                      installed = true;
                    },
                    rollback: () => {
                      rolledBack = true;
                    },
                    invalidate: () => {
                      invalidated = true;
                    },
                  });
                  if (failure === "preparation") {
                    throw new Error("preparation rejected");
                  }
                  if (failure === "reentrant") {
                    statement.run(3, 0);
                  }
                },
                () =>
                  statement.run(failure === "constraint" ? 1 : 2, failure === "full" ? 65536 : 0),
              ),
            ),
          );
        } catch (error) {
          observedError = error;
          throw error;
        }
      }).toThrow(
        failure === "preparation"
          ? "preparation rejected"
          : failure === "reentrant"
            ? "must execute exactly one data statement"
            : failure === "constraint"
              ? "UNIQUE constraint failed"
              : "Prepared SQLite mutation outcome is unknown",
      );
      expect(installed).toBe(false);
      expect(rolledBack).toBe(failure !== "full");
      expect(invalidated).toBe(failure === "full");
      expect(hasSqliteWorkerOutcomeUnknown(observedError)).toBe(failure === "full");
      if (failure === "full") {
        expect(observedError).toMatchObject({ cause: { message: "database or disk is full" } });
      }
      expect(database.prepare("SELECT id FROM original").all()).toEqual([{ id: 1 }]);
      const after = readSqliteDatabaseScopedWriteToken(database, "entry");
      if (failure === "full") {
        expect(after).not.toBe(before);
      } else {
        expect(after).toBe(before);
      }
      withSqliteDatabaseWriteScope(database, ["entry"], () => statement.run(2, 0));
      expect(readSqliteDatabaseScopedWriteToken(database, "entry")).not.toBe(after);
    },
  );

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
