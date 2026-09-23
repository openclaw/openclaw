import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  historicalV14AgentSchemaSql,
  historicalV15AgentSchemaSql,
} from "./state-migrations.media-persistence.historical-schema.test-support.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import { cleanupMediaPersistenceFixtures } from "./state-migrations.media-persistence.test-support.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupMediaPersistenceFixtures(tempDirs);
});

describe("legacy media persistence Doctor migration from historical schemas", () => {
  it.each([
    {
      version: 14,
      source: "v2026.7.2-beta.4",
      appVersion: "2026.7.2-beta.4",
      schema: historicalV14AgentSchemaSql,
      sha256: "955889668707fbccab70b80b5058af5a1587fd35ae32a80f8605179a68fb5117",
    },
    {
      version: 15,
      source: "509a5f0373764",
      appVersion: "2026.7.2",
      schema: historicalV15AgentSchemaSql,
      sha256: "75953ef97a738251822fc5aaf283bbe55fbcabe8702ad771892cdafc85d8e6b9",
    },
  ])(
    "migrates a copy of the exact $source schema without losing its session",
    async ({ version, appVersion, schema, sha256 }) => {
      const historicalSchema = schema();
      expect(createHash("sha256").update(historicalSchema).digest("hex")).toBe(sha256);
      expect(historicalSchema).not.toContain("  project_id TEXT,\n");

      const stateDir = makeTempDir(tempDirs, `media-persistence-historical-v${version}-`);
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const pristinePath = path.join(stateDir, "historical", `v${version}-pristine.sqlite`);
      const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(pristinePath), { recursive: true });
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });

      const { DatabaseSync } = requireNodeSqlite();
      const pristine = new DatabaseSync(pristinePath);
      try {
        pristine.exec(historicalSchema);
        pristine.exec(`PRAGMA user_version = ${version};`);
        pristine
          .prepare(
            `INSERT INTO schema_meta (
             meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
           ) VALUES ('primary', 'agent', ?, 'main', ?, 1000, 1000)`,
          )
          .run(version, appVersion);
        const entry = JSON.stringify({
          sessionId: `historical-v${version}`,
          status: "done",
          updatedAt: 1000,
        });
        pristine
          .prepare(
            `INSERT INTO session_nodes (
             session_key, current_session_id, entry_json, updated_at, status, created_at, created_via
           ) VALUES (?, ?, ?, ?, 'done', ?, 'operator')`,
          )
          .run(`agent:main:historical-v${version}`, `historical-v${version}`, entry, 1000, 1000);
        pristine
          .prepare(
            `INSERT INTO session_windows (
             session_id, session_key, session_scope, created_at, updated_at, status, display_name
           ) VALUES (?, ?, 'conversation', ?, ?, 'done', 'historical v${version}')`,
          )
          .run(`historical-v${version}`, `agent:main:historical-v${version}`, 1000, 1000);
        const event = {
          id: `event-v${version}`,
          message: { MediaPath: `/media/v${version}.png`, content: "historical", role: "user" },
          parentId: null,
          timestamp: 1000,
          type: "message",
        };
        pristine
          .prepare(
            "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)",
          )
          .run(`historical-v${version}`, JSON.stringify(event), 1100);
        pristine
          .prepare(
            `INSERT INTO transcript_event_identities (
             session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at
           ) VALUES (?, ?, 0, 'message', NULL, NULL, ?)`,
          )
          .run(`historical-v${version}`, `event-v${version}`, 1100);
      } finally {
        pristine.close();
      }
      const pristineHash = createHash("sha256").update(fs.readFileSync(pristinePath)).digest("hex");
      fs.copyFileSync(pristinePath, databasePath);
      registerOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: databasePath,
        schemaVersion: version,
      });

      const result = await migrateLegacyMediaPersistence({ env });
      expect(result.warnings).toEqual([]);
      expect(
        listSessionEntriesCore({ agentId: "main", env }).map(({ entry, sessionKey }) => ({
          sessionId: entry.sessionId,
          sessionKey,
        })),
      ).toContainEqual({
        sessionId: `historical-v${version}`,
        sessionKey: `agent:main:historical-v${version}`,
      });
      closeOpenClawAgentDatabasesForTest();

      const migrated = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
          user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        });
        expect(
          migrated
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get(),
        ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
        expect(migrated.prepare("SELECT * FROM session_transcript_cold_archives").all()).toEqual(
          [],
        );
        expect(
          migrated
            .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
            .get(`agent:main:historical-v${version}`),
        ).toEqual({ entry_valid: 1 });
        expect(
          migrated.prepare("SELECT main_key FROM session_key_contract WHERE id = 1").get(),
        ).toEqual({ main_key: "main" });
        const row = migrated
          .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 0")
          .get(`historical-v${version}`) as { event_json: string };
        const message = (JSON.parse(row.event_json) as { message: Record<string, unknown> })
          .message;
        expect(message).not.toHaveProperty("MediaPath");
        expect(message["__openclaw"]).toMatchObject({
          media: [expect.objectContaining({ path: `/media/v${version}.png` })],
        });
        expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        migrated.close();
      }

      expect(createHash("sha256").update(fs.readFileSync(pristinePath)).digest("hex")).toBe(
        pristineHash,
      );
      const original = new DatabaseSync(pristinePath, { readOnly: true });
      try {
        expect(original.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
        expect(
          original
            .prepare(
              "SELECT name FROM pragma_table_info('session_nodes') WHERE name = 'entry_valid'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        original.close();
      }
    },
  );
});
