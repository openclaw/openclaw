import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createScopedMigrationSnapshot,
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

function withDatabase<T>(filename: string, operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(filename);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function fixture(encoding = "UTF-8") {
  const directory = tempDirs.make("openclaw-scoped-migration-");
  const sourcePath = path.join(directory, "agent.sqlite");
  const backupPath = `${sourcePath}.scoped.bak`;
  withDatabase(sourcePath, (db) => {
    db.exec(`
      PRAGMA encoding = '${encoding}';
      PRAGMA user_version = 26;
      CREATE TABLE selected (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        amount INTEGER NOT NULL,
        payload BLOB,
        doubled INTEGER GENERATED ALWAYS AS (amount * 2) STORED
      ) STRICT;
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
  });
  return { sourcePath, backupPath };
}

async function capture(f: ReturnType<typeof fixture>) {
  await createScopedMigrationSnapshot({
    ...f,
    targetPath: f.backupPath,
    tables,
    beforePublish: () => {},
  });
}

function mutate(f: ReturnType<typeof fixture>) {
  withDatabase(f.sourcePath, (db) => {
    db.exec(`
      UPDATE selected SET label = 'after';
      UPDATE schema_meta SET schema_version = 27;
      PRAGMA user_version = 27;
      DELETE FROM loose;
      UPDATE keyed SET value = x'ABCD';
      CREATE TABLE added_later (value TEXT);
      INSERT INTO added_later VALUES ('migration output');
      INSERT INTO untouched(value) VALUES ('later independent write');
    `);
  });
}

function editMetadata(
  f: ReturnType<typeof fixture>,
  change: (value: ReturnType<typeof inspectScopedMigrationTables>) => void,
) {
  withDatabase(f.backupPath, (db) => {
    const value = JSON.parse(
      String(db.prepare("SELECT metadata FROM migration_scope").get()!.metadata),
    );
    change(value);
    db.prepare("UPDATE migration_scope SET metadata = ?").run(JSON.stringify(value));
  });
}

describe("table-scoped migration snapshots", () => {
  it("restores mixed-case triggers without conflating distinct Unicode table names", async () => {
    const f = fixture();
    withDatabase(f.sourcePath, (db) => {
      db.exec(`DROP TRIGGER selected_update;
        CREATE TRIGGER selected_update AFTER UPDATE ON SeLeCtEd BEGIN
          INSERT INTO untouched(value) VALUES ('mixed-case trigger ran');
        END;
        CREATE TABLE Keyed (value TEXT);
        CREATE TRIGGER unicode_insert AFTER INSERT ON Keyed BEGIN
          INSERT INTO untouched(value) VALUES ('Unicode trigger ran');
        END;`);
    });
    await capture(f);
    withDatabase(f.sourcePath, (db) => db.exec("DROP TRIGGER selected_update"));
    restoreScopedMigrationSnapshot({ ...f, assertCurrent: () => {} });
    withDatabase(f.sourcePath, (db) => {
      db.exec("UPDATE selected SET label = 'after restore'");
      db.exec("INSERT INTO Keyed VALUES ('preserved')");
      expect(db.prepare("SELECT value FROM untouched ORDER BY id").all()).toEqual([
        { value: "original child" },
        { value: "mixed-case trigger ran" },
        { value: "Unicode trigger ran" },
      ]);
    });
  });

  it.each([
    { encoding: "UTF-8", malformed: "61FF62", nul: "610062" },
    { encoding: "UTF-16le", malformed: "610000D86200", nul: "610000006200" },
  ])(
    "preserves TEXT bytes during backup and restore with $encoding",
    async ({ encoding, malformed, nul }) => {
      const f = fixture(encoding);
      withDatabase(f.sourcePath, (db) =>
        db.exec(`INSERT INTO loose(rowid, value) VALUES
        (914, CAST(X'${malformed}' AS TEXT)), (915, CAST(X'${nul}' AS TEXT))`),
      );
      await capture(f);
      mutate(f);
      restoreScopedMigrationSnapshot({ ...f, assertCurrent: () => {} });
      withDatabase(f.sourcePath, (db) => {
        expect(
          db
            .prepare(
              "SELECT typeof(value) AS type, hex(value) AS bytes FROM loose WHERE rowid >= 914 ORDER BY rowid",
            )
            .all(),
        ).toEqual([
          { type: "text", bytes: malformed },
          { type: "text", bytes: nul },
        ]);
      });
    },
  );

  it("restores selected schema, typed rows, rowids and statistics while retaining later writes elsewhere", async () => {
    const f = fixture();
    const statistics = withDatabase(f.sourcePath, (db) =>
      db.prepare("SELECT * FROM sqlite_stat1 ORDER BY tbl, idx").all(),
    );
    await capture(f);
    mutate(f);
    withDatabase(f.sourcePath, (db) => db.exec("DROP TABLE sqlite_stat1"));
    restoreScopedMigrationSnapshot({ ...f, assertCurrent: () => {} });
    withDatabase(f.sourcePath, (db) => {
      const row = db.prepare("SELECT * FROM selected");
      row.setReadBigInts(true);
      expect(row.get()).toEqual({
        id: 11n,
        label: "before",
        amount: 9007199254740993n,
        payload: new Uint8Array([0, 255]),
        doubled: 18014398509481986n,
      });
      expect(db.prepare("SELECT rowid, value FROM loose").all()).toEqual([
        { rowid: 913, value: "old row" },
      ]);
      expect(db.prepare("SELECT hex(value) AS value FROM keyed WHERE key = 'one'").get()).toEqual({
        value: "1234",
      });
      expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 26,
      });
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
      expect(db.prepare("SELECT * FROM sqlite_stat1 ORDER BY tbl, idx").all()).toEqual(statistics);
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'added_later'").get(),
      ).toBeUndefined();
      expect(db.prepare("SELECT value FROM untouched ORDER BY id").all()).toEqual([
        { value: "original child" },
        { value: "trigger ran" },
        { value: "later independent write" },
      ]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('selected_amount', 'selected_update') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "selected_amount" }, { name: "selected_update" }]);
    });
    withDatabase(f.backupPath, (db) => {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'untouched'").get(),
      ).toBeUndefined();
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    });
  });

  it("rolls back the whole restore when a selected row cannot satisfy its saved schema", async () => {
    const f = fixture();
    await capture(f);
    mutate(f);
    withDatabase(f.backupPath, (db) => db.exec("UPDATE data_0 SET c1 = NULL"));
    expect(() => restoreScopedMigrationSnapshot({ ...f, assertCurrent: () => {} })).toThrow();
    withDatabase(f.sourcePath, (db) => {
      expect(db.prepare("SELECT label FROM selected").get()).toEqual({ label: "after" });
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 27 });
      expect(db.prepare("SELECT value FROM added_later").get()).toEqual({
        value: "migration output",
      });
    });
  });

  it("refuses archive DDL that attempts to mutate an undeclared table, without committing selected changes", async () => {
    const f = fixture();
    await capture(f);
    mutate(f);
    editMetadata(f, (metadata) => {
      metadata.tables[0]!.sql += "; DELETE FROM untouched;";
    });
    expect(() => restoreScopedMigrationSnapshot({ ...f, assertCurrent: () => {} })).toThrow();
    withDatabase(f.sourcePath, (db) => {
      expect(db.prepare("SELECT count(*) AS count FROM untouched").get()).toEqual({ count: 3 });
      expect(db.prepare("SELECT label FROM selected").get()).toEqual({ label: "after" });
    });
  });

  it("reports virtual and shadow table scopes before creating an archive", async () => {
    const f = fixture();
    withDatabase(f.sourcePath, (db) => db.exec("CREATE VIRTUAL TABLE search USING fts5(content)"));
    for (const name of ["search", "search_data"]) {
      expect(() => inspectScopedMigrationTables(f.sourcePath, [name])).toThrow(
        ScopedMigrationSnapshotUnsupportedError,
      );
    }
    await expect(
      createScopedMigrationSnapshot({
        ...f,
        targetPath: f.backupPath,
        tables: ["search"],
        beforePublish: () => {},
      }),
    ).rejects.toBeInstanceOf(ScopedMigrationSnapshotUnsupportedError);
    expect(fs.existsSync(f.backupPath)).toBe(false);
  });

  it("keeps AUTOINCREMENT scopes on full backups and refuses an undeclared sequence mutation during restore", async () => {
    const f = fixture();
    withDatabase(f.sourcePath, (db) =>
      db.exec("CREATE TABLE counter (id INTEGER PRIMARY KEY AUTOINCREMENT)"),
    );
    expect(() =>
      inspectScopedMigrationTables(f.sourcePath, ["counter", "sqlite_stat1", "sqlite_stat4"]),
    ).toThrow("sqlite_sequence");
    await capture(f);
    withDatabase(f.sourcePath, (db) =>
      db.exec(
        "DROP TABLE loose; CREATE TABLE loose (id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO loose DEFAULT VALUES",
      ),
    );
    expect(() => restoreScopedMigrationSnapshot({ ...f, assertCurrent: () => {} })).toThrow(
      "AUTOINCREMENT table loose",
    );
    withDatabase(f.sourcePath, (db) => {
      expect(db.prepare("SELECT id FROM loose").get()).toEqual({ id: 1 });
      expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'loose'").get()).toEqual({
        seq: 1,
      });
    });
  });

  it.each([
    { encoding: "UTF-8", malformedStat: "312031FF" },
    { encoding: "UTF-16le", malformedStat: "31002000310000D8" },
  ])(
    "preserves current undeclared statistics across scoped restore with $encoding",
    async ({ encoding, malformedStat }) => {
      const f = fixture(encoding);
      const withoutStatistics = tables.filter((name) => !name.startsWith("sqlite_stat"));
      await createScopedMigrationSnapshot({
        ...f,
        targetPath: f.backupPath,
        tables: withoutStatistics,
        beforePublish: () => {},
      });
      mutate(f);
      const readStatistics = (db: DatabaseSync) => {
        return ["sqlite_stat1", "sqlite_stat4"].flatMap((name) => {
          if (
            !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
          ) {
            return [];
          }
          const query = db.prepare(`SELECT rowid, * FROM ${name} ORDER BY rowid`);
          query.setReadBigInts(true);
          return [{ name, rows: query.all() }];
        });
      };
      const statistics = withDatabase(f.sourcePath, (db) => {
        db.exec(`
        ANALYZE untouched;
        UPDATE sqlite_stat1 SET rowid = 9007199254740993, stat = CAST(X'${malformedStat}' AS TEXT)
          WHERE idx = 'selected_amount';
      `);
        expect(db.prepare("SELECT stat FROM sqlite_stat1 WHERE tbl = 'untouched'").get()).toEqual({
          stat: "3",
        });
        return readStatistics(db);
      });
      restoreScopedMigrationSnapshot({ ...f, assertCurrent: () => {} });
      withDatabase(f.sourcePath, (db) => {
        expect(db.prepare("SELECT label FROM selected").get()).toEqual({ label: "before" });
        expect(readStatistics(db)).toEqual(statistics);
        expect(
          db
            .prepare("SELECT hex(stat) AS bytes FROM sqlite_stat1 WHERE idx = 'selected_amount'")
            .get(),
        ).toEqual({ bytes: malformedStat });
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      });
    },
  );
});
