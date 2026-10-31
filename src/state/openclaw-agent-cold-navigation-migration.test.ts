import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { AGENT_COLD_NAVIGATION_SCHEMA_VERSION as target } from "./openclaw-agent-db-contract.js";
import { assertOpenClawMigrationWitnessPreserved } from "./openclaw-migration-witness.js";
import {
  agentWitness,
  expectVersion,
  migrationFixture,
  row,
  rows,
  seedAgentV38Schema,
} from "./schema-migration.test-support.js";

const navigation = JSON.stringify({
  version: 1,
  report: { kind: "ignored" },
  navigation: {},
  reset: {},
  model: {},
  modelBytes: 0,
  modelWithoutCheckpointBytes: 0,
  withoutCustomDataBytes: 0,
});
const predecessor = 38;
const scope = ["schema_meta", "sqlite_stat1", "sqlite_stat4", "transcript_events"];

function seed(database: DatabaseSync): void {
  seedAgentV38Schema(database);
  database.exec(`
    PRAGMA foreign_keys = ON;
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:retained', 'hot', '{"sessionId":"hot","updatedAt":1}', 1);
    INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES ('hot', 'agent:main:retained', 1, 1), ('cold', 'agent:main:retained', 1, 1);
    INSERT INTO transcript_events (rowid, session_id, seq, event_json, created_at)
      VALUES (9007199254740993, 'hot', 1, ' {"type":"message","message":{"role":"user"}} ', 1);
    INSERT INTO transcript_event_identities (session_id, event_id, seq, created_at)
      VALUES ('hot', 'retained-id', 1, 1);
    INSERT INTO session_transcript_active_events (session_id, active_position, event_seq)
      VALUES ('hot', 0, 1);
    INSERT INTO session_transcript_cold_archives
      (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
       archive_bytes, last_seq, archived_at, storage, archive_blob)
      VALUES ('cold', 'generation', 'retained.jsonl.zst', '${"a".repeat(64)}',
        1, 7, 3, 1, 1, 'sqlite', X'0011FF');
    INSERT INTO cache_entries (scope, key, blob, updated_at)
      VALUES ('unrelated', 'bytes', X'000100FF', 1);
    ANALYZE;
  `);
  database
    .prepare(`INSERT INTO transcript_events
    (session_id, seq, event_zstd, event_utf8_bytes, navigation_json, created_at)
    VALUES ('hot', 2, X'0011FF', 123, ?, 2)`)
    .run(navigation);
}

const withFixture = migrationFixture({ seed, predecessor, target, scope });
const insertCold = (database: DatabaseSync, length: number | null = 123) =>
  database
    .prepare(`INSERT INTO transcript_events
    (session_id, seq, event_utf8_bytes, navigation_json, created_at)
    VALUES ('cold', 1, ?, ?, 1)`)
    .run(length, navigation);

it.each(["commit", "rollback"])(
  "preserves hot bytes, rowids, children and archives on %s",
  async (outcome) => {
    await withFixture("cold-navigation.sqlite", async ({ database, migrate }) => {
      expect(() => insertCold(database)).toThrow(/CHECK constraint/u);
      const witness = agentWitness(database);
      const original = row(
        database,
        "SELECT CAST(rowid AS TEXT) AS id, event_json FROM transcript_events WHERE seq = 1",
      );
      await migrate(outcome);
      expectVersion(database, outcome === "commit" ? target : predecessor);
      expect(assertOpenClawMigrationWitnessPreserved(witness, agentWitness(database))).toEqual({
        warnings: [],
      });
      expect(
        row(
          database,
          "SELECT CAST(rowid AS TEXT) AS id, event_json FROM transcript_events WHERE seq = 1",
        ),
      ).toEqual(original);
      expect(rows(database, "PRAGMA foreign_key_check")).toEqual([]);
      if (outcome === "rollback") {
        expect(() => insertCold(database)).toThrow(/CHECK constraint/u);
        return;
      }
      for (const invalid of [null, 0, 4194305]) {
        expect(() => insertCold(database, invalid)).toThrow(/CHECK constraint/u);
      }
      insertCold(database);
      expect(
        row(
          database,
          "SELECT event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = 'cold'",
        ),
      ).toEqual({ event_json: null, event_zstd: null, event_utf8_bytes: 123 });
    });
  },
);

it("restores the scoped predecessor without discarding unrelated later writes", async () => {
  await withFixture(
    "cold-navigation-restore.sqlite",
    async ({ database, restore }) => {
      await restore(() => ({
        definition: row(database, "SELECT sql FROM sqlite_schema WHERE name = 'transcript_events'"),
        version: row(database, "PRAGMA user_version"),
      }));
    },
    "state",
  );
});
