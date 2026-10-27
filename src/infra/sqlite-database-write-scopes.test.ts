import { describe, expect, it, vi } from "vitest";
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
