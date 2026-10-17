import fs from "node:fs";
import { constants, DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { restoreDoctorMigrationBackup } from "../commands/doctor-migration-backup-restore.js";
import { corruptSqliteIndexKey } from "../infra/sqlite-index-corruption.test-support.js";
import { createScopedMigrationSnapshot } from "../infra/sqlite-migration-scoped-snapshot.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-db-schema-helpers.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import {
  assertOpenClawMigrationWitnessPreserved,
  captureOpenClawMigrationWitness,
} from "./openclaw-migration-witness.js";
import { resolveSchemaMigrationBackupTables } from "./schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

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

function seed(database: DatabaseSync): void {
  database.exec(schemaV27);
  database.exec(`
    PRAGMA user_version = 27;
    PRAGMA foreign_keys = ON;
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
      VALUES ('primary', 'agent', 27, 'main', 1, 1);
    INSERT INTO conversations
      (conversation_id, channel, account_id, kind, peer_id, delivery_target, created_at, updated_at)
      VALUES ('conversation', 'synthetic', 'account', 'direct', 'peer', 'peer', 1, 1);
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:test', 'session', '{"sessionId":"session","updatedAt":1}', 1);
    INSERT INTO session_windows
      (session_id, session_key, primary_conversation_id, created_at, updated_at)
      VALUES ('session', 'agent:main:test', 'conversation', 1, 1);
    INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('session', 1, '{"type":"message","message":{"role":"user"}}', 1),
             ('session', 2, '{"type":"message","message":{"role":"assistant"}}', 2);
    INSERT INTO transcript_event_identities
      (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
      VALUES ('session', 'first', 1, 'message', NULL, 'once', 1),
             ('session', 'second', 2, 'message', 'first', NULL, 2);
    INSERT INTO memory_entry_origins
      (entry_key, agent_id, session_id, session_key, origin_class, observed_at)
      VALUES ('entry', 'main', 'session', NULL, 'owner', 1),
             ('entry', 'other', 'session', 'other-key', 'untrusted', 2);
    INSERT INTO cache_entries (scope, key, blob, updated_at)
      VALUES ('unrelated', 'bytes', X'000100FF', 3);
    ANALYZE;
  `);
}

function indexDefinitions(database: DatabaseSync) {
  return database
    .prepare(`SELECT name, sql FROM sqlite_schema
    WHERE name IN ('idx_agent_transcript_event_parent', 'idx_agent_session_windows_conversation')
    ORDER BY name`)
    .all();
}

describe("agent write layout migration", () => {
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
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          const migrate = () =>
            ensureOpenClawAgentDatabaseSchema(database, {
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
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
          integrityCheck === "full" ? 27 : OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(database.prepare("SELECT value FROM untouched_payloads NOT INDEXED").all()).toEqual([
          { value: "retained" },
        ]);
      });
    },
  );

  it.each(["commit", "without-origins", "rollback"] as const)(
    "preserves rows, undeclared tables and atomic version publication (%s)",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("write-layout.sqlite");
        using database = new DatabaseSync(pathname);
        seed(database);
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
        const captureWitness = () =>
          captureOpenClawMigrationWitness(database, { role: "agent", agentId: "main" });
        const originalWitness = outcome === "commit" ? captureWitness() : undefined;
        if (originalWitness) {
          // Physical identity stays exact when no version transition occurred.
          database.exec(
            "SAVEPOINT physical_identity; UPDATE memory_entry_origins SET oid = oid + 10",
          );
          expect(() =>
            assertOpenClawMigrationWitnessPreserved(originalWitness, captureWitness()),
          ).toThrow(/changed or lost/u);
          database.exec("ROLLBACK TO physical_identity; RELEASE physical_identity");
        }
        const indexes = indexDefinitions(database);
        const identities = database
          .prepare("SELECT * FROM transcript_event_identities ORDER BY seq")
          .all();
        const windows = database.prepare("SELECT * FROM session_windows").all();
        const origins =
          outcome === "without-origins"
            ? []
            : database.prepare("SELECT * FROM memory_entry_origins ORDER BY agent_id").all();
        if (outcome === "rollback") {
          database.setAuthorizer((action, name, value) =>
            action === constants.SQLITE_PRAGMA &&
            name === "user_version" &&
            value === String(OPENCLAW_AGENT_SCHEMA_VERSION)
              ? constants.SQLITE_DENY
              : constants.SQLITE_OK,
          );
        }
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          const migrate = () =>
            ensureOpenClawAgentDatabaseSchema(database, {
              agentId: "main",
              env: state.env,
              path: pathname,
            });
          await assertSqliteMigrationScopePreserved(database, scope, () => {
            if (outcome === "rollback") {
              expect(migrate).toThrow(/authoriz/u);
            } else {
              migrate();
            }
          });
        });
        database.setAuthorizer(null);
        if (originalWitness) {
          expect(
            assertOpenClawMigrationWitnessPreserved(originalWitness, captureWitness()),
          ).toEqual({
            warnings: [],
          });
          for (const mutation of [
            "UPDATE memory_entry_origins SET origin_class = 'system' WHERE agent_id = 'main'",
            "ALTER TABLE memory_entry_origins ADD COLUMN unexpected TEXT",
            "DROP INDEX local_origin_lookup",
            "UPDATE local_plugin_store SET rowid = rowid + 1",
          ]) {
            database.exec("SAVEPOINT retained_content");
            database.exec(mutation);
            expect(() =>
              assertOpenClawMigrationWitnessPreserved(originalWitness, captureWitness()),
            ).toThrow(/changed or lost|noncanonical/u);
            database.exec("ROLLBACK TO retained_content; RELEASE retained_content");
          }
        }
        expect(
          database.prepare("SELECT * FROM transcript_event_identities ORDER BY seq").all(),
        ).toEqual(identities);
        expect(database.prepare("SELECT * FROM session_windows").all()).toEqual(windows);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        const expectedVersion = outcome === "rollback" ? 27 : OPENCLAW_AGENT_SCHEMA_VERSION;
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(expectedVersion);
        expect(
          database.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version,
        ).toBe(expectedVersion);
        if (outcome === "rollback") {
          expect(indexDefinitions(database)).toEqual(indexes);
        } else {
          expect(indexDefinitions(database)).toEqual([
            {
              name: "idx_agent_session_windows_conversation",
              sql: expect.stringMatching(
                /ON session_windows\(primary_conversation_id\)\s+WHERE primary_conversation_id IS NOT NULL/u,
              ),
            },
          ]);
        }
        if (outcome === "without-origins") {
          expect(
            database
              .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'memory_entry_origins'")
              .get(),
          ).toBeUndefined();
        } else {
          expect(
            database.prepare("SELECT * FROM memory_entry_origins ORDER BY agent_id").all(),
          ).toEqual(origins);
          expect(
            database
              .prepare("SELECT wr FROM pragma_table_list WHERE name = 'memory_entry_origins'")
              .get()?.wr,
          ).toBe(outcome === "rollback" ? 0 : 1);
        }
        if (outcome === "commit") {
          // Lookup/FK behavior and uniqueness survive index retirement and narrowing.
          expect(
            database
              .prepare(
                "SELECT event_id FROM transcript_event_identities WHERE session_id = 'session' AND parent_id = 'first'",
              )
              .all(),
          ).toEqual([{ event_id: "second" }]);
          database.exec("UPDATE session_windows SET updated_at = 4 WHERE session_id = 'session'");
          expect(
            database
              .prepare(
                "SELECT session_id FROM session_windows WHERE primary_conversation_id = 'conversation'",
              )
              .all(),
          ).toEqual([{ session_id: "session" }]);
          database.exec("DELETE FROM conversations WHERE conversation_id = 'conversation'");
          expect(
            database.prepare("SELECT primary_conversation_id FROM session_windows").get()
              ?.primary_conversation_id,
          ).toBeNull();
          database.exec("DELETE FROM transcript_events WHERE session_id = 'session' AND seq = 1");
          expect(
            database.prepare("SELECT event_id FROM transcript_event_identities").all(),
          ).toEqual([{ event_id: "second" }]);
        }
      });
    },
  );

  it("restores the scoped pre-upgrade layout without overwriting later unrelated writes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.statePath("write-layout-restore.sqlite");
      const backupPath = state.statePath("write-layout.scoped.bak");
      using database = new DatabaseSync(pathname);
      seed(database);
      const indexes = indexDefinitions(database);
      const statistics = database.prepare("SELECT * FROM sqlite_stat1 ORDER BY tbl, idx").all();
      expect(
        resolveSchemaMigrationBackupTables({
          kind: "agent",
          foundVersion: 27,
          supportedVersion: 28,
        }),
      ).toEqual(scope);
      await withAgentDatabaseMaintenanceLease({ env: state.env }, async (lease) => {
        await createScopedMigrationSnapshot({
          sourcePath: pathname,
          targetPath: backupPath,
          tables: scope,
          beforePublish: () => lease.assertOwned(),
        });
        ensureOpenClawAgentDatabaseSchema(database, {
          agentId: "main",
          env: state.env,
          path: pathname,
        });
      });
      database.exec("UPDATE cache_entries SET blob = X'BEEF' WHERE scope = 'unrelated'");
      await assertSqliteMigrationScopePreserved(database, scope, () =>
        restoreDoctorMigrationBackup({ sourcePath: pathname, backupPath, env: state.env }),
      );
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(27);
      expect(indexDefinitions(database)).toEqual(indexes);
      expect(database.prepare("SELECT * FROM sqlite_stat1 ORDER BY tbl, idx").all()).toEqual(
        statistics,
      );
      expect(
        database
          .prepare("SELECT wr FROM pragma_table_list WHERE name = 'memory_entry_origins'")
          .get()?.wr,
      ).toBe(0);
      expect(database.prepare("SELECT hex(blob) AS bytes FROM cache_entries").get()?.bytes).toBe(
        "BEEF",
      );
    });
  });
});
