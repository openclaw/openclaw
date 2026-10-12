import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync as NativeDatabaseSync, type DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import * as transcriptFts from "../config/sessions/session-transcript-fts.js";
import { createTranscriptEventInserter } from "../config/sessions/transcript-payload.js";
import { assertAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "../state/openclaw-agent-schema-v24.test-support.js";
import { recordOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  completeGatewayBootLifecycle,
  inspectGatewayCrashLoopBreaker,
  recordGatewayBootStart,
} from "./gateway-boot-lifecycle.js";
import * as nodeSqlite from "./node-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { corruptSqliteIndexKey } from "./sqlite-index-corruption.test-support.js";
import { GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON } from "./startup-maintenance-required.js";
import { historicalV14AgentSchemaSql } from "./state-migrations.media-persistence.historical-schema.test-support.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import { createLegacyDatabaseFixture } from "./state-migrations.media-persistence.test-support.js";
import { repairDoctorSessionWindowsBeforeMigration } from "./state-migrations.session-window-repair.js";

const tempDirs: string[] = [];

function seedOrphanSessionWindows(pathname: string, schemaVersion: number) {
  using database = new NativeDatabaseSync(pathname);
  database.exec("PRAGMA foreign_keys = OFF;");
  const insertNode = database.prepare(`INSERT INTO session_nodes
    (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)`);
  const insertWindow = database.prepare(`INSERT INTO session_windows
    (session_id, session_key, created_at, updated_at) VALUES (?, ?, 1, 1)`);
  const insertLegacyEvent =
    schemaVersion < OPENCLAW_AGENT_SCHEMA_VERSION
      ? database.prepare(`INSERT INTO transcript_events
        (session_id, seq, event_json, created_at) VALUES (?, 0, ?, 1)`)
      : undefined;
  for (const sessionId of ["retained", "orphan-one", "orphan-two"]) {
    const sessionKey = `agent:main:${sessionId}`;
    insertNode.run(sessionKey, sessionId, JSON.stringify({ sessionId, updatedAt: 1 }));
    insertWindow.run(sessionId, sessionKey);
    const eventJson = JSON.stringify({
      id: `message-${sessionId}`,
      type: "message",
      message: { role: "user", content: sessionId },
    });
    if (insertLegacyEvent) {
      insertLegacyEvent.run(sessionId, eventJson);
    } else {
      createTranscriptEventInserter(database, sessionId)({ seq: 0, eventJson, createdAt: 1 });
    }
    transcriptFts.createSessionTranscriptFtsInserter(
      database,
      sessionId,
    )({
      messageId: `message-${sessionId}`,
      text: sessionId,
      role: "user",
      timestamp: 1,
    });
  }
  database.exec(
    "UPDATE session_windows SET rowid = 9007199254740993 WHERE session_id = 'orphan-one';",
  );
  database.exec("DELETE FROM session_nodes WHERE current_session_id != 'retained';");
}

it.each([
  ["repair", OPENCLAW_AGENT_SCHEMA_VERSION, false],
  ["unrelated violation", OPENCLAW_AGENT_SCHEMA_VERSION, false],
  ["cleanup failure", OPENCLAW_AGENT_SCHEMA_VERSION, false],
  ["repair", 24, false],
  ["repair", 24, true],
] as const)(
  "Doctor preserves original orphan history before repair (%s, schema %i, before migration %s)",
  async (scenario, schemaVersion, beforeMigration) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "main", env: state.env };
      const pathname = resolveOpenClawAgentSqlitePath(options);
      if (schemaVersion === 24) {
        openOpenClawStateDatabase({ env: state.env });
        fs.mkdirSync(path.dirname(pathname), { recursive: true });
        using source = new NativeDatabaseSync(pathname);
        source.exec(OPENCLAW_AGENT_SCHEMA_V24_SQL);
        source.exec(`PRAGMA user_version = 24;
          INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
          VALUES ('primary', 'agent', 24, 'main', '2026.9.9', 1, 1)`);
        registerOpenClawAgentDatabase({ ...options, path: pathname, schemaVersion });
      } else {
        openOpenClawAgentDatabase(options);
      }
      closeOpenClawAgentDatabasesForTest();
      seedOrphanSessionWindows(pathname, schemaVersion);
      const readRows = (database: DatabaseSync) => ({
        windows: database.prepare("SELECT * FROM session_windows ORDER BY session_id").all(),
        events: database
          .prepare(
            "SELECT session_id, seq, event_json, event_zstd, event_utf8_bytes, navigation_json, created_at FROM transcript_events ORDER BY session_id, seq",
          )
          .all(),
        search: database
          .prepare("SELECT session_id, text FROM session_transcript_fts ORDER BY session_id")
          .all(),
      });
      let original: ReturnType<typeof readRows>;
      {
        using damaged = new NativeDatabaseSync(pathname);
        if (scenario === "unrelated violation") {
          damaged.exec("PRAGMA foreign_keys = OFF;");
          damaged.exec(
            "UPDATE session_windows SET primary_conversation_id = 'missing' WHERE session_id = 'retained'",
          );
        }
        original = readRows(damaged);
        expect(
          damaged.prepare("SELECT count(*) AS count FROM pragma_foreign_key_check").get(),
        ).toEqual({
          count: scenario === "unrelated violation" ? 3 : 2,
        });
      }
      expect(
        recordOpenClawDatabaseQuarantine({
          env: state.env,
          kind: "agent",
          path: pathname,
          reason: "fixture orphan session windows",
        }),
      ).toBe(true);

      let removedSearchRows: number | undefined;
      if (scenario === "cleanup failure") {
        const remove = transcriptFts.deleteSessionTranscriptFtsRowsInTransaction;
        vi.spyOn(
          transcriptFts,
          "deleteSessionTranscriptFtsRowsInTransaction",
        ).mockImplementationOnce((...args) => {
          removedSearchRows = remove(...args);
          throw new Error("fixture cleanup refused after deleting search rows");
        });
      }
      const preMigrationChanges = beforeMigration
        ? await repairDoctorSessionWindowsBeforeMigration({
            env: state.env,
            targets: [
              {
                agentId: "main",
                path: pathname,
                realPath: fs.realpathSync(pathname),
                source: "registry",
              },
            ],
          })
        : [];
      const result = await migrateLegacyMediaPersistence({ env: state.env });
      result.changes.unshift(...preMigrationChanges);
      if (scenario === "cleanup failure") {
        expect(removedSearchRows).toBe(1);
      }
      using repaired = new NativeDatabaseSync(pathname, { readOnly: true });
      if (scenario === "repair") {
        expect(result.warnings).toEqual([]);
        expect(result.changes).toContain(
          `Removed 2 orphan session window(s) from ${pathname}; their dependent history remains in the backup.`,
        );
        expect(repaired.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(repaired.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        const retained = readRows(repaired);
        for (const key of ["windows", "events", "search"] as const) {
          expect(retained[key]).toEqual(
            original[key].filter((row) => row.session_id === "retained"),
          );
        }
        expect(() => openOpenClawAgentDatabase(options)).not.toThrow();
      } else {
        expect(result.warnings.join("\n")).toMatch(
          scenario === "unrelated violation" ? /foreign_key_check/ : /fixture cleanup refused/,
        );
        expect(readRows(repaired)).toEqual(original);
      }
      const backups = fs
        .readdirSync(path.dirname(pathname))
        .filter((name) => name.startsWith("openclaw-session-window-recovery-"));
      expect(backups).toHaveLength(1);
      if (backups.length > 0) {
        using backup = new NativeDatabaseSync(
          path.join(path.dirname(pathname), backups[0]!, "database.sqlite"),
          { readOnly: true },
        );
        expect(readRows(backup)).toEqual(original);
        expect(
          backup.prepare("SELECT count(*) AS count FROM pragma_foreign_key_check").get(),
        ).toEqual({ count: scenario === "unrelated violation" ? 3 : 2 });
      }
    });
  },
);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

function createHistoricalFixture() {
  const historicalSchema = historicalV14AgentSchemaSql();
  const stateDir = makeTempDir(tempDirs, "media-persistence-historical-v14-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const { DatabaseSync } = requireNodeSqlite();
  const pristine = new DatabaseSync(databasePath);
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
  registerOpenClawAgentDatabase({ agentId: "main", env, path: databasePath, schemaVersion: 14 });
  return { databasePath, env, eventJson, trajectoryJson };
}

describe("legacy media persistence Doctor migration from historical schemas", () => {
  it("migrates the exact v2026.7.2-beta.4 schema without losing its session or media", async () => {
    expect(createHash("sha256").update(historicalV14AgentSchemaSql()).digest("hex")).toBe(
      "955889668707fbccab70b80b5058af5a1587fd35ae32a80f8605179a68fb5117",
    );
    const { databasePath, env } = createHistoricalFixture();
    const pristinePath = path.join(makeTempDir(tempDirs, "historical-source-"), "v14.sqlite");
    fs.copyFileSync(databasePath, pristinePath);
    const pristineBytes = fs.readFileSync(pristinePath);

    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    expect(
      listSessionEntriesCore({ agentId: "main", env }).map(({ entry, sessionKey }) => ({
        sessionId: entry.sessionId,
        sessionKey,
      })),
    ).toContainEqual({
      sessionId: "historical-v14",
      sessionKey: "agent:main:historical-v14",
    });
    closeOpenClawAgentDatabasesForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        migrated.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
      expect(migrated.prepare("SELECT * FROM session_transcript_cold_archives").all()).toEqual([]);
      expect(
        migrated
          .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
          .get("agent:main:historical-v14"),
      ).toEqual({ entry_valid: 1 });
      expect(
        migrated.prepare("SELECT main_key FROM session_key_contract WHERE id = 1").get(),
      ).toEqual({
        main_key: "main",
      });
      const row = migrated
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 0")
        .get("historical-v14") as { event_json: string };
      const message = (JSON.parse(row.event_json) as { message: Record<string, unknown> }).message;
      expect(message).not.toHaveProperty("MediaPath");
      expect(message["__openclaw"]).toMatchObject({
        media: [expect.objectContaining({ path: "/media/v14.png" })],
      });
      expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
    expect(fs.readFileSync(pristinePath)).toEqual(pristineBytes);
  });

  it("preserves an unreleased session database and its misplaced copy before Doctor repairs", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-unreleased-session-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    openOpenClawStateDatabase({ env });
    const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER,
          agent_id TEXT, app_version TEXT, created_at INTEGER, updated_at INTEGER
        );
        INSERT INTO schema_meta VALUES ('primary', 'agent', 6, 'main', NULL, 1, 1);
        CREATE TABLE transcript_events (
          session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER
        );
        INSERT INTO transcript_events VALUES (
          'retained-session', 0,
          '{"type":"message","message":{"role":"user","content":"retained","MediaPath":"/media/retained.png"}}', 1
        );
        PRAGMA user_version = 6;
      `);
    } finally {
      database.close();
    }
    const before = fs.readFileSync(databasePath);
    const copyPath = path.join(stateDir, "agents", "copy", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    fs.copyFileSync(databasePath, copyPath);

    const result = await migrateLegacyMediaPersistence({
      env,
      configuredAgentDatabaseTargets: [
        { agentId: "main", path: databasePath },
        { agentId: "copy", path: copyPath },
      ],
    });

    expect(result.warnings).toEqual([
      expect.stringContaining("contains an unreleased session schema (version 6)"),
      expect.stringContaining("contains an unreleased session schema (version 6)"),
    ]);
    expect(fs.readFileSync(databasePath)).toEqual(before);
    expect(fs.readFileSync(copyPath)).toEqual(before);
    expect(fs.readdirSync(path.dirname(copyPath))).toEqual(["openclaw-agent.sqlite"]);
  });

  it("keeps media bytes and v16 markers when registered coverage rejects before commit", async () => {
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
      const published = migrationDatabase.prepare("PRAGMA user_version").get()?.user_version === 17;
      if (!published) {
        return;
      }
      expect(
        migrationDatabase.prepare("SELECT event_json FROM transcript_events").get(),
      ).not.toEqual({ event_json: eventJson });
      expect(
        migrationDatabase.prepare("SELECT event_json FROM trajectory_runtime_events").get(),
      ).not.toEqual({ event_json: trajectoryJson });
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
            .prepare("SELECT hex(CAST(event_json AS BLOB)) AS bytes FROM trajectory_runtime_events")
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
  });
});

function createV17AdditiveFixture(
  options: { schemaDrift?: "missing-cache-table" | "missing-memory-trigger" } = {},
) {
  const stateDir = makeTempDir(tempDirs, "media-persistence-v17-additive-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 17 });
  closeOpenClawStateDatabaseForTest();

  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  database.exec(`
    DROP TRIGGER session_conversations_route_context_invalidate_after_update;
    ALTER TABLE session_conversations DROP COLUMN route_context_json;
    DROP INDEX idx_agent_transcript_event_identity_sequence;
  `);
  if (options.schemaDrift === "missing-cache-table") {
    database.exec("DROP TABLE cache_entries;");
  } else if (options.schemaDrift === "missing-memory-trigger") {
    database.exec("DROP TRIGGER memory_index_sources_revision_after_update;");
  }
  database.close();
  return { databasePath, env };
}

describe("legacy media persistence additive schema repair", () => {
  it("repairs v17 additive session schema before canonical index validation", async () => {
    const { databasePath, env } = createV17AdditiveFixture();
    const { DatabaseSync } = requireNodeSqlite();
    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    openOpenClawAgentDatabase({ agentId: "main", env });
    const repaired = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(repaired.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        repaired
          .prepare(
            "SELECT name FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'",
          )
          .get(),
      ).toEqual({ name: "route_context_json" });
      expect(
        repaired
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'session_conversations_route_context_invalidate_after_update'",
          )
          .get(),
      ).toEqual({ name: "session_conversations_route_context_invalidate_after_update" });
      expect(
        repaired
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_event_identity_sequence'",
          )
          .get(),
      ).toEqual({ name: "idx_agent_transcript_event_identity_sequence" });
    } finally {
      repaired.close();
    }
  });

  it.each(["missing-cache-table", "missing-memory-trigger"] as const)(
    "keeps non-additive v17 schema drift rejected during index repair: %s",
    async (schemaDrift) => {
      const { databasePath, env } = createV17AdditiveFixture({
        schemaDrift,
      });
      const { DatabaseSync } = requireNodeSqlite();
      const result = await migrateLegacyMediaPersistence({ env });
      expect(() => openOpenClawAgentDatabase({ agentId: "main", env })).toThrow(
        /uses schema version 17/,
      );
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(
        schemaDrift === "missing-cache-table"
          ? /missing table cache_entries/
          : /missing or drifted trigger memory_index_sources_revision_after_update/,
      );
      const rejected = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(rejected.prepare("PRAGMA user_version").get()).toEqual({ user_version: 17 });
        expect(
          rejected
            .prepare(
              "SELECT name FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'",
            )
            .get(),
        ).toBeUndefined();
        expect(
          rejected
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_event_identity_sequence'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        rejected.close();
      }
    },
  );
});

describe("media persistence gateway lifecycle recovery", () => {
  it("leaves maintenance completion to Doctor after a successful media migration", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-startup-recovery-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 14 });

    const nowMs = 1_000_000;
    for (let index = 0; index < 3; index += 1) {
      const bootId = recordGatewayBootStart(env, nowMs + index);
      completeGatewayBootLifecycle(
        bootId,
        {
          outcome: "startup_failed",
          reason: `migration required ${index}`,
          startupReason: GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON,
        },
        env,
        nowMs + index + 1,
      );
    }
    expect(inspectGatewayCrashLoopBreaker(env, nowMs + 4).tripped).toBe(false);

    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare(
          "SELECT COUNT(*) AS count FROM gateway_boot_lifecycle WHERE outcome = 'startup_failed'",
        )
        .get(),
    ).toMatchObject({ count: 3 });
    expect(inspectGatewayCrashLoopBreaker(env, nowMs + 5)).toMatchObject({
      tripped: false,
      uncleanBoots: 0,
    });
  });
});

it.each([true])(
  "Doctor preserves and rebuilds a corrupt agent index (quarantined=%s)",
  async (quarantined) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "main", env: state.env };
      const initial = openOpenClawAgentDatabase(options);
      initial.db.exec(`INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:index-original', 'fixture-session', '{"sessionId":"fixture-session","updatedAt":1}', 1)`);
      const payloadSql = "SELECT session_key, entry_json FROM session_nodes NOT INDEXED";
      const rows = initial.db.prepare(payloadSql).all();
      closeOpenClawAgentDatabasesForTest();
      const index = "sqlite_autoindex_session_nodes_1";
      corruptSqliteIndexKey(initial.path, index, "index-original", "index-damaged!");
      if (quarantined) {
        expect(
          recordOpenClawDatabaseQuarantine({
            env: state.env,
            kind: "agent",
            path: initial.path,
            reason: `row 1 missing from index ${index}`,
          }),
        ).toBe(true);
      }

      const result = await migrateLegacyMediaPersistence({ env: state.env });

      expect(result.warnings).toEqual([]);
      expect(result.changes).toContain(
        `Warning: Rebuilt corrupt agent main SQLite indexes: ${index}. No table rows were removed.`,
      );
      const backupLine = result.changes.find((line) =>
        line.startsWith("Saved pre-repair SQLite backup: "),
      );
      expect(backupLine).toBeDefined();
      const backup = new NativeDatabaseSync(
        backupLine!.slice("Saved pre-repair SQLite backup: ".length),
        {
          readOnly: true,
        },
      );
      try {
        expect(backup.prepare("PRAGMA integrity_check").all()).toContainEqual({
          integrity_check: `row 1 missing from index ${index}`,
        });
        expect(backup.prepare(payloadSql).all()).toEqual(rows);
      } finally {
        backup.close();
      }
      const repaired = openOpenClawAgentDatabase(options);
      expect(repaired.db.prepare("PRAGMA integrity_check").all()).toEqual([
        { integrity_check: "ok" },
      ]);
      expect(repaired.db.prepare(payloadSql).all()).toEqual(rows);

      closeOpenClawAgentDatabasesForTest();
      expect(
        recordOpenClawDatabaseQuarantine({
          env: state.env,
          kind: "agent",
          path: initial.path,
          reason: `row 1 missing from index ${index}`,
        }),
      ).toBe(true);
      const resumed = await migrateLegacyMediaPersistence({ env: state.env });
      expect(resumed).toEqual({ changes: [], warnings: [] });
      expect(openOpenClawAgentDatabase(options).db.prepare(payloadSql).all()).toEqual(rows);
    });
  },
);
