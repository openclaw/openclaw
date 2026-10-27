import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION as version } from "./openclaw-agent-db-contract.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-db-schema-helpers.js";
import { assertOpenClawMigrationWitnessPreserved as assertPreserved } from "./openclaw-migration-witness.js";
import {
  agentWitness,
  expectVersion,
  migrationFixture,
  row,
  rows,
  seedVersion,
} from "./schema-migration.test-support.js";

const predecessor = 29;
const scope = ["schema_meta", "sqlite_stat1", "sqlite_stat4", "trajectory_runtime_events"];
const legacyJson = ` { "type": "legacy", "data": ${JSON.stringify("日本語🦞\\u0000".repeat(500))} } `;
const withFixture = migrationFixture({
  seed,
  predecessor,
  target: version,
  scope,
});

function seed(database: DatabaseSync): void {
  database.exec(getOpenClawAgentMigrationSchema(predecessor));
  seedVersion(database, predecessor);
  database.exec(`
    PRAGMA foreign_keys = ON;
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:test', 'session', '{"sessionId":"session","updatedAt":1}', 1);
    INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES ('session', 'agent:main:test', 1, 1);
    INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('session', 1, '{"type":"message","message":{"role":"user"}}', 1);
    INSERT INTO cache_entries (scope, key, blob, updated_at)
      VALUES ('unrelated', 'bytes', X'000100FF', 3);
    INSERT INTO acp_parent_stream_events (session_id, run_id, seq, event_json, created_at)
      VALUES ('session', 'sibling', 0, '{"type":"retained"}', 1);
    CREATE TABLE local_plugin_store (key TEXT PRIMARY KEY, body BLOB) STRICT;
    INSERT INTO local_plugin_store VALUES ('retained', X'00FF');
  `);
  database
    .prepare(`INSERT INTO trajectory_runtime_events
      (session_id, seq, run_id, event_json, created_at) VALUES ('session', 0, 'run', ?, 1)`)
    .run(legacyJson);
  database.exec("ANALYZE");
}

function layout(database: DatabaseSync) {
  return database
    .prepare(`SELECT type, name, sql FROM sqlite_schema
      WHERE tbl_name = 'trajectory_runtime_events' ORDER BY type, name`)
    .all();
}

function legacyRows(database: DatabaseSync) {
  return database
    .prepare(`SELECT session_id, seq, run_id, hex(CAST(event_json AS BLOB)) AS bytes, created_at
      FROM trajectory_runtime_events ORDER BY session_id, seq`)
    .all();
}

it.each(["commit", "rollback"] as const)(
  "preserves legacy bytes and undeclared tables with atomic version publication (%s)",
  async (outcome) => {
    await withFixture("trajectory-storage.sqlite", async ({ database, migrate }) => {
      const originalRows = legacyRows(database);
      const originalLayout = layout(database);
      const witness = agentWitness(database);
      await migrate(outcome);
      expect(legacyRows(database)).toEqual(originalRows);
      expect(rows(database, "PRAGMA foreign_key_check")).toEqual([]);
      expectVersion(database, outcome === "rollback" ? predecessor : version);
      if (outcome === "rollback") {
        expect(layout(database)).toEqual(originalLayout);
      } else {
        expect(
          rows(
            database,
            "SELECT event_json, event_utf8_bytes, event_payload, event_codec FROM trajectory_runtime_events",
          ).map(Object.values),
        ).toEqual([[legacyJson, null, null, null]]);
        expect(assertPreserved(witness, agentWitness(database))).toEqual({ warnings: [] });
        database.exec(
          "SAVEPOINT changed_payload; UPDATE trajectory_runtime_events SET event_json = '{}' ",
        );
        expect(() => assertPreserved(witness, agentWitness(database))).toThrow(/changed or lost/u);
        database.exec("ROLLBACK TO changed_payload; RELEASE changed_payload");
      }
      // Historical ACP diagnostics still belong to their session window.
      const acpRows = () => rows(database, "SELECT event_json FROM acp_parent_stream_events");
      expect(acpRows()).toEqual([{ event_json: '{"type":"retained"}' }]);
      database.prepare("DELETE FROM session_windows WHERE session_id = ?").run("session");
      expect(acpRows()).toEqual([]);
    });
  },
);

it("restores the scoped predecessor without overwriting later unrelated writes", async () => {
  await withFixture(
    "trajectory-storage-restore.sqlite",
    async ({ database, restore }) => {
      await restore(() => ({
        rows: legacyRows(database),
        layout: layout(database),
        version: row(database, "PRAGMA user_version"),
      }));
    },
    "state",
  );
});
