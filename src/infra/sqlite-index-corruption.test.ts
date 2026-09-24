import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { repairSqliteIndexCorruption } from "./sqlite-index-corruption.js";
import { corruptSqliteIndexKey } from "./sqlite-index-corruption.test-support.js";
import { repairDoctorSqliteIndexCorruption } from "./sqlite-index-recovery.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(replacement = "bravo"): { pathname: string; database: DatabaseSync } {
  const pathname = path.join(tempDirs.make("index-corruption-"), "state.sqlite");
  const database = new DatabaseSync(pathname);
  database.exec(`
    CREATE TABLE audit_events (id INTEGER PRIMARY KEY, event_id TEXT UNIQUE, value TEXT);
    CREATE INDEX audit_value ON audit_events(value);
    INSERT INTO audit_events VALUES (1, 'alpha', 'first'), (2, 'omega', 'later');
    CREATE TABLE audit_links (event_id TEXT REFERENCES audit_events(event_id));
    INSERT INTO audit_links VALUES ('alpha');
  `);
  database.close();
  corruptSqliteIndexKey(pathname, "sqlite_autoindex_audit_events_1", "alpha", replacement);
  return { pathname, database: new DatabaseSync(pathname) };
}

describe("explicit index corruption repair", () => {
  it.each(["bravo", "omega"])(
    "preserves table rows and backs up before UNIQUE index repair (%s)",
    (replacement) => {
      const { pathname, database } = fixture(replacement);
      try {
        const before = database.prepare("SELECT * FROM audit_events NOT INDEXED").all();
        const backup = vi.fn(() => {
          expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).not.toBe("ok");
          expect(database.prepare("SELECT * FROM audit_events NOT INDEXED").all()).toEqual(before);
        });
        expect(
          repairSqliteIndexCorruption(database, pathname, { backup, assertCurrent: () => {} }),
        ).toEqual(["sqlite_autoindex_audit_events_1"]);
        expect(backup).toHaveBeenCalledOnce();
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(database.prepare("SELECT event_id FROM audit_links").all()).toEqual([
          { event_id: "alpha" },
        ]);
        expect(database.prepare("SELECT * FROM audit_events NOT INDEXED").all()).toEqual(before);
        expect(
          database.prepare("SELECT id FROM audit_events WHERE event_id = 'alpha'").get(),
        ).toEqual({ id: 1 });
        expect(() => database.exec("INSERT INTO audit_events(event_id) VALUES ('alpha')")).toThrow(
          /UNIQUE/,
        );
      } finally {
        database.close();
      }
    },
  );

  it("leaves indexes damaged when backup fails", () => {
    const { pathname, database } = fixture();
    try {
      const findings = database.prepare("PRAGMA integrity_check").all();
      expect(() =>
        repairSqliteIndexCorruption(database, pathname, {
          assertCurrent: () => {},
          backup: () => {
            throw new Error("backup full");
          },
        }),
      ).toThrow("backup full");
      expect(database.prepare("PRAGMA integrity_check").all()).toEqual(findings);
      expect(database.isTransaction).toBe(false);
    } finally {
      database.close();
    }
  });

  it("preserves the backup and rolls back when maintenance authority is lost during REINDEX", () => {
    const { pathname, database } = fixture();
    const authority = new AbortController();
    const exec = database.exec.bind(database);
    const write = vi.spyOn(database, "exec").mockImplementation((sql) => {
      exec(sql);
      if (sql.startsWith("REINDEX ")) {
        authority.abort(new Error("maintenance authority lost after rebuild"));
      }
    });
    try {
      const findings = database.prepare("PRAGMA integrity_check").all();
      const rows = database.prepare("SELECT * FROM audit_events NOT INDEXED").all();
      expect(() =>
        repairDoctorSqliteIndexCorruption(database, pathname, {
          label: "audit",
          assertCurrent: () => authority.signal.throwIfAborted(),
        }),
      ).toThrow("maintenance authority lost after rebuild");
      expect(database.isTransaction).toBe(false);
      expect(database.prepare("PRAGMA integrity_check").all()).toEqual(findings);
      expect(database.prepare("SELECT * FROM audit_events NOT INDEXED").all()).toEqual(rows);
      const recovery = fs
        .readdirSync(path.dirname(pathname))
        .find((name) => name.startsWith("openclaw-index-recovery-"));
      expect(recovery).toBeDefined();
      const backup = new DatabaseSync(
        path.join(path.dirname(pathname), recovery!, "database.sqlite"),
        {
          readOnly: true,
        },
      );
      try {
        expect(backup.prepare("PRAGMA integrity_check").all()).toEqual(findings);
        expect(backup.prepare("SELECT * FROM audit_events NOT INDEXED").all()).toEqual(rows);
      } finally {
        backup.close();
      }
    } finally {
      write.mockRestore();
      database.close();
    }
  });

  it("rolls back when table values cannot satisfy the UNIQUE constraint", () => {
    const { pathname, database } = fixture();
    try {
      // The missing key lets SQLite admit a duplicate that REINDEX must not discard.
      database.exec("INSERT INTO audit_events(event_id) VALUES ('alpha')");
      const before = database.prepare("SELECT * FROM audit_events NOT INDEXED").all();
      const findings = database.prepare("PRAGMA integrity_check").all();
      const backup = vi.fn();
      expect(() =>
        repairSqliteIndexCorruption(database, pathname, { backup, assertCurrent: () => {} }),
      ).toThrow(/UNIQUE/);
      expect(backup).toHaveBeenCalledOnce();
      expect(database.prepare("SELECT * FROM audit_events NOT INDEXED").all()).toEqual(before);
      expect(database.prepare("PRAGMA integrity_check").all()).toEqual(findings);
    } finally {
      database.close();
    }
  });

  it("rolls back the rebuild when foreign-key violations remain after repair", () => {
    const { pathname, database } = fixture();
    try {
      database.exec("PRAGMA foreign_keys=OFF; INSERT INTO audit_links VALUES ('absent')");
      const before = database.prepare("PRAGMA integrity_check").all();
      const links = database.prepare("SELECT event_id FROM audit_links").all();
      const backup = vi.fn();
      expect(() =>
        repairSqliteIndexCorruption(database, pathname, { backup, assertCurrent: () => {} }),
      ).toThrow(/foreign_key_check failed/);
      expect(backup).toHaveBeenCalledOnce();
      expect(database.prepare("PRAGMA integrity_check").all()).toEqual(before);
      expect(database.prepare("SELECT event_id FROM audit_links").all()).toEqual(links);
    } finally {
      database.close();
    }
  });

  it("refuses structural damage mixed with an index finding without attempting repair", () => {
    const { pathname, database } = fixture();
    database.exec("CREATE TABLE damaged (value TEXT); INSERT INTO damaged VALUES ('intact');");
    const pageSize = Number(database.prepare("PRAGMA page_size").get()?.page_size);
    const rootPage = Number(
      database.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'damaged'").get()?.rootpage,
    );
    database.close();
    const bytes = fs.readFileSync(pathname);
    bytes[(rootPage - 1) * pageSize] = 0;
    fs.writeFileSync(pathname, bytes);
    const damaged = new DatabaseSync(pathname);
    try {
      const backup = vi.fn();
      expect(() =>
        repairSqliteIndexCorruption(damaged, pathname, { backup, assertCurrent: () => {} }),
      ).toThrow(/malformed|Unrecognized SQLite integrity finding/);
      expect(backup).not.toHaveBeenCalled();
      expect(fs.readFileSync(pathname)).toEqual(bytes);
    } finally {
      damaged.close();
    }
  });
});
