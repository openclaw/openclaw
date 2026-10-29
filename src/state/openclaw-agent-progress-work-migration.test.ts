import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  hasPendingCurrentVersionAgentDatabaseMigration,
  repairAndAssertOpenClawAgentV14SchemaForMigration,
} from "./openclaw-agent-db-schema-helpers.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-schema-history.js";
import { assertOpenClawMigrationWitnessPreserved as assertPreserved } from "./openclaw-migration-witness.js";
import {
  agentWitness,
  expectVersion,
  migrationFixture,
  rows,
  seedVersion,
} from "./schema-migration.test-support.js";

const table = "session_progress_cards";
// Independent pre-work table; do not derive the regression's missing columns from the candidate.
const oldCard = `CREATE TABLE IF NOT EXISTS session_progress_cards (
  session_key TEXT NOT NULL PRIMARY KEY,
  markdown TEXT,
  steps_json TEXT,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
) STRICT;`;
const work = {
  display_kind: "work",
  work_json: ' {"scope":"keep raw bytes"} ',
  work_generation: 7,
  work_revision: 11,
  work_command_json: ' {"id":"command","fingerprint":"unchanged"} ',
};
const defaults = {
  display_kind: "independent",
  work_json: null,
  work_generation: 0,
  work_revision: 0,
  work_command_json: null,
};
function seed(db: DatabaseSync, version: number, partial = false) {
  db.exec(
    getOpenClawAgentMigrationSchema(version).replace(
      /CREATE TABLE IF NOT EXISTS session_progress_cards \([\s\S]*?\n\) STRICT;/u,
      oldCard,
    ),
  );
  seedVersion(db, version);
  db.exec(`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
    VALUES ('agent:main:retained', 'retained', '{"sessionId":"retained","updatedAt":1}', 1);
    INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
    VALUES ('retained', 'agent:main:retained', 1, 1);
    INSERT INTO transcript_events (session_id, seq, event_json, created_at)
    VALUES ('retained', 1, ' {"type":"message","message":{"role":"user","content":"unchanged"}} ', 1);
    INSERT INTO session_progress_cards VALUES ('agent:main:retained', ' keep markdown ', ' [ {"step":"remaining","status":"pending"} ] ', 9, 8, 123);
    INSERT INTO cache_entries (scope, key, blob, updated_at) VALUES ('unrelated', 'bytes', X'0000FF', 1);`);
  if (version >= 25) {
    db.exec("UPDATE session_nodes SET entry_valid = 1");
  }
  if (partial) {
    db.exec(
      "ALTER TABLE session_progress_cards ADD COLUMN work_json TEXT; ALTER TABLE session_progress_cards ADD COLUMN work_generation INTEGER NOT NULL DEFAULT 0",
    );
    db.prepare("UPDATE session_progress_cards SET work_json = ?, work_generation = ?").run(
      work.work_json,
      work.work_generation,
    );
  }
}
const cards = (db: DatabaseSync) => rows(db, "SELECT rowid, * FROM session_progress_cards");
const fixture = (version: number, partial = false) =>
  migrationFixture({
    seed: (db) => seed(db, version, partial),
    predecessor: version,
    target: 39,
    scope: ["schema_meta", table],
    admission: version === 39,
  });

it.each([
  [37, false, "commit"],
  [38, false, "commit"],
  [38, true, "commit"],
  [38, true, "rollback"],
  [39, true, "commit"],
] as const)(
  "preserves cards and unrelated raw rows through SQLite admission from %s (partial=%s, %s)",
  async (version, partial, outcome) => {
    await fixture(version, partial)("progress.sqlite", async ({ database, migrate }) => {
      const before = cards(database);
      if (version === 39) {
        expect(hasPendingCurrentVersionAgentDatabaseMigration(database)).toBe(true);
      }
      await migrate(outcome);
      expectVersion(database, outcome === "rollback" ? version : 39);
      expect(cards(database)).toEqual(
        outcome === "rollback" ? before : before.map((row) => Object.assign({}, defaults, row)),
      );
      if (outcome !== "rollback") {
        expect(hasPendingCurrentVersionAgentDatabaseMigration(database)).toBe(false);
        database
          .prepare(
            "UPDATE session_progress_cards SET display_kind=?, work_json=?, work_generation=?, work_revision=?, work_command_json=?",
          )
          .run(...Object.values(work));
        const populated = cards(database);
        await migrate();
        expect(cards(database)).toEqual(populated);
      }
    });
  },
);

it("keeps v14 preflight and historical targets free of future work columns", () => {
  using db = openNodeSqliteDatabase(":memory:");
  seed(db, 14);
  const before = cards(db);
  runSqliteImmediateTransactionSync(db, () =>
    repairAndAssertOpenClawAgentV14SchemaForMigration(db, {
      agentId: "main",
      pathname: ":memory:",
    }),
  );
  expect(cards(db)).toEqual(before);
  expect(rows(db, "PRAGMA table_info(session_progress_cards)").map((row) => row.name)).toEqual([
    "session_key",
    "markdown",
    "steps_json",
    "revision",
    "created_at",
    "updated_at",
  ]);
});

it.each([false, true])(
  "witnesses only new work-column defaults and preserves existing partial values (%s)",
  async (partial) => {
    await fixture(38, partial)("witness.sqlite", async ({ database, migrate }) => {
      const original = agentWitness(database);
      await migrate();
      expect(assertPreserved(original, agentWitness(database))).toEqual({ warnings: [] });
      for (const [column, value] of Object.entries(work)) {
        database.exec("SAVEPOINT tamper");
        database
          .prepare("UPDATE session_progress_cards SET " + column + " = ?")
          .run(
            value === work.work_json && partial
              ? "changed"
              : value === work.work_generation && partial
                ? 9
                : value,
          );
        expect(() => assertPreserved(original, agentWitness(database))).toThrow(/changed or lost/);
        database.exec("ROLLBACK TO tamper; RELEASE tamper");
      }
      database
        .prepare(
          "UPDATE session_progress_cards SET display_kind=?, work_json=?, work_generation=?, work_revision=?, work_command_json=?",
        )
        .run(...Object.values(work));
      const current = agentWitness(database);
      expect(assertPreserved(current, agentWitness(database))).toEqual({ warnings: [] });
      database.exec("UPDATE session_progress_cards SET work_revision = 12");
      expect(() => assertPreserved(current, agentWitness(database))).toThrow(/changed or lost/);
    });
  },
);

it("does not instantiate an absent lazy progress table during the version step", async () => {
  await fixture(38)("absent.sqlite", async ({ database, migrate }) => {
    database.exec("DROP TABLE session_progress_cards");
    const original = agentWitness(database);
    await migrate();
    expect(
      rows(database, "SELECT name FROM sqlite_schema WHERE name = 'session_progress_cards'"),
    ).toEqual([]);
    expect(assertPreserved(original, agentWitness(database))).toEqual({ warnings: [] });
  });
});
