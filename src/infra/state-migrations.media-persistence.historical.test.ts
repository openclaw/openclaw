import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync as NativeDatabaseSync, type DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import * as transcriptFts from "../config/sessions/session-transcript-fts.js";
import { createTranscriptEventInserter } from "../config/sessions/transcript-payload.js";
import { assertAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-maintenance-authority.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "../state/openclaw-agent-schema-v24.test-support.js";
import { seedOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  completeGatewayBootLifecycle,
  inspectGatewayCrashLoopBreakerAsync,
  beginGatewayBootLifecycle,
} from "./gateway-boot-lifecycle.js";
import * as nodeSqlite from "./node-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import type { SqlConnection } from "./sql-connection.js";
import { corruptSqliteIndexKey } from "./sqlite-index-corruption.test-support.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";
import { GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON } from "./startup-maintenance-required.js";
import { historicalV14AgentSchemaSql } from "./state-migrations.media-persistence.historical-schema.test-support.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import { createLegacyDatabaseFixture } from "./state-migrations.media-persistence.test-support.js";
import { repairDoctorSessionWindowsBeforeMigration } from "./state-migrations.session-window-repair.js";

const tempDirs: string[] = [];
const get = (db: Pick<SqlConnection, "prepare">, sql: string) => db.prepare(sql).get();
const all = (db: Pick<SqlConnection, "prepare">, sql: string) => db.prepare(sql).all();
const schemaVersionSql = "SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'";
const routeColumnSql =
  "SELECT name FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'";
const identityIndex = "idx_agent_transcript_event_identity_sequence";
const routeTrigger = "session_conversations_route_context_invalidate_after_update";
const schemaObjectSql = (type: string, name: string) =>
  `SELECT name FROM sqlite_schema WHERE type = '${type}' AND name = '${name}'`;

function createAgentPaths(prefix: string) {
  const stateDir = makeTempDir(tempDirs, prefix);
  const env = { OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  const dbPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return { stateDir, env, dbPath };
}

function expectVersion(db: DatabaseSync, version: number) {
  expect(get(db, "PRAGMA user_version")).toEqual({ user_version: version });
  expect(get(db, schemaVersionSql)).toEqual({ schema_version: version });
}

function openFixtureDatabase(pathname: string, readOnly = false) {
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(pathname, { readOnly });
}

function seedOrphanSessionWindows(pathname: string, schemaVersion: number) {
  using db = nodeSqlite.openNodeSqliteDatabase(pathname);
  admitSqliteSchema(db);
  db.exec("PRAGMA foreign_keys = OFF;");
  const insertNode = db.prepare(`INSERT INTO session_nodes
    (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)`);
  const insertWindow = db.prepare(`INSERT INTO session_windows
    (session_id, session_key, created_at, updated_at) VALUES (?, ?, 1, 1)`);
  const insertLegacyEvent =
    schemaVersion < OPENCLAW_AGENT_SCHEMA_VERSION
      ? db.prepare(`INSERT INTO transcript_events
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
      createTranscriptEventInserter(db, sessionId)({ seq: 0, eventJson, createdAt: 1 });
    }
    const insertSearch = transcriptFts.createSessionTranscriptFtsInserter(db, sessionId);
    insertSearch([
      {
        messageId: `message-${sessionId}`,
        text: sessionId,
        role: "user",
        timestamp: 1,
      },
    ]);
  }
  db.exec("UPDATE session_windows SET rowid = 9007199254740993 WHERE session_id = 'orphan-one';");
  db.exec("DELETE FROM session_nodes WHERE current_session_id != 'retained';");
}

it.each([
  ["repair", OPENCLAW_AGENT_SCHEMA_VERSION, false],
  ["unrelated violation", OPENCLAW_AGENT_SCHEMA_VERSION, false],
  ["cleanup failure", OPENCLAW_AGENT_SCHEMA_VERSION, false],
  ["repair", 24, false],
  ["repair", 24, true],
] as const)(
  "Doctor preserves original orphan history before repair (%s, schema %i, before migration %s)",
  (scenario, schemaVersion, beforeMigration) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const pathname = resolveOpenClawAgentSqlitePath(options);
      if (schemaVersion === 24) {
        openOpenClawStateDatabase({ env });
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
      const readRows = (db: DatabaseSync) => ({
        windows: all(db, "SELECT * FROM session_windows ORDER BY session_id"),
        events: all(
          db,
          "SELECT session_id, seq, event_json, event_zstd, event_utf8_bytes, navigation_json, created_at FROM transcript_events ORDER BY session_id, seq",
        ),
        search: all(db, "SELECT session_id, text FROM session_transcript_fts ORDER BY session_id"),
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
        expect(get(damaged, "SELECT count(*) AS count FROM pragma_foreign_key_check")).toEqual({
          count: scenario === "unrelated violation" ? 3 : 2,
        });
      }
      const quarantine = { env, kind: "agent" as const, path: pathname };
      seedOpenClawDatabaseQuarantine({ ...quarantine, reason: "fixture orphan session windows" });

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
            env,
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
      const result = await migrateLegacyMediaPersistence({ env });
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
          const expected = original[key]
            .filter((row) => row.session_id === "retained")
            .map((row) =>
              key === "windows" && schemaVersion === 24
                ? Object.assign({}, row, {
                    row_transcript_json: null,
                    row_transcript_updated_at: null,
                  })
                : row,
            );
          expect(retained[key]).toEqual(expected);
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
      using backup = new NativeDatabaseSync(
        path.join(path.dirname(pathname), backups[0]!, "database.sqlite"),
        { readOnly: true },
      );
      expect(readRows(backup)).toEqual(original);
      expect(get(backup, "SELECT count(*) AS count FROM pragma_foreign_key_check")).toEqual({
        count: scenario === "unrelated violation" ? 3 : 2,
      });
    }),
);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

function createHistoricalFixture() {
  const { env, dbPath } = createAgentPaths("media-persistence-historical-v14-");
  const eventJson = JSON.stringify({
    id: "event-v14",
    message: { MediaPath: "/media/v14.png", content: "historical", role: "user" },
    parentId: null,
    timestamp: 1000,
    type: "message",
  });
  const mediaMessage = { role: "user", MediaPath: "/media/v14.png" };
  const trajectoryJson = JSON.stringify({ data: { messagesSnapshot: [mediaMessage] } });
  {
    using pristine = openFixtureDatabase(dbPath);
    pristine.exec(historicalV14AgentSchemaSql());
    pristine.exec(`PRAGMA user_version = 14;
      INSERT INTO schema_meta
      (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', 'agent', 14, 'main', '2026.7.2-beta.4', 1000, 1000)`);
    const entry = JSON.stringify({ sessionId: "historical-v14", status: "done", updatedAt: 1000 });
    pristine
      .prepare(`INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, updated_at, status, created_at, created_via)
      VALUES ('agent:main:historical-v14', 'historical-v14', ?, 1000, 'done', 1000, 'operator')`)
      .run(entry);
    pristine.exec(`INSERT INTO session_windows
      (session_id, session_key, session_scope, created_at, updated_at, status, display_name)
      VALUES ('historical-v14', 'agent:main:historical-v14', 'conversation', 1000, 1000, 'done', 'historical v14')`);
    pristine
      .prepare(`INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('historical-v14', 0, ?, 1100)`)
      .run(eventJson);
    pristine
      .prepare(`INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at)
      VALUES ('historical-v14', 0, 'run-v14', ?, 1100)`)
      .run(trajectoryJson);
    pristine.exec(`INSERT INTO transcript_event_identities
      (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
      VALUES ('historical-v14', 'event-v14', 0, 'message', NULL, NULL, 1100)`);
  }
  registerOpenClawAgentDatabase({ agentId: "main", env, path: dbPath, schemaVersion: 14 });
  return { dbPath, env, eventJson, trajectoryJson };
}

it("migrates the exact v2026.7.2-beta.4 schema without losing its session or media", async () => {
  expect(createHash("sha256").update(historicalV14AgentSchemaSql()).digest("hex")).toBe(
    "955889668707fbccab70b80b5058af5a1587fd35ae32a80f8605179a68fb5117",
  );
  const { dbPath, env } = createHistoricalFixture();
  const pristinePath = path.join(makeTempDir(tempDirs, "historical-source-"), "v14.sqlite");
  fs.copyFileSync(dbPath, pristinePath);
  const pristineBytes = fs.readFileSync(pristinePath);

  const result = await migrateLegacyMediaPersistence({ env });
  expect(result.warnings).toEqual([]);
  expect(
    listSessionEntriesCore({ agentId: "main", env }).map(({ entry, sessionKey }) => ({
      sessionId: entry.sessionId,
      sessionKey,
    })),
  ).toContainEqual({ sessionId: "historical-v14", sessionKey: "agent:main:historical-v14" });
  closeOpenClawAgentDatabasesForTest();

  using migrated = openFixtureDatabase(dbPath, true);
  expectVersion(migrated, OPENCLAW_AGENT_SCHEMA_VERSION);
  expect(all(migrated, "SELECT * FROM session_transcript_cold_archives")).toEqual([]);
  expect(
    get(
      migrated,
      "SELECT entry_valid FROM session_nodes WHERE session_key = 'agent:main:historical-v14'",
    ),
  ).toEqual({ entry_valid: 1 });
  expect(get(migrated, "SELECT main_key FROM session_key_contract WHERE id = 1")).toEqual({
    main_key: "main",
  });
  const event = get(
    migrated,
    "SELECT event_json FROM transcript_events WHERE session_id = 'historical-v14' AND seq = 0",
  ) as { event_json: string };
  const message = (JSON.parse(event.event_json) as { message: Record<string, unknown> }).message;
  expect(message).not.toHaveProperty("MediaPath");
  expect(message["__openclaw"]).toMatchObject({
    media: [expect.objectContaining({ path: "/media/v14.png" })],
  });
  expect(get(migrated, "PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  expect(all(migrated, "PRAGMA foreign_key_check")).toEqual([]);
  expect(fs.readFileSync(pristinePath)).toEqual(pristineBytes);
});

it("preserves an unreleased session database and its misplaced copy before Doctor repairs", async () => {
  const { stateDir, env, dbPath } = createAgentPaths("media-persistence-unreleased-");
  {
    using db = openFixtureDatabase(dbPath);
    db.exec(`
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
  }
  const before = fs.readFileSync(dbPath);
  const copyPath = path.join(stateDir, "agents", "copy", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(copyPath), { recursive: true });
  fs.copyFileSync(dbPath, copyPath);

  const result = await migrateLegacyMediaPersistence({
    env,
    configuredAgentDatabaseTargets: [
      { agentId: "main", path: dbPath },
      { agentId: "copy", path: copyPath },
    ],
  });

  expect(result.warnings).toEqual([
    expect.stringContaining("contains an unreleased session schema (version 6)"),
    expect.stringContaining("contains an unreleased session schema (version 6)"),
  ]);
  expect(fs.readFileSync(dbPath)).toEqual(before);
  expect(fs.readFileSync(copyPath)).toEqual(before);
  expect(fs.readdirSync(path.dirname(copyPath))).toEqual(["openclaw-agent.sqlite"]);
});

it("keeps media bytes and v16 markers when registered coverage rejects before commit", async () => {
  const { dbPath, env, eventJson, trajectoryJson } = createHistoricalFixture();
  const scope = createOpenClawDatabaseMaintenanceScope();
  const openDatabase = nodeSqlite.openNodeSqliteDatabase;
  let migrationDb: DatabaseSync | undefined;
  const observer = vi
    .spyOn(nodeSqlite, "openNodeSqliteDatabase")
    .mockImplementation((pathname, options) => {
      const db = openDatabase(pathname, options);
      if (pathname === dbPath && !options?.readOnly) {
        migrationDb = db;
      }
      return db;
    });
  let rejected = false;
  scope.addAgentSchemaMigrationCheck((migration) => {
    if (migration.supportedVersion !== 17) {
      return;
    }
    assertAgentDatabaseMaintenanceAuthority();
    expect(migration).toEqual({
      agentId: "main",
      path: dbPath,
      foundVersion: 16,
      supportedVersion: 17,
    });
    if (!migrationDb) {
      throw new Error("Fixture did not observe the media migration database");
    }
    const published = get(migrationDb, "PRAGMA user_version")?.user_version === 17;
    if (!published) {
      return;
    }
    expect(get(migrationDb, "SELECT event_json FROM transcript_events")).not.toEqual({
      event_json: eventJson,
    });
    expect(get(migrationDb, "SELECT event_json FROM trajectory_runtime_events")).not.toEqual({
      event_json: trajectoryJson,
    });
    rejected = true;
    throw new Error("Recovery backup coverage is no longer current");
  });
  try {
    const result = await scope.run(() => migrateLegacyMediaPersistence({ env }));
    expect(rejected).toBe(true);
    expect(result.changes).toEqual([
      expect.stringContaining(
        `Saved pre-repair SQLite backup: ${path.join(path.dirname(dbPath), "openclaw-media-persistence-recovery-")}`,
      ),
    ]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Recovery backup coverage is no longer current"),
    ]);
    using db = openFixtureDatabase(dbPath, true);
    // The v14→v16 prerequisite commits independently of media retirement.
    expectVersion(db, 16);
    for (const [table, json] of [
      ["transcript_events", eventJson],
      ["trajectory_runtime_events", trajectoryJson],
    ] as const) {
      const expected = { bytes: Buffer.from(json).toString("hex").toUpperCase() };
      expect(get(db, `SELECT hex(CAST(event_json AS BLOB)) AS bytes FROM ${table}`)).toEqual(
        expected,
      );
    }
    expect(get(db, "PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  } finally {
    observer.mockRestore();
    await scope.close();
  }
});
function createV17AdditiveFixture(
  options: { schemaDrift?: "missing-cache-table" | "missing-memory-trigger" } = {},
) {
  const stateDir = makeTempDir(tempDirs, "media-persistence-v17-additive-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const dbPath = createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 17 });
  closeOpenClawStateDatabaseForTest();

  using db = openFixtureDatabase(dbPath);
  db.exec(`
    DROP TRIGGER session_conversations_route_context_invalidate_after_update;
    ALTER TABLE session_conversations DROP COLUMN route_context_json;
    DROP INDEX idx_agent_transcript_event_identity_sequence;
  `);
  if (options.schemaDrift === "missing-cache-table") {
    db.exec("DROP TABLE cache_entries;");
  } else if (options.schemaDrift === "missing-memory-trigger") {
    db.exec("DROP TRIGGER memory_index_sources_revision_after_update;");
  }
  return { dbPath, env };
}

it.each([undefined, "missing-cache-table", "missing-memory-trigger"] as const)(
  "repairs only additive v17 schema drift before canonical index validation: %s",
  async (schemaDrift) => {
    const { dbPath, env } = createV17AdditiveFixture({ schemaDrift });
    const result = await migrateLegacyMediaPersistence({ env });
    if (schemaDrift) {
      expect(() => openOpenClawAgentDatabase({ agentId: "main", env })).toThrow(
        /uses schema version 17/,
      );
      expect(result.warnings).toEqual([
        expect.stringMatching(
          schemaDrift === "missing-cache-table"
            ? /missing table cache_entries/
            : /missing or drifted trigger memory_index_sources_revision_after_update/,
        ),
      ]);
    } else {
      expect(result.warnings).toEqual([]);
      openOpenClawAgentDatabase({ agentId: "main", env });
    }
    using repaired = openFixtureDatabase(dbPath, true);
    expect({
      version: get(repaired, "PRAGMA user_version"),
      column: get(repaired, routeColumnSql),
      index: get(repaired, schemaObjectSql("index", identityIndex)),
    }).toEqual({
      version: { user_version: schemaDrift ? 17 : OPENCLAW_AGENT_SCHEMA_VERSION },
      column: schemaDrift ? undefined : { name: "route_context_json" },
      index: schemaDrift ? undefined : { name: identityIndex },
    });
    if (!schemaDrift) {
      expect(get(repaired, schemaObjectSql("trigger", routeTrigger))).toEqual({
        name: routeTrigger,
      });
    }
  },
);

it("leaves maintenance completion to Doctor after a successful media migration", async () => {
  const stateDir = makeTempDir(tempDirs, "media-persistence-startup-recovery-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 14 });

  const nowMs = 1_000_000;
  for (let index = 0; index < 3; index += 1) {
    const bootId = (await beginGatewayBootLifecycle(env, nowMs + index)).id;
    await completeGatewayBootLifecycle(
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
  expect((await inspectGatewayCrashLoopBreakerAsync(env, nowMs + 4)).tripped).toBe(false);

  const result = await migrateLegacyMediaPersistence({ env });

  expect(result.warnings).toEqual([]);
  expect(
    get(
      openOpenClawStateDatabase({ env }).db,
      "SELECT COUNT(*) AS count FROM gateway_boot_lifecycle WHERE outcome = 'startup_failed'",
    ),
  ).toMatchObject({ count: 3 });
  const breaker = await inspectGatewayCrashLoopBreakerAsync(env, nowMs + 5);
  expect(breaker).toMatchObject({ tripped: false, uncleanBoots: 0 });
});
it("Doctor preserves and rebuilds a quarantined corrupt agent index", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const initial = openOpenClawAgentDatabase(options);
    initial.db.exec(`INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:index-original', 'fixture-session', '{"sessionId":"fixture-session","updatedAt":1}', 1)`);
    const payloadSql = "SELECT session_key, entry_json FROM session_nodes NOT INDEXED";
    const rows = initial.db.prepare(payloadSql).all();
    closeOpenClawAgentDatabasesForTest();
    const index = "sqlite_autoindex_session_nodes_1";
    corruptSqliteIndexKey(initial.path, index, "index-original", "index-damaged!");
    const quarantine = () =>
      seedOpenClawDatabaseQuarantine({
        env,
        kind: "agent",
        path: initial.path,
        reason: `row 1 missing from index ${index}`,
      });
    quarantine();

    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      `Warning: Rebuilt corrupt agent main SQLite indexes: ${index}. No table rows were removed.`,
    );
    const backupLine = result.changes.find((line) =>
      line.startsWith("Saved pre-repair SQLite backup: "),
    );
    expect(backupLine).toBeDefined();
    using backup = new NativeDatabaseSync(
      backupLine!.slice("Saved pre-repair SQLite backup: ".length),
      { readOnly: true },
    );
    expect(backup.prepare("PRAGMA integrity_check").all()).toContainEqual({
      integrity_check: `row 1 missing from index ${index}`,
    });
    expect(backup.prepare(payloadSql).all()).toEqual(rows);
    const repaired = openOpenClawAgentDatabase(options);
    expect(repaired.db.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);
    expect(repaired.db.prepare(payloadSql).all()).toEqual(rows);

    closeOpenClawAgentDatabasesForTest();
    quarantine();
    const resumed = await migrateLegacyMediaPersistence({ env });
    expect(resumed).toEqual({ changes: [], warnings: [] });
    expect(openOpenClawAgentDatabase(options).db.prepare(payloadSql).all()).toEqual(rows);
  }));
