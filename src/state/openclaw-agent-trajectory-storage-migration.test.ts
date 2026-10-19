import { constants, DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { restoreDoctorMigrationBackup } from "../commands/doctor-migration-backup-restore.js";
import { createScopedMigrationSnapshot } from "../infra/sqlite-migration-scoped-snapshot.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-db-schema-helpers.js";
import { ensureOpenClawAgentSchema } from "./openclaw-agent-db-schema.js";
import {
  assertOpenClawMigrationWitnessPreserved,
  captureOpenClawMigrationWitness,
} from "./openclaw-migration-witness.js";
import { resolveSchemaMigrationBackupTables } from "./schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

const predecessor = 29;
const scope = ["schema_meta", "sqlite_stat1", "sqlite_stat4", "trajectory_runtime_events"];
const legacyJson = ` { "type": "legacy", "data": ${JSON.stringify("日本語🦞\\u0000".repeat(500))} } `;

function seed(database: DatabaseSync): void {
  database.exec(getOpenClawAgentMigrationSchema(predecessor));
  database.exec(`
    PRAGMA user_version = ${predecessor};
    PRAGMA foreign_keys = ON;
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
      VALUES ('primary', 'agent', ${predecessor}, 'main', 1, 1);
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

describe("agent trajectory payload migration", () => {
  it.each(["commit", "rollback"] as const)(
    "preserves legacy bytes and undeclared tables with atomic version publication (%s)",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("trajectory-storage.sqlite");
        using database = new DatabaseSync(pathname);
        seed(database);
        const originalRows = legacyRows(database);
        const originalLayout = layout(database);
        const witness = captureOpenClawMigrationWitness(database, {
          role: "agent",
          agentId: "main",
        });
        if (outcome === "rollback") {
          database.setAuthorizer((action, name, value) =>
            action === constants.SQLITE_PRAGMA &&
            name === "user_version" &&
            value === String(AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION)
              ? constants.SQLITE_DENY
              : constants.SQLITE_OK,
          );
        }
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          await assertSqliteMigrationScopePreserved(database, scope, () => {
            const migrate = () =>
              ensureOpenClawAgentSchema(
                database,
                "main",
                pathname,
                AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION,
              );
            if (outcome === "rollback") {
              expect(migrate).toThrow(/authoriz/u);
            } else {
              migrate();
            }
          });
        });
        database.setAuthorizer(null);
        expect(legacyRows(database)).toEqual(originalRows);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        const expectedVersion =
          outcome === "rollback" ? predecessor : AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION;
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(expectedVersion);
        expect(
          database.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version,
        ).toBe(expectedVersion);
        if (outcome === "rollback") {
          expect(layout(database)).toEqual(originalLayout);
        } else {
          expect(
            database
              .prepare(
                "SELECT event_json, event_utf8_bytes, event_payload, event_codec FROM trajectory_runtime_events",
              )
              .all(),
          ).toEqual([
            {
              event_json: legacyJson,
              event_utf8_bytes: null,
              event_payload: null,
              event_codec: null,
            },
          ]);
          expect(
            assertOpenClawMigrationWitnessPreserved(
              witness,
              captureOpenClawMigrationWitness(database, { role: "agent", agentId: "main" }),
            ),
          ).toEqual({ warnings: [] });
          database.exec(
            "SAVEPOINT changed_payload; UPDATE trajectory_runtime_events SET event_json = '{}' ",
          );
          expect(() =>
            assertOpenClawMigrationWitnessPreserved(
              witness,
              captureOpenClawMigrationWitness(database, { role: "agent", agentId: "main" }),
            ),
          ).toThrow(/changed or lost/u);
          database.exec("ROLLBACK TO changed_payload; RELEASE changed_payload");
        }
        // Historical ACP diagnostics still belong to their session window.
        const acpRows = () =>
          database.prepare("SELECT event_json FROM acp_parent_stream_events").all();
        expect(acpRows()).toEqual([{ event_json: '{"type":"retained"}' }]);
        database.prepare("DELETE FROM session_windows WHERE session_id = ?").run("session");
        expect(acpRows()).toEqual([]);
      });
    },
  );

  it("restores the scoped predecessor without overwriting later unrelated writes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.statePath("trajectory-storage-restore.sqlite");
      const backupPath = state.statePath("trajectory-storage.scoped.bak");
      using database = new DatabaseSync(pathname);
      seed(database);
      const originalRows = legacyRows(database);
      const originalLayout = layout(database);
      const statistics = database.prepare("SELECT * FROM sqlite_stat1 ORDER BY tbl, idx").all();
      expect(
        resolveSchemaMigrationBackupTables({
          kind: "agent",
          foundVersion: predecessor,
          supportedVersion: AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION,
        }),
      ).toEqual(scope);
      await withAgentDatabaseMaintenanceLease({ env: state.env }, async (lease) => {
        await createScopedMigrationSnapshot({
          sourcePath: pathname,
          targetPath: backupPath,
          tables: scope,
          beforePublish: () => lease.assertOwned(),
        });
        ensureOpenClawAgentSchema(
          database,
          "main",
          pathname,
          AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION,
        );
      });
      database.exec("UPDATE cache_entries SET blob = X'BEEF' WHERE scope = 'unrelated'");
      await assertSqliteMigrationScopePreserved(database, scope, () =>
        restoreDoctorMigrationBackup({ sourcePath: pathname, backupPath, env: state.env }),
      );
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(predecessor);
      expect(layout(database)).toEqual(originalLayout);
      expect(legacyRows(database)).toEqual(originalRows);
      expect(database.prepare("SELECT * FROM sqlite_stat1 ORDER BY tbl, idx").all()).toEqual(
        statistics,
      );
      expect(database.prepare("SELECT hex(blob) AS bytes FROM cache_entries").get()?.bytes).toBe(
        "BEEF",
      );
    });
  });
});
