import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { recordAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { repairDoctorAgentDeletionJournal } from "./doctor-agent-deletion-journal.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";
import {
  assertDoctorMaintenanceReady,
  classifyDoctorMaintenanceRefusal,
} from "./doctor-maintenance-inspection.js";
import { sessionSqlFixture } from "./doctor-session-sqlite.sql.test-support.js";

it.each([
  "intact",
  "lost-with-history",
  "lost-empty",
  "lost-empty-wal",
  "lost-empty-sequence",
  "recorded-empty",
  "recorded-secondary",
] as const)("verifies required agents after schema-26 repair (%s)", async (scenario) => {
  await withOpenClawTestState({ scenario: "empty" }, async (state) => {
    const agentId = scenario === "recorded-secondary" ? "worker" : "main";
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {}, ...(agentId === "worker" ? { worker: {} } : {}) },
        defaults: { systemAgent: { agentId: "main" } },
      },
      plugins: { enabled: false },
    };
    await state.writeConfig(cfg);
    const shared = openOpenClawStateDatabase({ env: state.env });
    if (scenario !== "intact") {
      shared.db.exec("DROP TABLE agent_deletion_journal");
    }
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
    const pathname = path.join(state.agentDir(agentId), "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    const transcript =
      '{"type":"message","id":"reply","parentId":null,"timestamp":1,"message":{"role":"assistant","content":[{"type":"text","text":"preserved schema-26 reply"}]}}';
    using seed = new DatabaseSync(pathname);
    const seedSql = sessionSqlFixture(seed);
    seed.exec(
      fs.readFileSync(
        new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v26.sql", import.meta.url),
        "utf8",
      ),
    );
    seed.exec(`PRAGMA user_version = 26;
      INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
      VALUES ('primary', 'agent', 26, '${agentId}', 1, 1);`);
    const empty = scenario.startsWith("lost-empty") || scenario.startsWith("recorded-");
    if (!empty) {
      seed.exec(`
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:main', 'history', '{"sessionId":"history","updatedAt":1}', 1);
      INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES ('history', 'agent:main:main', 1, 1);
      INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at)
      VALUES ('agent:main:main', '{"type":"observation","pluginId":null,"accountId":null,"senderKind":"unknown"}', 'cli', 1, 1, 1);`);
      seedSql`INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('history', 0, ${transcript}, 1)`.run();
    } else {
      // The observed turn-less 70ca91f3 store has these first-use memory rows.
      seed.exec(`
          INSERT INTO memory_index_meta (key, value) VALUES ('memory_index_meta_v1', '{"model":"fts-only","provider":"none"}'), ('memory_vector_rebuild_v1', 'clean');
        `);
    }
    if (scenario === "lost-empty-wal") {
      seed.exec("PRAGMA journal_mode = WAL");
    }
    if (scenario === "lost-empty-sequence") {
      seed.exec(`
          CREATE TABLE discarded (id INTEGER PRIMARY KEY AUTOINCREMENT);
          INSERT INTO discarded DEFAULT VALUES;
          DELETE FROM discarded;
        `);
    }
    seed.close();
    if (scenario.startsWith("recorded-")) {
      runOpenClawStateWriteTransaction(
        (database) => recordAgentDeletionRecoveryHolds(database, [{ agentId, path: pathname }]),
        { env: state.env },
      );
    }
    const before = fs.readFileSync(pathname);
    const recovery = await repairDoctorAgentDeletionJournal({
      preflight: await prepareDoctorDatabasePreflight(),
      shouldRepair: true,
      env: state.env,
    });
    await migrateLegacyMediaPersistence({
      env: state.env,
      preparedDiscovery: (await prepareDoctorDatabasePreflight()).agentDatabaseMigrationDiscovery,
    });
    const ready = assertDoctorMaintenanceReady(cfg, state.env, () => {});
    const refused = ["lost-with-history", "lost-empty-sequence", "recorded-empty"].includes(
      scenario,
    );
    if (refused) {
      if (scenario === "lost-with-history") {
        expect(recovery.warnings.join("\n")).toContain("agents add main");
      }
      const error = await ready.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("schema version 26");
      expect(classifyDoctorMaintenanceRefusal(error)).toEqual({
        kind: "data-at-risk",
        reason: "incomplete-migration",
      });
    } else {
      await expect(ready).resolves.toEqual({ schemaPublicationDeferred: false });
    }
    if (refused || scenario === "recorded-secondary") {
      expect(fs.readFileSync(pathname)).toEqual(before);
    } else {
      using migrated = new DatabaseSync(pathname, { readOnly: true });
      const sql = sessionSqlFixture(migrated);
      expect(sql`PRAGMA user_version`.get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(sql`SELECT event_json FROM transcript_events`.all()).toEqual(
        empty ? [] : [{ event_json: transcript }],
      );
      expect(sql`SELECT actor_id FROM session_participants`.all()).toEqual(
        empty ? [] : [{ actor_id: "cli" }],
      );
    }
  });
});
