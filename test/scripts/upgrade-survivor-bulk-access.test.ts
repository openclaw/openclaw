import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  assertMigrationBulkSafe,
  classifyMigrationBulkAccess,
} from "../../scripts/e2e/lib/upgrade-survivor/sqlite-bulk-access.mts";
import type { SqliteMigrationRange } from "../../scripts/e2e/lib/upgrade-survivor/sqlite-migration-observation.mts";
import {
  installSqliteMigrationObserver,
  type SqliteMigrationObserver,
} from "../../scripts/e2e/lib/upgrade-survivor/sqlite-migration-observer.mts";

const range: SqliteMigrationRange = {
  store: "agent.sqlite",
  fromVersion: 43,
  toVersion: 44,
  beforeMinReader: 43,
  afterMinReader: 43,
};
async function fixture(
  run: (db: DatabaseSync, observer: SqliteMigrationObserver) => Promise<void>,
) {
  const observer = installSqliteMigrationObserver();
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE transcript_events(id INTEGER PRIMARY KEY, payload TEXT); INSERT INTO transcript_events VALUES(1, 'tiny'); CREATE INDEX old_payload ON transcript_events(payload)",
    );
    await run(db, observer);
  } finally {
    db.close();
    observer.dispose();
  }
}

describe("migration bulk access over native SQLite executions", () => {
  it.each([
    "UPDATE transcript_events SET payload = 'x' WHERE 0",
    "SELECT payload FROM transcript_events WHERE 0",
    "CREATE INDEX new_payload ON transcript_events(payload)",
    "ALTER TABLE transcript_events ADD COLUMN checked INTEGER CHECK(checked IS NULL)",
    "ALTER TABLE transcript_events DROP COLUMN payload",
    "ANALYZE transcript_events",
    "PRAGMA quick_check(transcript_events)",
    "VACUUM",
    "INSERT INTO signals VALUES(1)",
  ])("rejects executed bulk work: %s", async (sql) => {
    await fixture(async (db, observer) => {
      if (sql.startsWith("INSERT")) {
        db.exec(`CREATE TABLE signals(id INTEGER);
          CREATE TRIGGER hidden_bulk AFTER INSERT ON signals BEGIN
            UPDATE transcript_events SET payload = 'a; b' WHERE 0;
          END;`);
      }
      if (sql.includes("DROP COLUMN")) {
        db.exec("DROP INDEX old_payload");
      }
      const { observation } = await observer.observe(() => db.exec(sql));
      const receipt = classifyMigrationBulkAccess(observation, range);
      expect(receipt.coverageFailures).toEqual([]);
      expect(receipt.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            store: "agent.sqlite",
            fromVersion: 43,
            toVersion: 44,
            table: "transcript_events",
            sql,
          }),
        ]),
      );
      expect(() => assertMigrationBulkSafe(observation, range)).toThrow(/agent\.sqlite.*43→44/);
    });
  });

  it("allows constant metadata DDL, actual no-ops, and constant renames without floor rise", async () => {
    await fixture(async (db, observer) => {
      const { observation } = await observer.observe(() => {
        db.exec("CREATE INDEX IF NOT EXISTS old_payload ON transcript_events(payload)");
        db.exec("ALTER TABLE transcript_events ADD COLUMN optional TEXT DEFAULT NULL");
        db.exec("ALTER TABLE transcript_events ADD COLUMN literal TEXT DEFAULT 'CHECK; harmless'");
        db.exec("DROP INDEX old_payload");
        db.exec("ALTER TABLE transcript_events RENAME COLUMN payload TO content");
        db.exec("ALTER TABLE transcript_events RENAME TO renamed_events");
        db.prepare("PRAGMA table_info(renamed_events)").all();
      });
      expect(assertMigrationBulkSafe(observation, range).violations).toEqual([]);
      const raised = classifyMigrationBulkAccess(observation, { ...range, afterMinReader: 44 });
      expect(raised.violations.some((v) => v.reason.includes("reader-floor rise 43→44"))).toBe(
        true,
      );
    });
  });

  it("attributes cached executions, not unexecuted preparation or iterator creation", async () => {
    await fixture(async (db, observer) => {
      const cached = db.prepare("SELECT payload FROM transcript_events WHERE 0");
      cached.all();
      const { observation: unused } = await observer.observe(() => {
        db.prepare("SELECT payload FROM transcript_events");
        cached.iterate();
      });
      expect(assertMigrationBulkSafe(unused, range).violations).toEqual([]);
      const { observation } = await observer.observe(() => cached.iterate().next());
      expect(classifyMigrationBulkAccess(observation, range).violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "transcript_events",
            reason: "Executed SQLITE_READ bulk-data intention",
          }),
        ]),
      );
    });
  });

  it("follows staging publication backwards to earlier index builds and writes", async () => {
    await fixture(async (db, observer) => {
      const { observation } = await observer.observe(() => {
        db.exec("CREATE TABLE staging(id INTEGER PRIMARY KEY, payload TEXT)");
        db.exec("UPDATE staging SET payload='x' WHERE 0");
        db.exec("CREATE INDEX staging_payload ON staging(payload)");
        db.exec("DROP TABLE transcript_events");
        db.exec("ALTER TABLE staging RENAME TO transcript_events");
      });
      const receipt = classifyMigrationBulkAccess(observation, range);
      expect(receipt.coverageFailures).toEqual([]);
      for (const sql of ["UPDATE staging", "CREATE INDEX staging_payload"]) {
        expect(
          receipt.violations.some((v) => v.table === "transcript_events" && v.sql.startsWith(sql)),
        ).toBe(true);
      }
    });
  });

  it("covers real FTS roots/shadows, cached queries, and control writes", async () => {
    await fixture(async (db, observer) => {
      db.exec(
        "CREATE VIRTUAL TABLE custom_search USING fts5(text); INSERT INTO custom_search VALUES('tiny')",
      );
      const query = db.prepare("SELECT rowid FROM custom_search WHERE custom_search MATCH 'tiny'");
      query.all();
      const { observation } = await observer.observe(() => {
        query.all();
        db.exec("INSERT INTO custom_search(custom_search) VALUES('rebuild')");
        db.prepare("SELECT * FROM custom_search_data WHERE 0").all();
      });
      const receipt = classifyMigrationBulkAccess(observation, range);
      expect(receipt.coverageFailures).toEqual([]);
      expect(
        receipt.violations.some((v) => v.table === "custom_search" && v.reason.includes("READ")),
      ).toBe(true);
      expect(
        receipt.violations.some((v) => v.table === "custom_search" && v.reason.includes("INSERT")),
      ).toBe(true);
      expect(
        receipt.violations.some(
          (v) => v.table === "custom_search_data" && v.reason.includes("READ"),
        ),
      ).toBe(true);
    });
  });

  it("fails coverage for opaque intermediate staging and protects TEMP aliases", async () => {
    await fixture(async (db, observer) => {
      const { observation: opaque } = await observer.observe(() =>
        db.exec(
          "CREATE TABLE staging(payload TEXT); UPDATE staging SET payload='x' WHERE 0; DROP TABLE transcript_events; ALTER TABLE staging RENAME TO transcript_events",
        ),
      );
      expect(classifyMigrationBulkAccess(opaque, range).coverageFailures.join("\n")).toContain(
        "intermediate ALTER TABLE source",
      );
      expect(() => assertMigrationBulkSafe(opaque, range)).toThrow(/bulk-access guard/);
      db.exec("CREATE TEMP TABLE memory_embedding_cache(payload BLOB)");
      const { observation } = await observer.observe(() =>
        db.exec("UPDATE temp.memory_embedding_cache SET payload=NULL WHERE 0"),
      );
      expect(classifyMigrationBulkAccess(observation, range).violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "memory_embedding_cache",
            reason: "Executed SQLITE_UPDATE bulk-data intention",
          }),
        ]),
      );
    });
  });
});
