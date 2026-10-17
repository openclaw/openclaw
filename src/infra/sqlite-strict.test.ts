import { describe, expect, it } from "vitest";
import { readSqliteSchemaCatalog } from "../../scripts/lib/sqlite-schema-catalog.mts";
import { DAEMON_RUNTIME_PIN_SCHEMA_SQL } from "../daemon/runtime-pin-schema.js";
import { DEPLOYED_FTS_ROWS_SCHEMA } from "../state/openclaw-agent-transcript-fts-schema-source.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  migrateSqliteSchemaToStrict as migrate,
  withSqliteForeignKeysDisabled,
} from "./sqlite-strict.js";

const unchanged = { migratedTables: [] };

function createDatabase(schema = ""): import("node:sqlite").DatabaseSync {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(":memory:");
  database.exec(schema);
  return database;
}

function query(database: import("node:sqlite").DatabaseSync, sql: string) {
  return database.prepare(sql).get();
}

function rows(database: import("node:sqlite").DatabaseSync, sql: string) {
  return database.prepare(sql).all();
}

function schemaObjects(database: import("node:sqlite").DatabaseSync, names: string[]) {
  return database
    .prepare(
      `SELECT type, name FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY type`,
    )
    .all(...names);
}

function strictSchema(schema: string) {
  return schema
    .replace(/CREATE TABLE /g, "CREATE TABLE IF NOT EXISTS ")
    .replace(/\);/g, ") STRICT;");
}

function strictFlags(database: import("node:sqlite").DatabaseSync, ...tables: string[]) {
  const statement = database.prepare(
    "SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = ?",
  );
  return tables.map((table) => statement.get(table)?.strict ?? -1);
}

function catalogMigrationOptions(schemaSql: string, useCatalog: boolean) {
  if (!useCatalog) {
    return {};
  }
  using database = createDatabase(schemaSql);
  return { expectedSchema: readSqliteSchemaCatalog(database) };
}

type RejectedSchema = Record<"table" | "before" | "after" | "error", string>;

describe("withSqliteForeignKeysDisabled", () => {
  it.each([0, 1])("restores previous enforcement %i after success and failure", (enabled) => {
    using database = createDatabase(`PRAGMA foreign_keys = ${enabled};`);
    const operation = () => {
      expect(query(database, "PRAGMA foreign_keys")).toEqual({ foreign_keys: 0 });
      return 42;
    };
    expect(withSqliteForeignKeysDisabled(database, operation)).toBe(42);
    expect(query(database, "PRAGMA foreign_keys")).toEqual({ foreign_keys: enabled });
    expect(() =>
      withSqliteForeignKeysDisabled(database, () => {
        operation();
        throw new Error("staging failed");
      }),
    ).toThrow("staging failed");
    expect(query(database, "PRAGMA foreign_keys")).toEqual({ foreign_keys: enabled });
  });

  it("rejects an active transaction before invoking the callback", () => {
    using database = createDatabase("PRAGMA foreign_keys = ON; BEGIN;");
    let called = false;
    expect(() => withSqliteForeignKeysDisabled(database, () => (called = true))).toThrow(
      "cannot change inside a transaction",
    );
    expect(called).toBe(false);
    expect(query(database, "PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
    database.exec("ROLLBACK;");
  });

  it("rejects asynchronous work and restores enforcement", () => {
    using database = createDatabase("PRAGMA foreign_keys = ON;");
    expect(() => withSqliteForeignKeysDisabled(database, async () => 42)).toThrow(
      "must be synchronous",
    );
    expect(query(database, "PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
  });
});

describe("migrateSqliteSchemaToStrict", () => {
  it("atomically rebuilds related tables and preserves their rows", () => {
    const database = createDatabase();
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
        score INTEGER NOT NULL
      );
      INSERT INTO parents (id, name) VALUES (1, 'parent');
      INSERT INTO children (id, parent_id, score) VALUES (2, 1, 3);
    `);

    const result = migrate(
      database,
      `
        CREATE TABLE IF NOT EXISTS parents (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
          score INTEGER NOT NULL
        ) STRICT;
      `,
      { databaseLabel: "test.sqlite" },
    );

    expect(result.migratedTables).toEqual(["children", "parents"]);
    expect(strictFlags(database, "parents", "children")).toEqual([1, 1]);
    expect(database.prepare("SELECT * FROM parents").all()).toEqual([{ id: 1, name: "parent" }]);
    expect(database.prepare("SELECT * FROM children").all()).toEqual([
      { id: 2, parent_id: 1, score: 3 },
    ]);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("keeps database-local indexes and triggers", () => {
    using database = createDatabase(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE item_audit (item_id INTEGER NOT NULL, action TEXT NOT NULL);
      CREATE UNIQUE INDEX items_name_custom ON items(name);
      CREATE TRIGGER items_insert_custom AFTER INSERT ON items BEGIN
        INSERT INTO item_audit (item_id, action) VALUES (NEW.id, 'insert');
      END;
      INSERT INTO items (id, name) VALUES (1, 'first');
    `);

    migrate(
      database,
      `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;`,
    );
    database.prepare("INSERT INTO items (id, name) VALUES (?, ?)").run(2, "second");

    expect(schemaObjects(database, ["items_name_custom", "items_insert_custom"])).toEqual([
      { type: "index", name: "items_name_custom" },
      { type: "trigger", name: "items_insert_custom" },
    ]);
    expect(rows(database, "SELECT * FROM item_audit ORDER BY item_id")).toEqual([
      { item_id: 1, action: "insert" },
      { item_id: 2, action: "insert" },
    ]);
  });

  it("preserves cross-table triggers and views while their target is rebuilt", () => {
    const schema = `
      CREATE TABLE counters (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL);
    `;
    using database =
      createDatabase(`${schema.replace("amount INTEGER NOT NULL);", "amount INTEGER NOT NULL) STRICT;")}
      INSERT INTO counters (id, value) VALUES (1, 0);
      CREATE VIEW counter_totals AS SELECT id, value FROM counters;
      CREATE TRIGGER events_update_counter AFTER INSERT ON events BEGIN
        UPDATE counters SET value = value + NEW.amount WHERE id = 1;
      END;
    `);

    migrate(database, strictSchema(schema));
    database.prepare("INSERT INTO events (id, amount) VALUES (?, ?)").run(1, 7);

    expect(rows(database, "SELECT * FROM counter_totals")).toEqual([{ id: 1, value: 7 }]);
    expect(schemaObjects(database, ["counter_totals", "events_update_counter"])).toEqual([
      { type: "trigger", name: "events_update_counter" },
      { type: "view", name: "counter_totals" },
    ]);
  });

  it.each([false, true])("preserves AUTOINCREMENT high-water marks (catalog=%s)", (useCatalog) => {
    using database = createDatabase(`
      CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      INSERT INTO entries (value) VALUES ('first'), ('second'), ('third');
      DELETE FROM entries WHERE id = 3;
      UPDATE sqlite_sequence SET seq = 40.0 WHERE name = 'entries';
    `);

    const schema =
      "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL) STRICT;";
    migrate(database, schema, catalogMigrationOptions(schema, useCatalog));
    database.prepare("INSERT INTO entries (value) VALUES (?)").run("fourth");

    expect(rows(database, "SELECT id, value FROM entries ORDER BY id")).toEqual([
      { id: 1, value: "first" },
      { id: 2, value: "second" },
      { id: 41, value: "fourth" },
    ]);
  });

  it.each([false, true])(
    "preserves row identities across table shapes (catalog=%s)",
    (useCatalog) => {
      const schema = `
        CREATE TABLE implicit_items (value TEXT NOT NULL);
        CREATE TABLE composite_items (left_key TEXT NOT NULL, right_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (left_key, right_key));
        CREATE TABLE shadowed_items (rowid TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE integer_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE without_items (id TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      `;
      using database = createDatabase(
        schema +
          `
        INSERT INTO implicit_items (rowid, value) VALUES (100, 'implicit');
        INSERT INTO composite_items (rowid, left_key, right_key, value) VALUES (200, 'left', 'right', 'composite');
        INSERT INTO shadowed_items (_rowid_, rowid, value) VALUES (300, 'named', 'shadowed');
        INSERT INTO integer_items (id, value) VALUES (400, 'integer-primary-key');
        INSERT INTO without_items (id, value) VALUES ('without', 'without-rowid');
      `,
      );
      const strict = strictSchema(schema).replace(") WITHOUT ROWID;", ") STRICT, WITHOUT ROWID;");
      migrate(database, strict, catalogMigrationOptions(strict, useCatalog));

      expect({
        implicit: query(database, "SELECT rowid, value FROM implicit_items"),
        composite: query(database, "SELECT rowid, value FROM composite_items"),
        shadowed: query(
          database,
          "SELECT _rowid_ AS hidden_rowid, rowid, value FROM shadowed_items",
        ),
        integer: query(database, "SELECT rowid AS stored_rowid, id, value FROM integer_items"),
        without: query(database, "SELECT id, value FROM without_items"),
      }).toEqual({
        implicit: { rowid: 100, value: "implicit" },
        composite: { rowid: 200, value: "composite" },
        shadowed: { hidden_rowid: 300, rowid: "named", value: "shadowed" },
        integer: { stored_rowid: 400, id: 400, value: "integer-primary-key" },
        without: { id: "without", value: "without-rowid" },
      });
    },
  );

  it.each`
    name                    | table        | before                                        | after                                            | error
    ${"rowid aliases"}      | ${"aliases"} | ${"rowid TEXT, _rowid_ TEXT, oid TEXT"}       | ${"rowid TEXT, _rowid_ TEXT, oid TEXT"}          | ${"shadows every rowid alias"}
    ${"rowid model change"} | ${"entries"} | ${"id TEXT PRIMARY KEY, value TEXT NOT NULL"} | ${"id INTEGER PRIMARY KEY, value TEXT NOT NULL"} | ${"changes rowid storage from implicit to integer-primary-key"}
    ${"column drift"}       | ${"entries"} | ${"id TEXT PRIMARY KEY, obsolete TEXT"}       | ${"id TEXT PRIMARY KEY, current TEXT"}           | ${"SQLite table entries does not match its canonical columns"}
  `("rejects $name", ({ table, before, after, error }: RejectedSchema) => {
    using database = createDatabase(`CREATE TABLE ${table} (${before});`);
    expect(() =>
      migrate(database, `CREATE TABLE IF NOT EXISTS ${table} (${after}) STRICT;`),
    ).toThrow(error);
    expect(strictFlags(database, table)).toEqual([0]);
    if (before.includes("obsolete")) {
      expect(rows(database, "SELECT name FROM pragma_table_info('entries') ORDER BY cid")).toEqual([
        { name: "id" },
        { name: "obsolete" },
      ]);
    }
  });

  it.each([false, true])("rolls back a canonical type violation (catalog=%s)", (useCatalog) => {
    using database = createDatabase(
      "PRAGMA foreign_keys = ON; CREATE TABLE counters (id TEXT, value TEXT);",
    );
    database.prepare("INSERT INTO counters (id, value) VALUES (?, ?)").run("one", "not-a-number");

    const schema = "CREATE TABLE IF NOT EXISTS counters (id TEXT, value INTEGER NOT NULL) STRICT;";
    expect(() => migrate(database, schema, catalogMigrationOptions(schema, useCatalog))).toThrow(
      "Failed migrating SQLite table counters to STRICT",
    );

    expect(strictFlags(database, "counters")).toEqual([0]);
    expect(query(database, "SELECT id, value FROM counters")).toEqual({
      id: "one",
      value: "not-a-number",
    });
    expect(query(database, "PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
  });

  it("rolls back when existing rows violate a foreign key", () => {
    const schema = `
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id));
    `;
    using database = createDatabase(`PRAGMA foreign_keys = OFF; ${schema}
      INSERT INTO children (id, parent_id) VALUES (1, 99);
      PRAGMA foreign_keys = ON;
    `);

    expect(() => migrate(database, strictSchema(schema))).toThrow("foreign_key_check failed");

    expect(strictFlags(database, "parents", "children")).toEqual([0, 0]);
    expect(query(database, "SELECT * FROM children")).toEqual({ id: 1, parent_id: 99 });
  });

  it("rejects canonical schemas that still contain non-STRICT tables", () => {
    using database = createDatabase();

    expect(() =>
      migrate(database, "CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY);"),
    ).toThrow("Canonical SQLite schema contains non-STRICT tables: entries");
    expect(rows(database, "PRAGMA table_list")).not.toContainEqual(
      expect.objectContaining({ name: "entries" }),
    );
  });

  it("ignores virtual tables while migrating ordinary tables", () => {
    using database = createDatabase(`
      CREATE TABLE documents (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE VIRTUAL TABLE documents_fts USING fts5(body);
      INSERT INTO documents (id, body) VALUES (1, 'hello');
      INSERT INTO documents_fts (rowid, body) VALUES (1, 'hello');
    `);

    const result = migrate(
      database,
      `
        CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(body);
      `,
    );

    expect(result.migratedTables).toEqual(["documents"]);
    expect(strictFlags(database, "documents")).toEqual([1]);
    expect(rows(database, "SELECT rowid, body FROM documents_fts")).toEqual([
      { rowid: 1, body: "hello" },
    ]);
  });

  it("is idempotent once every canonical table is STRICT", () => {
    using database = createDatabase();
    const schema = "CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, value BLOB) STRICT;";
    database.exec(schema);
    database.exec("INSERT INTO entries (id, value) VALUES ('one', NULL);");

    expect(migrate(database, schema)).toEqual(unchanged);
    expect(query(database, "SELECT id, value FROM entries")).toEqual({
      id: "one",
      value: null,
    });
  });

  it("installs a generated schema once and retains data on readmission", () => {
    using database = createDatabase();
    const options = { expectedSchema: DAEMON_RUNTIME_PIN_SCHEMA_SQL };
    expect(migrate(database, DAEMON_RUNTIME_PIN_SCHEMA_SQL, options)).toEqual(unchanged);
    database
      .prepare("INSERT INTO daemon_runtime_pins VALUES (?, ?, ?)")
      .run("runtime", '{"version":"synthetic"}', 123);
    expect(migrate(database, DAEMON_RUNTIME_PIN_SCHEMA_SQL, options)).toEqual(unchanged);
    expect(rows(database, "SELECT * FROM daemon_runtime_pins")).toEqual([
      { state_key: "runtime", value_json: '{"version":"synthetic"}', updated_at_ms: 123 },
    ]);
  });

  it("repairs generated-schema indexes when the caller does not own object creation", () => {
    using database = createDatabase();
    database.exec(DEPLOYED_FTS_ROWS_SCHEMA);
    database.exec("DROP INDEX idx_agent_transcript_fts_rows_session;");
    expect(migrate(database, DEPLOYED_FTS_ROWS_SCHEMA)).toEqual(unchanged);
    expect(rows(database, "PRAGMA index_list(session_transcript_fts_rows)")).toContainEqual(
      expect.objectContaining({ name: "idx_agent_transcript_fts_rows_session" }),
    );
  });

  it("creates missing catalog tables while preserving existing rows during migration", () => {
    using database = createDatabase(
      "CREATE TABLE entries (id INTEGER PRIMARY KEY); INSERT INTO entries VALUES (7);",
    );
    const schema = `
      CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE IF NOT EXISTS added (value TEXT) STRICT;
    `;
    expect(migrate(database, schema, catalogMigrationOptions(schema, true))).toEqual({
      migratedTables: ["entries"],
    });
    expect(strictFlags(database, "entries", "added")).toEqual([1, 1]);
    expect(rows(database, "SELECT * FROM entries")).toEqual([{ id: 7 }]);
  });
});
