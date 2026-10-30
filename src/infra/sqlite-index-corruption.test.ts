import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { corruptSqliteIndexKey } from "./sqlite-index-corruption.test-support.js";
import { repairDoctorSqliteIndexCorruption as repairDoctor } from "./sqlite-index-recovery.js";
import { repairSqliteIndexCorruption as repair } from "./sqlite-index-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all();
const image = (db: DatabaseSync) => ({
  findings: rows(db, "PRAGMA integrity_check"),
  rows: rows(db, "SELECT * FROM audit_events NOT INDEXED"),
  links: rows(db, "SELECT event_id FROM audit_links"),
});

function fixture(replacement = "bravo") {
  const pathname = path.join(tempDirs.make("index-corruption-"), "state.sqlite");
  const db = new DatabaseSync(pathname);
  db.exec(`
    CREATE TABLE audit_events (id INTEGER PRIMARY KEY, event_id TEXT UNIQUE, value TEXT);
    CREATE INDEX audit_value ON audit_events(value);
    INSERT INTO audit_events VALUES (1, 'alpha', 'first'), (2, 'omega', 'later');
    CREATE TABLE audit_links (event_id TEXT REFERENCES audit_events(event_id));
    INSERT INTO audit_links VALUES ('alpha');
  `);
  db.close();
  corruptSqliteIndexKey(pathname, "sqlite_autoindex_audit_events_1", "alpha", replacement);
  const reopened = new DatabaseSync(pathname);
  return { pathname, db: reopened, [Symbol.dispose]: () => reopened.close() };
}

it.each(["bravo", "omega"])(
  "preserves table rows and backs up before UNIQUE index repair (%s)",
  (replacement) => {
    using state = fixture(replacement);
    const { pathname, db } = state;
    const before = rows(db, "SELECT * FROM audit_events NOT INDEXED");
    const backup = vi.fn(() => {
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).not.toBe("ok");
      expect(rows(db, "SELECT * FROM audit_events NOT INDEXED")).toEqual(before);
    });
    expect(repair(db, pathname, { backup, assertCurrent: () => {} })).toEqual([
      "sqlite_autoindex_audit_events_1",
    ]);
    expect(backup).toHaveBeenCalledOnce();
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
    expect(rows(db, "SELECT event_id FROM audit_links")).toEqual([{ event_id: "alpha" }]);
    expect(rows(db, "SELECT * FROM audit_events NOT INDEXED")).toEqual(before);
    expect(db.prepare("SELECT id FROM audit_events WHERE event_id = 'alpha'").get()).toEqual({
      id: 1,
    });
    expect(() => db.exec("INSERT INTO audit_events(event_id) VALUES ('alpha')")).toThrow(/UNIQUE/);
  },
);

it.each([
  ["backup", "", "backup full"],
  // The missing key admits a duplicate that REINDEX must not discard.
  ["UNIQUE constraint", "INSERT INTO audit_events(event_id) VALUES ('alpha')", /UNIQUE/],
  [
    "foreign-key check",
    "PRAGMA foreign_keys=OFF; INSERT INTO audit_links VALUES ('absent')",
    /foreign_key_check failed/,
  ],
  ["authority", "", "maintenance authority lost after rebuild"],
] as const)("preserves the image after %s failure", (failure, sql, error) => {
  using state = fixture();
  const { pathname, db } = state;
  if (sql) {
    db.exec(sql);
  }
  const before = image(db),
    authority = new AbortController();
  const backup = vi.fn(() => {
    if (failure === "backup") {
      throw new Error("backup full");
    }
  });
  if (failure === "authority") {
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((statement) => {
      exec(statement);
      if (statement.startsWith("REINDEX ")) {
        authority.abort(new Error(error));
      }
    });
  }
  const attempt = () =>
    failure === "authority"
      ? repairDoctor(db, pathname, {
          label: "audit",
          assertCurrent: () => authority.signal.throwIfAborted(),
        })
      : repair(db, pathname, { backup, assertCurrent: () => {} });
  expect(attempt).toThrow(error);
  expect(db.isTransaction).toBe(false);
  expect(image(db)).toEqual(before);
  if (failure === "authority") {
    const recovery = fs
      .readdirSync(path.dirname(pathname))
      .find((name) => name.startsWith("openclaw-index-recovery-"));
    expect(recovery).toBeDefined();
    using snapshot = new DatabaseSync(
      path.join(path.dirname(pathname), recovery!, "database.sqlite"),
      { readOnly: true },
    );
    expect(image(snapshot)).toEqual(before);
  } else {
    expect(backup).toHaveBeenCalledOnce();
  }
});

it("refuses structural damage mixed with an index finding without attempting repair", () => {
  const { pathname, db } = fixture();
  db.exec("CREATE TABLE damaged (value TEXT); INSERT INTO damaged VALUES ('intact');");
  const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
  const rootPage = Number(
    db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'damaged'").get()?.rootpage,
  );
  db.close();
  const bytes = fs.readFileSync(pathname);
  bytes[(rootPage - 1) * pageSize] = 0;
  fs.writeFileSync(pathname, bytes);
  using damaged = new DatabaseSync(pathname);
  const backup = vi.fn();
  expect(() => repair(damaged, pathname, { backup, assertCurrent: () => {} })).toThrow(
    /malformed|Unrecognized SQLite integrity finding/,
  );
  expect(backup).not.toHaveBeenCalled();
  expect(fs.readFileSync(pathname)).toEqual(bytes);
});
