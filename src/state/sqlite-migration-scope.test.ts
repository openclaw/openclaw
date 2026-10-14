import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

function createFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE changed (id INTEGER PRIMARY KEY, value TEXT) STRICT;
    CREATE TABLE schema_meta (version INTEGER NOT NULL) STRICT;
    CREATE TABLE retained (value ANY) STRICT;
    CREATE TABLE keyed (id TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID, STRICT;
    CREATE INDEX retained_value ON retained(value);
    CREATE VIEW retained_view AS SELECT value FROM retained;
    CREATE TRIGGER retained_after_insert AFTER INSERT ON retained BEGIN SELECT 1; END;
    INSERT INTO changed VALUES (1, 'before');
    INSERT INTO schema_meta VALUES (26);
    INSERT INTO retained(rowid, value) VALUES
      (1, NULL), (2, 9223372036854775807), (3, 1.5), (4, '1'), (5, X'00FF');
    INSERT INTO keyed VALUES ('key', X'000102');
  `);
  database.prepare("INSERT INTO retained(rowid, value) VALUES (6, ?)").run("before\0after");
  return database;
}

describe("declared SQLite migration scope", () => {
  it("does not conflate a declared table with an undeclared Unicode name", async () => {
    using database = createFixture();
    database.exec("CREATE TABLE Keyed (value TEXT)");
    await expect(
      assertSqliteMigrationScopePreserved(database, ["keyed"], () =>
        database.exec("CREATE INDEX keyed_value ON keyed(value)"),
      ),
    ).resolves.toBeUndefined();
  });

  it("allows declared table rewrites and explicit metadata changes while preserving all other tables", async () => {
    using database = createFixture();
    const result = await assertSqliteMigrationScopePreserved(
      database,
      ["changed", "schema_meta", "new_table"],
      async () => {
        await Promise.resolve();
        database.exec(`
          ALTER TABLE changed ADD COLUMN extra TEXT;
          UPDATE changed SET value = 'after';
          UPDATE schema_meta SET version = 27;
          CREATE TABLE new_table (id INTEGER PRIMARY KEY) STRICT;
        `);
        return "migrated";
      },
    );
    expect(result).toBe("migrated");
  });

  it.each([
    ["integer precision", "UPDATE retained SET value = 9223372036854775806 WHERE rowid = 2"],
    ["storage class", "UPDATE retained SET value = 1 WHERE rowid = 4"],
    ["real precision", "UPDATE retained SET value = 1.5000000000000002 WHERE rowid = 3"],
    ["BLOB bytes", "UPDATE retained SET value = X'00FE' WHERE rowid = 5"],
    ["implicit rowid", "UPDATE retained SET rowid = 7 WHERE rowid = 1"],
    [
      "embedded NUL text",
      "UPDATE retained SET value = 'before' || char(0) || 'changed' WHERE rowid = 6",
    ],
    ["deleted row", "DELETE FROM retained WHERE rowid = 1"],
    ["new row", "INSERT INTO retained VALUES (NULL)"],
  ])("rejects an undeclared %s change", async (_kind, mutation) => {
    using database = createFixture();
    await expect(
      assertSqliteMigrationScopePreserved(database, ["changed", "schema_meta"], () => {
        database.exec(mutation);
      }),
    ).rejects.toThrow("retained: content changed");
  });

  it.each([
    ["table DDL", "ALTER TABLE retained ADD COLUMN extra TEXT"],
    ["index DDL", "DROP INDEX retained_value; CREATE INDEX retained_value ON retained(value DESC)"],
    ["trigger DDL", "DROP TRIGGER retained_after_insert"],
    [
      "mixed-case trigger DDL",
      "CREATE TRIGGER retained_update AFTER UPDATE ON ReTaInEd BEGIN SELECT 1; END",
    ],
  ])("rejects undeclared %s changes", async (_kind, mutation) => {
    using database = createFixture();
    await expect(
      assertSqliteMigrationScopePreserved(database, ["changed"], () => database.exec(mutation)),
    ).rejects.toThrow("retained: schema changed");
  });

  it.each([
    ["created", "CREATE TABLE unexpected (id INTEGER PRIMARY KEY) STRICT", "unexpected"],
    ["removed", "DROP TABLE keyed", "keyed"],
    ["content changed", "UPDATE keyed SET value = X'030201'", "keyed"],
    ["content changed", "UPDATE schema_meta SET version = 27", "schema_meta"],
  ])("rejects an undeclared table that is %s (%s)", async (change, mutation, table) => {
    using database = createFixture();
    await expect(
      assertSqliteMigrationScopePreserved(database, ["changed"], () => database.exec(mutation)),
    ).rejects.toThrow(`${table}: ${change}`);
  });

  it("detects trigger side effects from a declared table into an undeclared table", async () => {
    using database = createFixture();
    database.exec(`CREATE TRIGGER changed_after_update AFTER UPDATE ON changed BEGIN
      INSERT INTO retained(value) VALUES (NEW.value);
    END;`);
    await expect(
      assertSqliteMigrationScopePreserved(database, ["changed"], () => {
        database.exec("UPDATE changed SET value = 'side effect'");
      }),
    ).rejects.toThrow("retained: content changed");
  });

  it.each([
    ["created", "CREATE VIEW unexpected_view AS SELECT value FROM changed", "unexpected_view"],
    ["removed", "DROP VIEW retained_view", "retained_view"],
    [
      "schema changed",
      "DROP VIEW retained_view; CREATE VIEW retained_view AS SELECT id FROM changed",
      "retained_view",
    ],
    [
      "schema changed",
      "CREATE TRIGGER view_delete INSTEAD OF DELETE ON retained_view BEGIN DELETE FROM retained; END",
      "retained_view",
    ],
  ])("rejects a view that is %s (%s)", async (change, mutation, view) => {
    using database = createFixture();
    await expect(
      assertSqliteMigrationScopePreserved(database, ["changed", view], () =>
        database.exec(mutation),
      ),
    ).rejects.toThrow(`${view}: ${change}`);
  });

  it("retains the original migration failure", async () => {
    using database = createFixture();
    const failure = new Error("migration failed");
    await expect(
      assertSqliteMigrationScopePreserved(database, ["changed"], () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("does not exempt SQLite sequence state from the declared scope", async () => {
    using database = createFixture();
    database.exec("CREATE TABLE sequenced (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT");
    await expect(
      assertSqliteMigrationScopePreserved(database, ["sequenced"], () => {
        database.exec("INSERT INTO sequenced DEFAULT VALUES");
      }),
    ).rejects.toThrow("sqlite_sequence: content changed");
  });

  it("refuses proof when every implicit rowid alias is hidden", async () => {
    using database = createFixture();
    database.exec("CREATE TABLE hidden_identity (rowid TEXT, _rowid_ TEXT, oid TEXT) STRICT");
    await expect(
      assertSqliteMigrationScopePreserved(database, ["changed"], () => undefined),
    ).rejects.toThrow("hidden_identity hides every implicit rowid alias");
  });
});
