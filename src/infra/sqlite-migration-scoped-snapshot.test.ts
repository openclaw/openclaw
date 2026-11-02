import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createScopedMigrationSnapshot,
  createScopedMigrationSnapshotSync,
  inspectScopedMigrationTables,
  restoreScopedMigrationSnapshot,
  ScopedMigrationSnapshotUnsupportedError,
} from "./sqlite-migration-scoped-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const tables = [
  "selected",
  "loose",
  "keyed",
  "schema_meta",
  "added_later",
  "sqlite_stat1",
  "sqlite_stat4",
];

function databaseFile(filename: string) {
  const use = <T>(operation: (db: DatabaseSync) => T) => {
    using db = new DatabaseSync(filename);
    return operation(db);
  };
  const query = (sql: string, bigints = false) =>
    use((db) => {
      const statement = db.prepare(sql);
      statement.setReadBigInts(bigints);
      return statement.all();
    });
  return {
    use,
    exec: (sql: string) => use((db) => db.exec(sql)),
    rows: query,
    check: (sql: string, expected: unknown) =>
      use((db) => expect(db.prepare(sql).get()).toEqual(expected)),
    checkRows: (sql: string, expected: unknown[]) => expect(query(sql)).toEqual(expected),
  };
}

function fixture(encoding = "UTF-8") {
  const directory = tempDirs.make("openclaw-scoped-migration-");
  const sourcePath = path.join(directory, "agent.sqlite");
  const backupPath = `${sourcePath}.scoped.bak`;
  const db = databaseFile(sourcePath);
  const bak = databaseFile(backupPath);
  db.exec(`
      PRAGMA encoding = '${encoding}';
      PRAGMA user_version = 26;
      CREATE TABLE selected (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE,
        amount INTEGER NOT NULL, payload BLOB,
        doubled INTEGER GENERATED ALWAYS AS (amount * 2) STORED) STRICT;
      CREATE INDEX selected_amount ON selected(amount) WHERE amount > 0;
      CREATE TABLE untouched (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES selected(id) ON DELETE CASCADE, value TEXT);
      CREATE TRIGGER selected_update AFTER UPDATE ON selected BEGIN
        INSERT INTO untouched(value) VALUES ('trigger ran');
      END;
      CREATE TABLE loose (value TEXT);
      CREATE TABLE keyed (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;
      CREATE TABLE schema_meta (schema_version INTEGER);
      INSERT INTO schema_meta VALUES (26);
      INSERT INTO selected(id, label, amount, payload) VALUES (11, 'before', 9007199254740993, x'00FF');
      INSERT INTO loose(rowid, value) VALUES (913, 'old row');
      INSERT INTO keyed VALUES ('one', x'1234');
      INSERT INTO untouched VALUES (1, 11, 'original child');
      ANALYZE;
    `);
  return {
    sourcePath,
    backupPath,
    db,
    bak,
    restore: () =>
      restoreScopedMigrationSnapshot({ sourcePath, backupPath, assertCurrent: () => {} }),
    capture: (scope = tables) =>
      createScopedMigrationSnapshot({
        sourcePath,
        targetPath: backupPath,
        tables: scope,
        beforePublish: () => {},
      }),
  };
}

function mutate(f: ReturnType<typeof fixture>) {
  f.db.exec(`
      UPDATE selected SET label = 'after';
      UPDATE schema_meta SET schema_version = 27;
      PRAGMA user_version = 27;
      DELETE FROM loose;
      UPDATE keyed SET value = x'ABCD';
      CREATE TABLE added_later (value TEXT);
      INSERT INTO added_later VALUES ('migration output');
      INSERT INTO untouched(value) VALUES ('later independent write');
    `);
}

it("captures the caller's uncommitted rows and restores their exact SQLite values", () => {
  const f = fixture();
  f.db.use((db) => {
    db.exec("BEGIN IMMEDIATE; UPDATE loose SET value = CAST(x'0080ff' AS TEXT)");
    const captured = createScopedMigrationSnapshotSync(db, {
      ...f,
      targetPath: f.backupPath,
      tables,
      assertCurrent: () => expect(db.isTransaction).toBe(true),
    });
    expect(captured.generation).toMatch(/^[a-f0-9]{64}$/u);
    db.exec("ROLLBACK");
    expect(db.prepare("SELECT value FROM loose").get()).toEqual({ value: "old row" });
  });
  f.restore();
  f.db.check("SELECT rowid, typeof(value) AS kind, hex(value) AS bytes FROM loose", {
    rowid: 913,
    kind: "text",
    bytes: "0080FF",
  });
  f.db.check("SELECT hex(payload) AS bytes FROM selected", { bytes: "00FF" });
});

it("refuses a fresh capture outside the source transaction or over an existing archive", () => {
  const f = fixture();
  f.db.use((db) => {
    const options = { ...f, targetPath: f.backupPath, tables, assertCurrent: () => {} };
    expect(() => createScopedMigrationSnapshotSync(db, options)).toThrow("source transaction");
    expect(fs.existsSync(f.backupPath)).toBe(false);
    fs.writeFileSync(f.backupPath, "retained original");
    db.exec("BEGIN IMMEDIATE");
    expect(() => createScopedMigrationSnapshotSync(db, options)).toThrow();
    db.exec("ROLLBACK");
    expect(fs.readFileSync(f.backupPath, "utf8")).toBe("retained original");
  });
});

it("restores mixed-case triggers without conflating distinct Unicode table names", async () => {
  const f = fixture();
  f.db.exec(`DROP TRIGGER selected_update;
        CREATE TRIGGER selected_update AFTER UPDATE ON SeLeCtEd BEGIN
          INSERT INTO untouched(value) VALUES ('mixed-case trigger ran');
        END;
        CREATE TABLE Keyed (value TEXT);
        CREATE TRIGGER unicode_insert AFTER INSERT ON Keyed BEGIN
          INSERT INTO untouched(value) VALUES ('Unicode trigger ran');
        END;`);
  await f.capture();
  f.db.exec("DROP TRIGGER selected_update");
  f.restore();
  f.db.exec("UPDATE selected SET label = 'after restore'; INSERT INTO Keyed VALUES ('preserved')");
  f.db.checkRows("SELECT value FROM untouched ORDER BY id", [
    { value: "original child" },
    { value: "mixed-case trigger ran" },
    { value: "Unicode trigger ran" },
  ]);
});

it.each([
  { encoding: "UTF-8", malformed: "61FF62", nul: "610062" },
  { encoding: "UTF-16le", malformed: "610000D86200", nul: "610000006200" },
])(
  "preserves TEXT bytes during backup and restore with $encoding",
  async ({ encoding, malformed, nul }) => {
    const f = fixture(encoding);
    f.db.exec(`INSERT INTO loose(rowid, value) VALUES
      (914, CAST(X'${malformed}' AS TEXT)), (915, CAST(X'${nul}' AS TEXT))`);
    await f.capture();
    mutate(f);
    f.restore();
    f.db.checkRows(
      "SELECT typeof(value) AS type, hex(value) AS bytes FROM loose WHERE rowid >= 914 ORDER BY rowid",
      [
        { type: "text", bytes: malformed },
        { type: "text", bytes: nul },
      ],
    );
  },
);

it("restores selected schema, typed rows, rowids and statistics while retaining later writes elsewhere", async () => {
  const f = fixture();
  const statistics = f.db.rows("SELECT * FROM sqlite_stat1 ORDER BY tbl, idx");
  await f.capture();
  mutate(f);
  f.db.exec("DROP TABLE sqlite_stat1");
  f.restore();
  expect(f.db.rows("SELECT * FROM selected", true)).toEqual([
    {
      id: 11n,
      label: "before",
      amount: 9007199254740993n,
      payload: new Uint8Array([0, 255]),
      doubled: 18014398509481986n,
    },
  ]);
  f.db.checkRows("SELECT rowid, value FROM loose", [{ rowid: 913, value: "old row" }]);
  f.db.check("SELECT hex(value) AS value FROM keyed WHERE key = 'one'", { value: "1234" });
  f.db.check("SELECT schema_version FROM schema_meta", { schema_version: 26 });
  f.db.check("PRAGMA user_version", { user_version: 26 });
  f.db.checkRows("SELECT * FROM sqlite_stat1 ORDER BY tbl, idx", statistics);
  f.db.check("SELECT 1 FROM sqlite_master WHERE name = 'added_later'", undefined);
  f.db.checkRows("SELECT value FROM untouched ORDER BY id", [
    { value: "original child" },
    { value: "trigger ran" },
    { value: "later independent write" },
  ]);
  f.db.checkRows(
    "SELECT name FROM sqlite_master WHERE name IN ('selected_amount', 'selected_update') ORDER BY name",
    [{ name: "selected_amount" }, { name: "selected_update" }],
  );
  f.bak.check("SELECT name FROM sqlite_master WHERE name = 'untouched'", undefined);
  f.bak.check("PRAGMA integrity_check", { integrity_check: "ok" });
});

it("rolls back the whole restore when a selected row cannot satisfy its saved schema", async () => {
  const f = fixture();
  await f.capture();
  mutate(f);
  f.bak.exec("UPDATE data_0 SET c1 = NULL");
  expect(() => f.restore()).toThrow();
  f.db.check("SELECT label FROM selected", { label: "after" });
  f.db.check("PRAGMA user_version", { user_version: 27 });
  f.db.check("SELECT value FROM added_later", { value: "migration output" });
});

it("refuses archive DDL that attempts to mutate an undeclared table, without committing selected changes", async () => {
  const f = fixture();
  await f.capture();
  mutate(f);
  f.bak.use((db) => {
    const metadata: ReturnType<typeof inspectScopedMigrationTables> = JSON.parse(
      String(db.prepare("SELECT metadata FROM migration_scope").get()!.metadata),
    );
    metadata.tables[0]!.sql += "; DELETE FROM untouched;";
    db.prepare("UPDATE migration_scope SET metadata = ?").run(JSON.stringify(metadata));
  });
  expect(() => f.restore()).toThrow();
  f.db.check("SELECT count(*) AS count FROM untouched", { count: 3 });
  f.db.check("SELECT label FROM selected", { label: "after" });
});

it("reports virtual and shadow table scopes before creating an archive", async () => {
  const f = fixture();
  f.db.exec("CREATE VIRTUAL TABLE search USING fts5(content)");
  for (const name of ["search", "search_data"]) {
    expect(() => inspectScopedMigrationTables(f.sourcePath, [name])).toThrow(
      ScopedMigrationSnapshotUnsupportedError,
    );
  }
  await expect(f.capture(["search"])).rejects.toBeInstanceOf(
    ScopedMigrationSnapshotUnsupportedError,
  );
  expect(fs.existsSync(f.backupPath)).toBe(false);
});

it("keeps AUTOINCREMENT scopes on full backups and refuses an undeclared sequence mutation during restore", async () => {
  const f = fixture();
  f.db.exec("CREATE TABLE counter (id INTEGER PRIMARY KEY AUTOINCREMENT)");
  expect(() =>
    inspectScopedMigrationTables(f.sourcePath, ["counter", "sqlite_stat1", "sqlite_stat4"]),
  ).toThrow("sqlite_sequence");
  await f.capture();
  f.db.exec(
    "DROP TABLE loose; CREATE TABLE loose (id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO loose DEFAULT VALUES",
  );
  expect(() => f.restore()).toThrow("AUTOINCREMENT table loose");
  f.db.check("SELECT id FROM loose", { id: 1 });
  f.db.check("SELECT seq FROM sqlite_sequence WHERE name = 'loose'", { seq: 1 });
});

it.each([
  { encoding: "UTF-8", malformedStat: "312031FF" },
  { encoding: "UTF-16le", malformedStat: "31002000310000D8" },
])(
  "preserves current undeclared statistics across scoped restore with $encoding",
  async ({ encoding, malformedStat }) => {
    const f = fixture(encoding);
    await f.capture(tables.filter((name) => !name.startsWith("sqlite_stat")));
    mutate(f);
    const readStatistics = () =>
      ["sqlite_stat1", "sqlite_stat4"].flatMap((name) =>
        f.db.rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${name}'`).length
          ? [{ name, rows: f.db.rows(`SELECT rowid, * FROM ${name} ORDER BY rowid`, true) }]
          : [],
      );
    f.db.exec(`
        ANALYZE untouched;
        UPDATE sqlite_stat1 SET rowid = 9007199254740993, stat = CAST(X'${malformedStat}' AS TEXT)
          WHERE idx = 'selected_amount';
      `);
    f.db.check("SELECT stat FROM sqlite_stat1 WHERE tbl = 'untouched'", { stat: "3" });
    const statistics = readStatistics();
    f.restore();
    f.db.check("SELECT label FROM selected", { label: "before" });
    expect(readStatistics()).toEqual(statistics);
    f.db.check("SELECT hex(stat) AS bytes FROM sqlite_stat1 WHERE idx = 'selected_amount'", {
      bytes: malformedStat,
    });
    f.db.check("PRAGMA integrity_check", { integrity_check: "ok" });
  },
);
