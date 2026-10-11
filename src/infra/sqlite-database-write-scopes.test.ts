import { describe, expect, it } from "vitest";
import {
  readSqliteDatabaseScopedWriteToken,
  readSqliteDatabasePendingScopedWriteToken,
  withSqliteDatabaseWriteScope,
} from "./sqlite-database-admission.js";
import { withSqlitePostCommitPublications } from "./sqlite-post-commit.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

describe("scoped SQLite write receipts", () => {
  const { openDatabase } = useSqliteSchemaTestFixture();

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
