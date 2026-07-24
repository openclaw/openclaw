import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateSqliteSchemaToStrict } from "./sqlite-strict.js";

const openDatabases: Array<import("node:sqlite").DatabaseSync> = [];

function createDatabase(): import("node:sqlite").DatabaseSync {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(":memory:");
  openDatabases.push(database);
  return database;
}

function readStrictFlag(database: import("node:sqlite").DatabaseSync, tableName: string): number {
  const row = database
    .prepare("SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = ?")
    .get(tableName) as { strict?: unknown } | undefined;
  return Number(row?.strict ?? -1);
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.isOpen) {
      database.close();
    }
  }
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

    const result = migrateSqliteSchemaToStrict(
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
    expect(readStrictFlag(database, "parents")).toBe(1);
    expect(readStrictFlag(database, "children")).toBe(1);
    expect(database.prepare("SELECT * FROM parents").all()).toEqual([{ id: 1, name: "parent" }]);
    expect(database.prepare("SELECT * FROM children").all()).toEqual([
      { id: 2, parent_id: 1, score: 3 },
    ]);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("keeps database-local indexes and triggers", () => {
    const database = createDatabase();
    database.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE item_audit (item_id INTEGER NOT NULL, action TEXT NOT NULL);
      CREATE UNIQUE INDEX items_name_custom ON items(name);
      CREATE TRIGGER items_insert_custom AFTER INSERT ON items BEGIN
        INSERT INTO item_audit (item_id, action) VALUES (NEW.id, 'insert');
      END;
      INSERT INTO items (id, name) VALUES (1, 'first');
    `);

    migrateSqliteSchemaToStrict(
      database,
      `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;`,
    );
    database.prepare("INSERT INTO items (id, name) VALUES (?, ?)").run(2, "second");

    expect(
      database
        .prepare(
          "SELECT type, name FROM sqlite_schema WHERE name IN ('items_name_custom', 'items_insert_custom') ORDER BY type",
        )
        .all(),
    ).toEqual([
      { type: "index", name: "items_name_custom" },
      { type: "trigger", name: "items_insert_custom" },
    ]);
    expect(database.prepare("SELECT * FROM item_audit ORDER BY item_id").all()).toEqual([
      { item_id: 1, action: "insert" },
      { item_id: 2, action: "insert" },
    ]);
  });

  it("preserves cross-table triggers and views while their target is rebuilt", () => {
    const database = createDatabase();
    database.exec(`
      CREATE TABLE counters (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL) STRICT;
      INSERT INTO counters (id, value) VALUES (1, 0);
      CREATE VIEW counter_totals AS SELECT id, value FROM counters;
      CREATE TRIGGER events_update_counter AFTER INSERT ON events BEGIN
        UPDATE counters SET value = value + NEW.amount WHERE id = 1;
      END;
    `);

    migrateSqliteSchemaToStrict(
      database,
      `
        CREATE TABLE IF NOT EXISTS counters (
          id INTEGER PRIMARY KEY,
          value INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY,
          amount INTEGER NOT NULL
        ) STRICT;
      `,
    );
    database.prepare("INSERT INTO events (id, amount) VALUES (?, ?)").run(1, 7);

    expect(database.prepare("SELECT * FROM counter_totals").all()).toEqual([{ id: 1, value: 7 }]);
    expect(
      database
        .prepare(
          "SELECT type, name FROM sqlite_schema WHERE name IN ('counter_totals', 'events_update_counter') ORDER BY type",
        )
        .all(),
    ).toEqual([
      { type: "trigger", name: "events_update_counter" },
      { type: "view", name: "counter_totals" },
    ]);
  });

  it("preserves AUTOINCREMENT high-water marks", () => {
    const database = createDatabase();
    database.exec(`
      CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      INSERT INTO entries (value) VALUES ('first'), ('second'), ('third');
      DELETE FROM entries WHERE id = 3;
      UPDATE sqlite_sequence SET seq = 40.0 WHERE name = 'entries';
    `);

    migrateSqliteSchemaToStrict(
      database,
      `CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        value TEXT NOT NULL
      ) STRICT;`,
    );
    database.prepare("INSERT INTO entries (value) VALUES (?)").run("fourth");

    expect(database.prepare("SELECT id, value FROM entries ORDER BY id").all()).toEqual([
      { id: 1, value: "first" },
      { id: 2, value: "second" },
      { id: 41, value: "fourth" },
    ]);
  });

  it("preserves implicit and declared row identities across table shapes", () => {
    const database = createDatabase();
    database.exec(`
      CREATE TABLE implicit_items (value TEXT NOT NULL);
      INSERT INTO implicit_items (rowid, value) VALUES (100, 'implicit');

      CREATE TABLE composite_items (
        left_key TEXT NOT NULL,
        right_key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (left_key, right_key)
      );
      INSERT INTO composite_items (rowid, left_key, right_key, value)
      VALUES (200, 'left', 'right', 'composite');

      CREATE TABLE shadowed_items (rowid TEXT NOT NULL, value TEXT NOT NULL);
      INSERT INTO shadowed_items (_rowid_, rowid, value) VALUES (300, 'named', 'shadowed');

      CREATE TABLE integer_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO integer_items (id, value) VALUES (400, 'integer-primary-key');

      CREATE TABLE without_items (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO without_items (id, value) VALUES ('without', 'without-rowid');
    `);

    migrateSqliteSchemaToStrict(
      database,
      `
        CREATE TABLE IF NOT EXISTS implicit_items (value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS composite_items (
          left_key TEXT NOT NULL,
          right_key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (left_key, right_key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS shadowed_items (
          rowid TEXT NOT NULL,
          value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS integer_items (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS without_items (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT, WITHOUT ROWID;
      `,
    );

    expect(database.prepare("SELECT rowid, value FROM implicit_items").get()).toEqual({
      rowid: 100,
      value: "implicit",
    });
    expect(database.prepare("SELECT rowid, value FROM composite_items").get()).toEqual({
      rowid: 200,
      value: "composite",
    });
    expect(
      database.prepare("SELECT _rowid_ AS hidden_rowid, rowid, value FROM shadowed_items").get(),
    ).toEqual({ hidden_rowid: 300, rowid: "named", value: "shadowed" });
    expect(
      database.prepare("SELECT rowid AS stored_rowid, id, value FROM integer_items").get(),
    ).toEqual({
      stored_rowid: 400,
      id: 400,
      value: "integer-primary-key",
    });
    expect(database.prepare("SELECT id, value FROM without_items").get()).toEqual({
      id: "without",
      value: "without-rowid",
    });
  });

  it("rejects implicit-rowid tables that shadow every usable alias", () => {
    const database = createDatabase();
    database.exec("CREATE TABLE aliases (rowid TEXT, _rowid_ TEXT, oid TEXT);");

    expect(() =>
      migrateSqliteSchemaToStrict(
        database,
        "CREATE TABLE IF NOT EXISTS aliases (rowid TEXT, _rowid_ TEXT, oid TEXT) STRICT;",
      ),
    ).toThrow("shadows every rowid alias");
    expect(readStrictFlag(database, "aliases")).toBe(0);
  });

  it("rejects migrations that change the table rowid model", () => {
    const database = createDatabase();
    database.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL);");

    expect(() =>
      migrateSqliteSchemaToStrict(
        database,
        `CREATE TABLE IF NOT EXISTS entries (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;`,
      ),
    ).toThrow("changes rowid storage from implicit to integer-primary-key");
    expect(readStrictFlag(database, "entries")).toBe(0);
  });

  it("accepts values that SQLite can losslessly coerce", () => {
    const database = createDatabase();
    database.exec("CREATE TABLE counters (id TEXT PRIMARY KEY, value TEXT NOT NULL);");
    database.prepare("INSERT INTO counters (id, value) VALUES (?, ?)").run("one", "42");

    migrateSqliteSchemaToStrict(
      database,
      `CREATE TABLE IF NOT EXISTS counters (
        id TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) STRICT;`,
    );

    expect(
      database.prepare("SELECT id, value, typeof(value) AS value_type FROM counters").get(),
    ).toEqual({ id: "one", value: 42, value_type: "integer" });
  });

  it("rolls back when an existing value violates the canonical type", () => {
    const database = createDatabase();
    database.exec("PRAGMA foreign_keys = ON; CREATE TABLE counters (id TEXT, value TEXT);");
    database.prepare("INSERT INTO counters (id, value) VALUES (?, ?)").run("one", "not-a-number");

    expect(() =>
      migrateSqliteSchemaToStrict(
        database,
        `CREATE TABLE IF NOT EXISTS counters (
          id TEXT,
          value INTEGER NOT NULL
        ) STRICT;`,
      ),
    ).toThrow("Failed migrating SQLite table counters to STRICT");

    expect(readStrictFlag(database, "counters")).toBe(0);
    expect(database.prepare("SELECT id, value FROM counters").get()).toEqual({
      id: "one",
      value: "not-a-number",
    });
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("rolls back when existing rows violate a foreign key", () => {
    const database = createDatabase();
    database.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id));
      INSERT INTO children (id, parent_id) VALUES (1, 99);
      PRAGMA foreign_keys = ON;
    `);

    expect(() =>
      migrateSqliteSchemaToStrict(
        database,
        `
          CREATE TABLE IF NOT EXISTS parents (id INTEGER PRIMARY KEY) STRICT;
          CREATE TABLE IF NOT EXISTS children (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER REFERENCES parents(id)
          ) STRICT;
        `,
      ),
    ).toThrow("foreign_key_check failed");

    expect(readStrictFlag(database, "parents")).toBe(0);
    expect(readStrictFlag(database, "children")).toBe(0);
    expect(database.prepare("SELECT * FROM children").get()).toEqual({ id: 1, parent_id: 99 });
  });

  it("rejects schema drift without changing the existing table", () => {
    const database = createDatabase();
    database.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, obsolete TEXT);");

    expect(() =>
      migrateSqliteSchemaToStrict(
        database,
        `CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY,
          current TEXT
        ) STRICT;`,
      ),
    ).toThrow("SQLite table entries does not match its canonical columns");

    expect(readStrictFlag(database, "entries")).toBe(0);
    expect(
      database.prepare("SELECT name FROM pragma_table_info('entries') ORDER BY cid").all(),
    ).toEqual([{ name: "id" }, { name: "obsolete" }]);
  });

  it("rejects canonical schemas that still contain non-STRICT tables", () => {
    const database = createDatabase();

    expect(() =>
      migrateSqliteSchemaToStrict(
        database,
        "CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY);",
      ),
    ).toThrow("Canonical SQLite schema contains non-STRICT tables: entries");
    expect(database.prepare("PRAGMA table_list").all()).not.toContainEqual(
      expect.objectContaining({ name: "entries" }),
    );
  });

  it("ignores virtual tables while migrating ordinary tables", () => {
    const database = createDatabase();
    database.exec(`
      CREATE TABLE documents (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE VIRTUAL TABLE documents_fts USING fts5(body);
      INSERT INTO documents (id, body) VALUES (1, 'hello');
      INSERT INTO documents_fts (rowid, body) VALUES (1, 'hello');
    `);

    const result = migrateSqliteSchemaToStrict(
      database,
      `
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY,
          body TEXT NOT NULL
        ) STRICT;
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(body);
      `,
    );

    expect(result.migratedTables).toEqual(["documents"]);
    expect(readStrictFlag(database, "documents")).toBe(1);
    expect(database.prepare("SELECT rowid, body FROM documents_fts").all()).toEqual([
      { rowid: 1, body: "hello" },
    ]);
  });

  it("is idempotent once every canonical table is STRICT", () => {
    const database = createDatabase();
    const schema = "CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, value BLOB) STRICT;";
    database.exec(schema);
    database.prepare("INSERT INTO entries (id, value) VALUES (?, ?)").run("one", null);

    expect(migrateSqliteSchemaToStrict(database, schema)).toEqual({ migratedTables: [] });
    expect(database.prepare("SELECT id, value FROM entries").get()).toEqual({
      id: "one",
      value: null,
    });
  });

  it("normalizes BLOB values in TEXT columns during STRICT migration", () => {
    const database = createDatabase();
    database.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO entries (id, value) VALUES (?, ?)").run("key1", "normal-text");
    database
      .prepare("INSERT INTO entries (id, value) VALUES (?, ?)")
      .run("key2", Buffer.from("blob-as-text"));

    migrateSqliteSchemaToStrict(
      database,
      "CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
    );

    expect(readStrictFlag(database, "entries")).toBe(1);
    expect(
      database
        .prepare("SELECT id, typeof(value) AS vtype, value FROM entries WHERE id = 'key1'")
        .get(),
    ).toEqual({ id: "key1", vtype: "text", value: "normal-text" });
    expect(
      database
        .prepare("SELECT id, typeof(value) AS vtype, value FROM entries WHERE id = 'key2'")
        .get(),
    ).toEqual({ id: "key2", vtype: "text", value: "blob-as-text" });
  });

  it("normalizes TEXT values in BLOB columns during STRICT migration", () => {
    const database = createDatabase();
    database.exec("CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL)");
    database.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(1, "text-as-blob");
    database.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(2, Buffer.from("real-blob"));

    migrateSqliteSchemaToStrict(
      database,
      "CREATE TABLE IF NOT EXISTS blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL) STRICT;",
    );

    expect(readStrictFlag(database, "blobs")).toBe(1);
    expect(
      database.prepare("SELECT id, typeof(data) AS dtype FROM blobs ORDER BY id").all(),
    ).toEqual([
      { id: 1, dtype: "blob" },
      { id: 2, dtype: "blob" },
    ]);
  });

  it("normalizes mixed-type rows in TEXT columns without losing values", () => {
    const database = createDatabase();
    database.exec("CREATE TABLE mixed (id INTEGER PRIMARY KEY, name TEXT, note TEXT)");
    database
      .prepare("INSERT INTO mixed (id, name, note) VALUES (?, ?, ?)")
      .run(1, "text-name", "text-note");
    database
      .prepare("INSERT INTO mixed (id, name, note) VALUES (?, ?, ?)")
      .run(2, Buffer.from("blob-name"), null);

    migrateSqliteSchemaToStrict(
      database,
      "CREATE TABLE IF NOT EXISTS mixed (id INTEGER PRIMARY KEY, name TEXT, note TEXT) STRICT;",
    );

    expect(readStrictFlag(database, "mixed")).toBe(1);
    expect(
      database
        .prepare(
          "SELECT id, typeof(name) AS ntype, name, typeof(note) AS nntype, note FROM mixed ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: 1, ntype: "text", name: "text-name", nntype: "text", note: "text-note" },
      { id: 2, ntype: "text", name: "blob-name", nntype: "null", note: null },
    ]);
  });

  it("rejects STRICT migration when BLOB and TEXT primary key rows collide after CAST", () => {
    const database = createDatabase();
    database.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO entries (id, value) VALUES (?, ?)").run("key-a", "text-value");
    database
      .prepare("INSERT INTO entries (id, value) VALUES (?, ?)")
      .run(Buffer.from("key-a"), "blob-value");

    expect(() =>
      migrateSqliteSchemaToStrict(
        database,
        "CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
      ),
    ).toThrow(/primary-key row.*collide/);

    expect(readStrictFlag(database, "entries")).toBe(0);
  });

  it("preserves BLOB primary key rows when no TEXT collision exists", () => {
    const database = createDatabase();
    database.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database
      .prepare("INSERT INTO entries (id, value) VALUES (?, ?)")
      .run(Buffer.from("blob-key"), "blob-value");

    migrateSqliteSchemaToStrict(
      database,
      "CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
    );

    expect(readStrictFlag(database, "entries")).toBe(1);
    expect(
      database
        .prepare("SELECT id, typeof(id) AS idtype, value, typeof(value) AS vtype FROM entries")
        .get(),
    ).toEqual({ id: "blob-key", idtype: "text", value: "blob-value", vtype: "text" });
  });

  it("normalizes non-UTF-8 BLOB bytes in TEXT columns during STRICT migration", () => {
    const database = createDatabase();
    database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    const nonUtf8Blob = Buffer.from([0x80, 0x81, 0xfe, 0xff]);
    database.prepare("INSERT INTO entries (id, data) VALUES (?, ?)").run(1, nonUtf8Blob);

    migrateSqliteSchemaToStrict(
      database,
      "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, data TEXT NOT NULL) STRICT;",
    );

    expect(readStrictFlag(database, "entries")).toBe(1);
    expect(
      database.prepare("SELECT id, typeof(data) AS dtype, hex(data) AS hexdata FROM entries").get(),
    ).toEqual({ id: 1, dtype: "text", hexdata: "8081FEFF" });
  });

  it("allows composite-key rows when BLOB component matches but full tuple is unique", () => {
    const database = createDatabase();
    database.exec(
      "CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (scope, key))",
    );
    database
      .prepare("INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)")
      .run("scope-a", "key-one", "text-value");
    database
      .prepare("INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)")
      .run(Buffer.from("scope-a"), "key-two", "blob-value");

    migrateSqliteSchemaToStrict(
      database,
      "CREATE TABLE IF NOT EXISTS kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (scope, key)) STRICT;",
    );

    expect(readStrictFlag(database, "kv")).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS cnt FROM kv").get()).toEqual({ cnt: 2 });
    expect(
      database
        .prepare("SELECT scope, typeof(scope) AS stype, key, value FROM kv ORDER BY key")
        .all(),
    ).toEqual([
      { scope: "scope-a", stype: "text", key: "key-one", value: "text-value" },
      { scope: "scope-a", stype: "text", key: "key-two", value: "blob-value" },
    ]);
  });

  it("rejects composite-key rows when full tuple collides after CAST", () => {
    const database = createDatabase();
    database.exec(
      "CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (scope, key))",
    );
    database
      .prepare("INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)")
      .run("scope-a", "key-one", "text-value");
    database
      .prepare("INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)")
      .run(Buffer.from("scope-a"), Buffer.from("key-one"), "blob-value");

    expect(() =>
      migrateSqliteSchemaToStrict(
        database,
        "CREATE TABLE IF NOT EXISTS kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (scope, key)) STRICT;",
      ),
    ).toThrow(/primary-key row.*collide/);

    expect(readStrictFlag(database, "kv")).toBe(0);
  });
});
