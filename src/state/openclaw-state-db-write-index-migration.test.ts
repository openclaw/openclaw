import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSqliteAcpEventLedger } from "../acp/event-ledger.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  readSkillUsageInDatabase as readUsage,
  recordSkillUsageInDatabase as recordUsage,
} from "../skills/workshop/skill-usage.kernel.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync as closeState,
  openOpenClawStateDatabase as openState,
  repairOpenClawStateDatabaseSchema as repairState,
  runOpenClawStateWriteTransaction as writeState,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  readOpenClawStateLease as readLease,
  renewOpenClawStateLeaseInTransaction as renewLease,
} from "./openclaw-state-lease-store.js";
import { withStateMigrationBackupForTest as withBackup } from "./openclaw-state-schema.test-support.js";
import { assertSqliteMigrationScopePreserved as assertScope } from "./sqlite-migration-scope.test-support.js";

// v25 changed metadata; v26 changed only this table's physical layout.
const legacySchema = readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-state-schema-v24.sql", import.meta.url),
  "utf8",
).replace(
  /(CREATE TABLE IF NOT EXISTS session_state_heads \([\s\S]*?\n\) STRICT);/u,
  "$1, WITHOUT ROWID;",
);
const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeState();
    cleanup();
  });
});
const session = { sessionId: "replay", sessionKey: "agent:main:replay" };
const lease = { scope: "synthetic", key: "lease", owner: "owner" };

function retained(db: EngineConnection) {
  return {
    events: db.prepare("SELECT * FROM acp_replay_events ORDER BY session_id, seq").all(),
    skills: db.prepare("SELECT * FROM skill_usage ORDER BY skill_file").all(),
    leases: db.prepare("SELECT * FROM state_leases ORDER BY scope, lease_key").all(),
    leaseColumns: db.prepare("PRAGMA table_xinfo(state_leases)").all(),
  };
}

function indexes(db: EngineConnection) {
  return db
    .prepare(`SELECT name, sql FROM sqlite_schema WHERE name IN (
      'idx_acp_replay_events_session_seq', 'idx_skill_usage_key', 'idx_state_leases_owner'
    ) ORDER BY name`)
    .all();
}

function legacyDatabase(refusePublication = false) {
  const env = { OPENCLAW_STATE_DIR: directories.make("write-index-v26-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(legacySchema);
  db.exec(`PRAGMA user_version = 26;
    INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
      VALUES ('primary', 'global', 26, 1, 1);
    INSERT INTO acp_replay_sessions
      (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes)
      VALUES ('replay', 'agent:main:replay', '/synthetic', 1, 100, 100, 2, 256);
    INSERT INTO acp_replay_events
      VALUES ('replay', 1, 100, 'agent:main:replay', NULL,
        '{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"before"}}', 128);
    INSERT INTO skill_usage VALUES ('skill.md', 'skill', 'Skill', 'bundled', 100, 100, 3, 'main');
    INSERT INTO state_leases VALUES ('synthetic', 'lease', 'owner', 10000, 100, '{}', 100, 100);
    INSERT INTO diagnostic_events VALUES ('synthetic', 'retained', '{"keep":true}', 100, 1);
    CREATE INDEX local_skill_name ON skill_usage(skill_name);
    ANALYZE;`);
  if (refusePublication) {
    db.exec(`CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
  }
  return { options: { env, path: pathname }, pathname, before: retained(db), indexes: indexes(db) };
}

it.each(["runtime", "doctor"] as const)(
  "migrates v26 indexes through %s within scope and preserves subsequent owner writes",
  async (owner) => {
    const { options, pathname, before } = legacyDatabase();
    await withBackup(options, async () => {
      using scope = new DatabaseSync(pathname);
      const database = await assertScope(
        scope,
        `schema_meta config_machine_state github_publication_requests
         github_personal_publication_requests github_repository_publication_requests
         acp_replay_events skill_usage state_leases device_identities device_auth_tokens
         gateway_origin_device_tokens exec_approvals_config local_workspace_projections
         local_workspace_manifest_nodes local_workspace_source_path_sets local_workspace_tree_packs
         claw_installs template_installs claw_workspace_files template_workspace_files
         claw_package_refs template_package_refs claw_cron_refs template_cron_refs
         claw_mcp_server_refs template_mcp_server_refs agent_provenance
         sqlite_stat1 sqlite_stat4`.split(/\s+/),
        () => {
          if (owner === "doctor") {
            expect(repairState(options).warnings).toEqual([]);
          }
          return openState(options);
        },
      );
      expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(retained(database.db)).toEqual(before);
      expect(indexes(database.db).map((index) => index.name)).toEqual(["idx_state_leases_owner"]);
      expect(database.db.prepare("PRAGMA index_info(idx_state_leases_owner)").all()).toEqual([
        { seqno: 0, cid: 2, name: "owner" },
      ]);
      expect(
        database.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'local_skill_name'").get(),
      ).toEqual({ name: "local_skill_name" });

      writeState((writer) => {
        for (const ts of [200, 150]) {
          recordUsage(writer, {
            skillFile: "skill.md",
            skillKey: "skill",
            skillName: "Skill",
            skillSource: "bundled",
            agentId: "main",
            ts,
          });
        }
        expect(renewLease(writer.db, lease, 10000, undefined, 200)).toBe(10200);
        expect(
          renewLease(writer.db, { ...lease, owner: "other" }, 10000, undefined, 300),
        ).toBeUndefined();
      }, options);
      expect(readUsage(database, ["skill.md"])).toEqual([
        { skillFile: "skill.md", useCount: 5, lastUsedAtMs: 200 },
      ]);
      expect(readLease(database.db, lease)).toEqual({
        owner: "owner",
        createdAt: 100,
        expiresAt: 10200,
        heartbeatAt: 200,
        payloadJson: "{}",
      });
      const ledger = createSqliteAcpEventLedger(options);
      await ledger.recordUpdate({
        ...session,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "after" },
        },
      });
      const replay = await ledger.readReplay(session);
      expect(replay.events.map((event) => [event.seq, event.update])).toEqual([
        [1, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before" } }],
        [2, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } }],
      ]);
      await closeState();
      expect(await ledger.readReplay(session)).toEqual(replay);
    });
  },
);

it("rolls back the exact indexes, rows and version if publication fails", async () => {
  const fixture = legacyDatabase(true);
  await expect(withBackup(fixture.options, () => openState(fixture.options))).rejects.toThrow(
    "fixture publication refusal",
  );
  await closeState();
  using db = new DatabaseSync(fixture.pathname, { readOnly: true });
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
  expect(retained(db)).toEqual(fixture.before);
  expect(indexes(db)).toEqual(fixture.indexes);
});
