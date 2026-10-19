import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_V25_SQL } from "../state/openclaw-agent-schema-v25.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  cleanupMediaPersistenceFixtures,
  createEvent,
  createLegacyDatabaseFixture,
} from "./state-migrations.media-persistence.test-support.js";
import { buildLegacyStateMigrationPreludeSteps } from "./state-migrations.prelude.js";
import { runLegacyStateMigrationSteps } from "./state-migrations.steps.js";

const tempDirs: string[] = [];
afterEach(() => cleanupMediaPersistenceFixtures(tempDirs));

it("keeps unrelated legacy content and planner maintenance outside a version migration", async () => {
  const stateDir = makeTempDir(tempDirs, "media-bounded-version-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  const pathname = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const event = JSON.stringify({
    type: "message",
    id: "retained",
    parentId: null,
    timestamp: 1,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current]] retained" }],
      MediaPath: "/media/retained.png",
    },
  });
  const trajectory = JSON.stringify({
    data: { messagesSnapshot: [{ role: "user", MediaPath: "/media/retained.png" }] },
  });
  const archive = Buffer.from(`${event}\n`);
  const archiveName = "retained.jsonl.deleted.2026-07-24T01-02-03.000Z";
  const archivePath = path.join(
    resolveSqliteTranscriptArchiveDirectory({ agentId: "main", path: pathname }),
    archiveName,
  );
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, archive);
  {
    using source = openNodeSqliteDatabase(pathname);
    source.exec(OPENCLAW_AGENT_SCHEMA_V25_SQL);
    source.exec(`
      PRAGMA user_version = 25;
      INSERT INTO schema_meta VALUES ('primary', 'agent', 25, 'main', '2026.9.9', 1, 1);
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at)
        VALUES ('agent:main:retained', 'retained', '{"sessionId":"retained","updatedAt":1,"memoryFlushCompactionCount":3}', 1, 1);
      INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
        VALUES ('retained', 'agent:main:retained', 1, 1);
      INSERT INTO cache_entries (scope, key, value_json, updated_at)
        VALUES ('planner-proof', 'retained', '{}', 1);
    `);
    source
      .prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('retained', 0, ?, 1)",
      )
      .run(event);
    source
      .prepare(
        "INSERT INTO trajectory_runtime_events (session_id, seq, event_json, created_at) VALUES ('retained', 0, ?, 1)",
      )
      .run(trajectory);
    source
      .prepare(`INSERT INTO session_transcript_archives
        (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at)
        VALUES ('retained', 'generation', 'agent:main:retained', 'deleted', 'identity', ?, ?, ?, 1)`)
      .run(archive, createHash("sha256").update(archive).digest("hex"), archiveName);
    source.exec(`
      ANALYZE;
      UPDATE sqlite_stat1 SET stat = '7 1 1 1' WHERE idx = 'idx_agent_cache_updated';
    `);
  }
  registerOpenClawAgentDatabase({ agentId: "main", env, path: pathname, schemaVersion: 25 });
  const currentPath = createLegacyDatabaseFixture({
    agentId: "current",
    env,
    schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    eventsBySession: {
      current: [
        createEvent({
          id: "current",
          parentId: null,
          timestamp: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[[reply_to_current]] current" }],
          },
        }),
      ],
    },
  });
  const runPrelude = () =>
    withDoctorSqliteMaintenanceLock({
      env,
      operation: "bounded agent migration",
      run: async (authority) => {
        const scope = createOpenClawDatabaseMaintenanceScope({
          schemaMaintenance: true,
          assertOwnerCurrent: () => authority.assertCurrent(),
        });
        try {
          const { sources } = await scope.run(() =>
            runLegacyStateMigrationSteps(
              buildLegacyStateMigrationPreludeSteps({
                mode: "doctor",
                invocationPurpose: "doctor",
                config: { agents: { ownership: "explicit", entries: { main: {}, current: {} } } },
                configPath: path.join(stateDir, "openclaw.json"),
                configIncludedPaths: [],
                stateDir,
                env,
                homedir: () => stateDir,
                agentDatabaseTargets: [
                  { agentId: "main", path: pathname },
                  { agentId: "current", path: currentPath },
                ],
                pluginSessionStoreAgentIds: [],
                legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
              }).filter((step) =>
                ["media-persistence", "session-entry-state", "transcript-directives"].includes(
                  step.id,
                ),
              ),
            ),
          );
          return {
            changes: sources.flatMap((source) => source.changes),
            warnings: sources.flatMap((source) => source.warnings),
          };
        } finally {
          await scope.close();
        }
      },
    });

  const result = await runPrelude();
  expect(result).toEqual({
    changes: [
      `Upgraded agent database schema in ${pathname}: v25 -> v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
      expect.stringMatching(/^Saved pre-repair SQLite backup: /),
      `Repaired historical transcripts in ${currentPath}: 1 active session(s), 0 archived transcript(s).`,
    ],
    warnings: [],
  });
  expect(fs.readFileSync(archivePath)).toEqual(archive);
  {
    using migrated = openNodeSqliteDatabase(pathname, { readOnly: true });
    expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    expect(migrated.prepare("SELECT event_json FROM transcript_events").get()?.event_json).toBe(
      event,
    );
    expect(
      migrated.prepare("SELECT event_json FROM trajectory_runtime_events").get()?.event_json,
    ).toBe(trajectory);
    expect(
      migrated.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_agent_cache_updated'").get()
        ?.stat,
    ).toBe("7 1 1 1");
    expect(
      migrated.prepare("SELECT archive_blob, published_at FROM session_transcript_archives").get(),
    ).toEqual({
      archive_blob: new Uint8Array(archive),
      published_at: null,
    });
    expect(
      migrated
        .prepare("SELECT 1 FROM schema_meta WHERE meta_key = 'media-persistence-rows-v1'")
        .get(),
    ).toBeUndefined();
    expect(
      migrated
        .prepare("SELECT 1 FROM schema_meta WHERE meta_key = 'historical-transcript-directives-v1'")
        .get(),
    ).toBeUndefined();
    expect(migrated.prepare("SELECT entry_json FROM session_nodes").get()?.entry_json).toBe(
      '{"sessionId":"retained","updatedAt":1,"memoryFlushCompactionCount":3}',
    );
  }
  {
    using current = openNodeSqliteDatabase(currentPath, { readOnly: true });
    expect(
      JSON.parse(
        String(current.prepare("SELECT event_json FROM transcript_events").get()?.event_json),
      ).message.content,
    ).toEqual([{ type: "text", text: "current" }]);
  }

  // An explicit same-version Doctor invocation still owns outstanding repair.
  const repaired = await runPrelude();
  expect(repaired.warnings).toEqual([]);
  expect(repaired.changes).toContain(
    `Migrated media persistence in ${pathname}: 1 transcript session(s), 1 trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
  );
  expect(repaired.changes).toContain(
    `Migrated canonical transcript archive media in ${pathname}: 1 archive(s).`,
  );
  {
    using sameVersion = openNodeSqliteDatabase(pathname, { readOnly: true });
    expect(
      sameVersion.prepare("SELECT archive_blob FROM session_transcript_archives").get()
        ?.archive_blob,
    ).toEqual(new Uint8Array(fs.readFileSync(archivePath)));
    expect(
      JSON.parse(
        String(sameVersion.prepare("SELECT entry_json FROM session_nodes").get()?.entry_json),
      ),
    ).toEqual({
      sessionId: "retained",
      updatedAt: 1,
      memoryFlush: { kind: "succeeded", compactionCount: 3 },
    });
    expect(
      JSON.parse(
        String(sameVersion.prepare("SELECT event_json FROM transcript_events").get()?.event_json),
      ).message.content,
    ).toEqual([{ type: "text", text: "retained" }]);
  }
});
