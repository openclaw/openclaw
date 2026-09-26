import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { assertAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as nodeSqlite from "./node-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { historicalV14AgentSchemaSql } from "./state-migrations.media-persistence.historical-schema.test-support.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

function createHistoricalFixture() {
  const historicalSchema = historicalV14AgentSchemaSql();
  const stateDir = makeTempDir(tempDirs, "media-persistence-historical-v14-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  const pristinePath = path.join(stateDir, "historical", "v14-pristine.sqlite");
  const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(pristinePath), { recursive: true });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const { DatabaseSync } = requireNodeSqlite();
  const pristine = new DatabaseSync(pristinePath);
  const eventJson = JSON.stringify({
    id: "event-v14",
    message: { MediaPath: "/media/v14.png", content: "historical", role: "user" },
    parentId: null,
    timestamp: 1000,
    type: "message",
  });
  const trajectoryJson = JSON.stringify({
    data: {
      messagesSnapshot: [{ role: "user", MediaPath: "/media/v14.png" }],
    },
  });
  try {
    pristine.exec(historicalSchema);
    pristine.exec("PRAGMA user_version = 14;");
    pristine
      .prepare(
        `INSERT INTO schema_meta (
             meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
           ) VALUES ('primary', 'agent', 14, 'main', '2026.7.2-beta.4', 1000, 1000)`,
      )
      .run();
    const entry = JSON.stringify({
      sessionId: "historical-v14",
      status: "done",
      updatedAt: 1000,
    });
    pristine
      .prepare(
        `INSERT INTO session_nodes (
             session_key, current_session_id, entry_json, updated_at, status, created_at, created_via
           ) VALUES (?, ?, ?, ?, 'done', ?, 'operator')`,
      )
      .run("agent:main:historical-v14", "historical-v14", entry, 1000, 1000);
    pristine
      .prepare(
        `INSERT INTO session_windows (
             session_id, session_key, session_scope, created_at, updated_at, status, display_name
           ) VALUES (?, ?, 'conversation', ?, ?, 'done', 'historical v14')`,
      )
      .run("historical-v14", "agent:main:historical-v14", 1000, 1000);
    pristine
      .prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)",
      )
      .run("historical-v14", eventJson, 1100);
    pristine
      .prepare(
        `INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at)
           VALUES (?, 0, 'run-v14', ?, 1100)`,
      )
      .run("historical-v14", trajectoryJson);
    pristine
      .prepare(
        `INSERT INTO transcript_event_identities (
             session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at
           ) VALUES (?, ?, 0, 'message', NULL, NULL, ?)`,
      )
      .run("historical-v14", "event-v14", 1100);
  } finally {
    pristine.close();
  }
  const pristineHash = createHash("sha256").update(fs.readFileSync(pristinePath)).digest("hex");
  fs.copyFileSync(pristinePath, databasePath);
  registerOpenClawAgentDatabase({ agentId: "main", env, path: databasePath, schemaVersion: 14 });
  return { databasePath, env, eventJson, pristineHash, pristinePath, trajectoryJson };
}

describe("legacy media persistence Doctor migration coverage from historical v14", () => {
  it.each(["before-write", "before-commit"] as const)(
    "keeps media bytes and v16 markers when registered coverage rejects %s",
    async (boundary) => {
      const { databasePath, env, eventJson, trajectoryJson } = createHistoricalFixture();
      const scope = createOpenClawDatabaseMaintenanceScope();
      const { DatabaseSync } = requireNodeSqlite();
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      let migrationDatabase: DatabaseSync | undefined;
      const observer = vi
        .spyOn(nodeSqlite, "openNodeSqliteDatabase")
        .mockImplementation((pathname, options) => {
          const database = openDatabase(pathname, options);
          if (pathname === databasePath && !options?.readOnly) {
            migrationDatabase = database;
          }
          return database;
        });
      let rejected = false;
      scope.addAgentSchemaMigrationCheck((migration) => {
        if (migration.supportedVersion !== 17) {
          return;
        }
        assertAgentDatabaseMaintenanceAuthority();
        expect(migration).toEqual({
          agentId: "main",
          path: databasePath,
          foundVersion: 16,
          supportedVersion: 17,
        });
        if (!migrationDatabase) {
          throw new Error("Fixture did not observe the media migration database");
        }
        const published =
          migrationDatabase.prepare("PRAGMA user_version").get()?.user_version === 17;
        if (boundary === "before-commit" && !published) {
          return;
        }
        if (published) {
          expect(
            migrationDatabase.prepare("SELECT event_json FROM transcript_events").get(),
          ).not.toEqual({ event_json: eventJson });
          expect(
            migrationDatabase.prepare("SELECT event_json FROM trajectory_runtime_events").get(),
          ).not.toEqual({ event_json: trajectoryJson });
        }
        rejected = true;
        throw new Error("Recovery backup coverage is no longer current");
      });
      try {
        const result = await scope.run(() => migrateLegacyMediaPersistence({ env }));
        expect(rejected).toBe(true);
        expect(result.changes).toEqual([]);
        expect(result.warnings).toEqual([
          expect.stringContaining("Recovery backup coverage is no longer current"),
        ]);
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          // The v14→v16 prerequisite commits independently of media retirement.
          expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 16 });
          expect(
            database
              .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
              .get(),
          ).toEqual({ schema_version: 16 });
          expect(
            database
              .prepare("SELECT hex(CAST(event_json AS BLOB)) AS bytes FROM transcript_events")
              .get(),
          ).toEqual({ bytes: Buffer.from(eventJson).toString("hex").toUpperCase() });
          expect(
            database
              .prepare(
                "SELECT hex(CAST(event_json AS BLOB)) AS bytes FROM trajectory_runtime_events",
              )
              .get(),
          ).toEqual({ bytes: Buffer.from(trajectoryJson).toString("hex").toUpperCase() });
          expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
        } finally {
          database.close();
        }
      } finally {
        observer.mockRestore();
        await scope.close();
      }
    },
  );
});
