import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { corruptSqliteIndexKey } from "../infra/sqlite-index-corruption.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  AGENT_WRITE_LAYOUT_SCHEMA_VERSION as TARGET_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION as CURRENT_VERSION,
} from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease as withLease } from "./openclaw-agent-db-maintenance-lease.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-db-schema-helpers.js";
import { ensureOpenClawAgentDatabaseSchema as ensureSchema } from "./openclaw-agent-db-schema.js";
import { assertOpenClawMigrationWitnessPreserved as assertWitnessPreserved } from "./openclaw-migration-witness.js";
import {
  agentWitness,
  migrationFixture,
  row,
  rows,
  seedVersion,
} from "./schema-migration.test-support.js";

// Frozen input independently checks the historical admission transform.
const schemaV27 = fs.readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v27.sql", import.meta.url),
  "utf8",
);
const scope = [
  "memory_entry_origins",
  "schema_meta",
  "session_windows",
  "sqlite_stat1",
  "sqlite_stat4",
  "transcript_event_identities",
];
const withFixture = migrationFixture({ seed, predecessor: 27, target: TARGET_VERSION, scope });
function capture(database: DatabaseSync, withOrigins = true) {
  return {
    identities: rows(database, "SELECT * FROM transcript_event_identities ORDER BY seq"),
    windows: rows(database, "SELECT * FROM session_windows"),
    origins: withOrigins
      ? rows(database, "SELECT * FROM memory_entry_origins ORDER BY agent_id")
      : row(database, "SELECT 1 FROM sqlite_schema WHERE name = 'memory_entry_origins'"),
    originLayout: row(
      database,
      "SELECT wr FROM pragma_table_list WHERE name = 'memory_entry_origins'",
    )?.wr,
    indexes: rows(
      database,
      `SELECT name, sql FROM sqlite_schema
      WHERE name IN ('idx_agent_transcript_event_parent', 'idx_agent_session_windows_conversation')
      ORDER BY name`,
    ),
    versions: [
      row(database, "PRAGMA user_version")?.user_version,
      row(database, "SELECT schema_version FROM schema_meta")?.schema_version,
    ],
    foreignKeys: rows(database, "PRAGMA foreign_key_check"),
  };
}

function seed(database: DatabaseSync): void {
  database.exec(schemaV27);
  seedVersion(database, 27);
  database.exec(`
    PRAGMA foreign_keys = ON;
    INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, created_at, updated_at)
      VALUES ('conversation', 'synthetic', 'account', 'direct', 'peer', 'peer', 1, 1);
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:test', 'session', '{"sessionId":"session","updatedAt":1}', 1);
    INSERT INTO session_windows (session_id, session_key, primary_conversation_id, created_at, updated_at)
      VALUES ('session', 'agent:main:test', 'conversation', 1, 1);
    INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('session', 1, '{"type":"message","message":{"role":"user"}}', 1),
             ('session', 2, '{"type":"message","message":{"role":"assistant"}}', 2);
    INSERT INTO transcript_event_identities (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
      VALUES ('session', 'first', 1, 'message', NULL, 'once', 1),
             ('session', 'second', 2, 'message', 'first', NULL, 2);
    INSERT INTO memory_entry_origins (entry_key, agent_id, session_id, session_key, origin_class, observed_at)
      VALUES ('entry', 'main', 'session', NULL, 'owner', 1),
             ('entry', 'other', 'session', 'other-key', 'untrusted', 2);
    INSERT INTO cache_entries (scope, key, blob, updated_at) VALUES ('unrelated', 'bytes', X'000100FF', 3);
    ANALYZE;
  `);
}

function expectWitnessRejects(
  database: DatabaseSync,
  witness: ReturnType<typeof agentWitness>,
  mutation: string,
  error: RegExp,
) {
  database.exec(`SAVEPOINT retained_content; ${mutation}`);
  expect(() => assertWitnessPreserved(witness, agentWitness(database))).toThrow(error);
  database.exec("ROLLBACK TO retained_content; RELEASE retained_content");
}

it("retains the exact schema-27 admission contract", () => {
  expect(getOpenClawAgentMigrationSchema(27)).toBe(schemaV27);
});

it.each([undefined, "full"] as const)(
  "applies %s integrity policy to indexes outside the migration scope",
  async (integrityCheck) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("write-layout-integrity.sqlite");
      const source = new DatabaseSync(pathname);
      seed(source);
      source.exec(`
        CREATE TABLE untouched_payloads (value TEXT);
        CREATE INDEX idx_untouched_payload ON untouched_payloads(value);
        INSERT INTO untouched_payloads VALUES ('retained');
      `);
      source.close();
      corruptSqliteIndexKey(pathname, "idx_untouched_payload", "retained", "mismatch");
      using database = new DatabaseSync(pathname);
      await withLease({ env: state.env }, async () => {
        const migrate = () =>
          ensureSchema(database, {
            agentId: "main",
            env: state.env,
            path: pathname,
            integrityCheck,
          });
        if (integrityCheck === "full") {
          expect(migrate).toThrow(/integrity_check.*idx_untouched_payload/su);
        } else {
          expect(migrate).not.toThrow();
        }
      });
      expect(row(database, "PRAGMA user_version")?.user_version).toBe(
        integrityCheck === "full" ? 27 : CURRENT_VERSION,
      );
      expect(rows(database, "SELECT value FROM untouched_payloads NOT INDEXED")).toEqual([
        { value: "retained" },
      ]);
    });
  },
);

it.each(["commit", "without-origins", "rollback"] as const)(
  "preserves rows, undeclared tables and atomic version publication (%s)",
  async (outcome) => {
    await withFixture("write-layout.sqlite", async ({ database, migrate }) => {
      if (outcome === "without-origins") {
        database.exec("DROP TABLE memory_entry_origins");
      }
      if (outcome === "commit") {
        database.exec(`
          CREATE INDEX local_origin_lookup ON memory_entry_origins(session_key);
          CREATE TABLE local_plugin_store (key TEXT PRIMARY KEY, body BLOB) STRICT;
          INSERT INTO local_plugin_store VALUES ('retained', X'00FF');
        `);
      }
      const originalWitness = outcome === "commit" ? agentWitness(database) : undefined;
      if (originalWitness) {
        // Physical identity stays exact when no version transition occurred.
        expectWitnessRejects(
          database,
          originalWitness,
          "UPDATE memory_entry_origins SET oid = oid + 10",
          /changed or lost/u,
        );
      }
      const before = capture(database, outcome !== "without-origins");
      await migrate(outcome);
      if (originalWitness) {
        expect(assertWitnessPreserved(originalWitness, agentWitness(database))).toEqual({
          warnings: [],
        });
        for (const mutation of [
          "UPDATE memory_entry_origins SET origin_class = 'system' WHERE agent_id = 'main'",
          "ALTER TABLE memory_entry_origins ADD COLUMN unexpected TEXT",
          "DROP INDEX local_origin_lookup",
          "UPDATE local_plugin_store SET rowid = rowid + 1",
        ]) {
          expectWitnessRejects(
            database,
            originalWitness,
            mutation,
            /changed or lost|noncanonical/u,
          );
        }
      }
      const expectedVersion = outcome === "rollback" ? 27 : TARGET_VERSION;
      expect(capture(database, outcome !== "without-origins")).toEqual({
        ...before,
        versions: [expectedVersion, expectedVersion],
        foreignKeys: [],
        originLayout: outcome === "without-origins" ? undefined : outcome === "rollback" ? 0 : 1,
        indexes:
          outcome === "rollback"
            ? before.indexes
            : [
                {
                  name: "idx_agent_session_windows_conversation",
                  sql: expect.stringMatching(
                    /ON session_windows\(primary_conversation_id\)\s+WHERE primary_conversation_id IS NOT NULL/u,
                  ),
                },
              ],
      });
      if (outcome === "commit") {
        // Lookup/FK behavior and uniqueness survive index retirement and narrowing.
        const query = (sql: string) => rows(database, sql);
        expect(
          query(`SELECT event_id FROM transcript_event_identities
          WHERE session_id = 'session' AND parent_id = 'first'`),
        ).toEqual([{ event_id: "second" }]);
        database.exec("UPDATE session_windows SET updated_at = 4 WHERE session_id = 'session'");
        expect(
          query(`SELECT session_id FROM session_windows
          WHERE primary_conversation_id = 'conversation'`),
        ).toEqual([{ session_id: "session" }]);
        database.exec("DELETE FROM conversations WHERE conversation_id = 'conversation'");
        expect(query("SELECT primary_conversation_id FROM session_windows")).toEqual([
          { primary_conversation_id: null },
        ]);
        database.exec("DELETE FROM transcript_events WHERE session_id = 'session' AND seq = 1");
        expect(query("SELECT event_id FROM transcript_event_identities")).toEqual([
          { event_id: "second" },
        ]);
      }
    });
  },
);

it("restores the scoped pre-upgrade layout without overwriting later unrelated writes", async () => {
  await withFixture(
    "write-layout-restore.sqlite",
    async ({ database, restore }) => {
      await restore(() => capture(database));
    },
    "state",
  );
});
