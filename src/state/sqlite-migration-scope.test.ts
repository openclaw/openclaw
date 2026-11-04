import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

function createFixture(setup = "") {
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
  database.exec(setup);
  return database;
}

async function migrate(sql: string, declared = ["changed", "schema_meta"], setup = "") {
  using database = createFixture(setup);
  return await assertSqliteMigrationScopePreserved(database, declared, () => database.exec(sql));
}

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

type ScopeCase = { sql: string; declared?: string[]; setup?: string; error?: string };
const contentError = "retained: content changed";
it.each`
  name                        | sql                                                                                                | declared                          | setup                                                                         | error
  ${"Unicode names"}          | ${"CREATE INDEX keyed_value ON keyed(value)"}                                                      | ${["keyed"]}                      | ${"CREATE TABLE Keyed (value TEXT)"}                                          | ${undefined}
  ${"integer precision"}      | ${"UPDATE retained SET value = 9223372036854775806 WHERE rowid = 2"}                               | ${undefined}                      | ${undefined}                                                                  | ${contentError}
  ${"storage class"}          | ${"UPDATE retained SET value = 1 WHERE rowid = 4"}                                                 | ${undefined}                      | ${undefined}                                                                  | ${contentError}
  ${"real precision"}         | ${"UPDATE retained SET value = 1.5000000000000002 WHERE rowid = 3"}                                | ${undefined}                      | ${undefined}                                                                  | ${contentError}
  ${"BLOB bytes"}             | ${"UPDATE retained SET value = X'00FE' WHERE rowid = 5"}                                           | ${undefined}                      | ${undefined}                                                                  | ${contentError}
  ${"implicit rowid"}         | ${"UPDATE retained SET rowid = 7 WHERE rowid = 1"}                                                 | ${undefined}                      | ${undefined}                                                                  | ${contentError}
  ${"embedded NUL text"}      | ${"UPDATE retained SET value = 'before' || char(0) || 'changed' WHERE rowid = 6"}                  | ${undefined}                      | ${undefined}                                                                  | ${contentError}
  ${"deleted row"}            | ${"DELETE FROM retained WHERE rowid = 1"}                                                          | ${undefined}                      | ${undefined}                                                                  | ${contentError}
  ${"new row"}                | ${"INSERT INTO retained VALUES (NULL)"}                                                            | ${undefined}                      | ${undefined}                                                                  | ${contentError}
  ${"mixed-case trigger DDL"} | ${"CREATE TRIGGER retained_update AFTER UPDATE ON ReTaInEd BEGIN SELECT 1; END"}                   | ${["changed"]}                    | ${undefined}                                                                  | ${"retained: schema changed"}
  ${"created view"}           | ${"CREATE VIEW unexpected_view AS SELECT value FROM changed"}                                      | ${["changed", "unexpected_view"]} | ${undefined}                                                                  | ${"unexpected_view: created"}
  ${"removed view"}           | ${"DROP VIEW retained_view"}                                                                       | ${["changed", "retained_view"]}   | ${undefined}                                                                  | ${"retained_view: removed"}
  ${"changed view"}           | ${"DROP VIEW retained_view; CREATE VIEW retained_view AS SELECT id FROM changed"}                  | ${["changed", "retained_view"]}   | ${undefined}                                                                  | ${"retained_view: schema changed"}
  ${"view trigger"}           | ${"CREATE TRIGGER view_delete INSTEAD OF DELETE ON retained_view BEGIN DELETE FROM retained; END"} | ${["changed", "retained_view"]}   | ${undefined}                                                                  | ${"retained_view: schema changed"}
  ${"hidden rowid aliases"}   | ${""}                                                                                              | ${["changed"]}                    | ${"CREATE TABLE hidden_identity (rowid TEXT, _rowid_ TEXT, oid TEXT) STRICT"} | ${"hidden_identity hides every implicit rowid alias"}
`("migration scope: $name", async ({ sql, declared, setup, error }: ScopeCase) => {
  const result = migrate(sql, declared, setup);
  if (error) {
    await expect(result).rejects.toThrow(error);
  } else {
    await expect(result).resolves.toBeUndefined();
  }
});
