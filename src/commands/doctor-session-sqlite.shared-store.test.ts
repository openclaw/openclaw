import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readSqliteTranscriptPayload } from "../../scripts/lib/sqlite-transcript-payload.mjs";
import {
  readSessionGoalOperationInDatabase,
  type SessionGoalOperation,
} from "../config/sessions/goals-operations.js";
import {
  loadExactSessionEntry,
  listSessionParticipantsReadOnly,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { LEGACY_PARTICIPANTS_SCHEMA } from "../state/openclaw-agent-schema-history.js";
import { seedOpenClawAgentSchemaV21 } from "../state/openclaw-agent-schema-v21.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  cleanupSessionStateForTest,
  useSessionStoreTempDirs,
} from "../test-utils/session-state-cleanup.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { sessionSqlFixture } from "./doctor-session-sqlite.sql.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-doctor-canonical-store-");

async function closeStore(store: { stateDir: string; root: string }) {
  await cleanupSessionStateForTest({ stateDir: store.stateDir, rootPath: store.root });
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

function doctor(store: Awaited<ReturnType<typeof createStore>>, mode: "recover" | "inspect") {
  return runDoctorSessionSqlite({ cfg: store.cfg, env: store.env, allAgents: true, mode });
}

function migrate(store: Awaited<ReturnType<typeof createStore>>) {
  return migrateLegacyMediaPersistence({
    configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(store.cfg, {
      env: store.env,
    }),
    env: store.env,
  });
}

async function createStore() {
  const root = sessionDirs.make();
  const stateDir = path.join(root, "state");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(root, "custom", "shared.sqlite");
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { qa: {} } },
    session: { store: storePath },
  };
  const scope = {
    agentId: "qa",
    defaultAgentId: "main",
    env,
    sessionKey: "agent:qa:doctor",
    storePath,
  };
  await upsertSessionEntryCore(scope, { sessionId: "doctor-session", updatedAt: 1 });
  const options = toDatabaseOptions(resolveSqliteReadScope(scope));
  const sqlitePath = resolveOpenClawAgentSqlitePath(options);
  await closeStore({ stateDir, root });
  return { cfg, env, options, root, scope, sqlitePath, stateDir, storePath };
}

async function createHistoricalSharedStore() {
  const store = await createStore();
  const goalOperation = {
    action: "start",
    operationId: "goal-before-participant-upgrade",
    issuedAtMs: Date.now(),
    requestFingerprint: "shared-store-goal-fixture",
    objective: "Preserve this Goal across the participant migration.",
  } satisfies SessionGoalOperation;
  const turn = await persistSessionTranscriptTurn(
    { ...store.scope, sessionId: "doctor-session" },
    {
      config: store.cfg,
      expectedSessionId: "doctor-session",
      messages: [{ message: { role: "user", content: goalOperation.objective } }],
      sessionTurnMutation: { kind: "goal", operation: goalOperation, runId: "goal-start" },
      updateMode: "none",
    },
  );
  const goalReceipt = turn.sessionTurnMutationResult?.result;
  expect(goalReceipt).toMatchObject({ action: "start", status: "started", runId: "goal-start" });
  await closeStore(store);
  const source = openNodeSqliteDatabase(store.sqlitePath);
  const retained = [
    "session_nodes",
    "session_windows",
    "transcript_events",
    "transcript_rewrite_watermarks",
    "transcript_event_identities",
    "session_transcript_active_events",
    "session_transcript_index_state",
    "session_transcript_fts",
    "session_goal_operations",
  ].map((table) => {
    const rows = source.prepare(`SELECT * FROM "${table}"`).all();
    if (table === "transcript_events") {
      for (const row of rows) {
        row.event_json = readSqliteTranscriptPayload(row);
      }
    }
    return { table, rows };
  });
  source.close();
  fs.rmSync(store.sqlitePath);
  const database = openNodeSqliteDatabase(store.sqlitePath);
  const sql = sessionSqlFixture(database);
  try {
    seedOpenClawAgentSchemaV21(database);
    removeCanonicalValidationFromHistoricalAgentFixture(database);
    database.exec("BEGIN; PRAGMA defer_foreign_keys = ON;");
    for (const { table, rows } of retained) {
      const columns = database
        .prepare(`SELECT * FROM "${table}"`)
        .columns()
        .map(({ name }) => name);
      const insert = database.prepare(
        `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      for (const row of rows) {
        insert.run(
          ...columns.map((column) => {
            const value = row[column];
            if (value === undefined) {
              throw new Error(`Missing historical fixture value ${table}.${column}`);
            }
            return value;
          }),
        );
      }
    }
    database.exec("COMMIT;");
    const goalState = readStoredGoalState(database, store.scope.sessionKey);
    database.exec("DROP TABLE session_participants;");
    database.exec(LEGACY_PARTICIPANTS_SCHEMA);
    sql`INSERT INTO session_participants VALUES (${store.scope.sessionKey}, 'human', 'person', 'profile', 3, 10, 20)`.run();
    sql`UPDATE session_nodes SET entry_json = json_set(entry_json,
          '$.createdVia', 'operator', '$.createdAt', 5,
          '$.createdActor', json('{"type":"human","id":"person","label":"Original creator"}'))
         WHERE session_key = ${store.scope.sessionKey}`.run();
    database.exec("PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;");
    database.exec(`
      INSERT INTO cache_entries (scope, key, value_json, expires_at, updated_at)
        VALUES ('doctor', 'preserved', '{"ok":true}', 100, 1);
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
    database.enableDefensive?.(false);
    database.exec(`PRAGMA writable_schema = ON;
      UPDATE sqlite_schema SET sql = 'CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL'
        WHERE name = 'idx_agent_cache_expiry';
      PRAGMA writable_schema = OFF;`);
    const schemaCookie = Number(database.prepare("PRAGMA schema_version").get()?.schema_version);
    database.exec(`PRAGMA schema_version = ${schemaCookie + 1};`);
    return { ...store, goalOperation, goalReceipt, goalState };
  } finally {
    database.close();
  }
}

function readStoredGoalState(
  database: ReturnType<typeof openNodeSqliteDatabase>,
  sessionKey: string,
) {
  const sql = sessionSqlFixture(database);
  return {
    goal: sql`SELECT json_extract(entry_json, '$.goal') AS goal_json FROM session_nodes WHERE session_key = ${sessionKey}`.get(),
    receipts:
      sql`SELECT * FROM session_goal_operations WHERE session_key = ${sessionKey} ORDER BY operation_id`.all(),
    ddl: sql`SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'session_goal_operations' ORDER BY name`.all(),
  };
}

async function repairHistoricalSharedStore(store: Awaited<ReturnType<typeof createStore>>) {
  const report = await doctor(store, "recover");
  expect(report.totals.issues).toBe(0);
  expect(report.targets[0]?.corruptRecovery).toBeUndefined();
}

function expectUpgradedSharedStore(store: Awaited<ReturnType<typeof createHistoricalSharedStore>>) {
  const reopened = openOpenClawAgentDatabase(store.options);
  const sql = sessionSqlFixture(reopened.db);
  expect(reopened.agentId).toBe("main");
  expect(sql`PRAGMA user_version`.get()?.user_version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  expect(sql`SELECT agent_id, schema_version FROM schema_meta`.get()).toEqual({
    agent_id: "main",
    schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
  });
  const entry = loadExactSessionEntry(store.scope)?.entry;
  expect(entry?.goal).toEqual(store.goalReceipt?.goal);
  expect(entry).toMatchObject({
    sessionId: "doctor-session",
    createdAt: 5,
    createdVia: "operator",
    createdActor: { type: "human", source: "profile", id: "person", label: "Original creator" },
  });
  expect(
    readStoredGoalState(requireNativeSqliteDatabase(reopened.db), store.scope.sessionKey),
  ).toEqual(store.goalState);
  expect(
    readSessionGoalOperationInDatabase(reopened, {
      ...store.scope,
      expectedSessionId: "doctor-session",
      operation: store.goalOperation,
    }),
  ).toEqual(store.goalReceipt);
  expect(listSessionParticipantsReadOnly(store.scope).get(store.scope.sessionKey)).toEqual([
    {
      identity: { type: "profile", id: "person" },
      contributionCount: 3,
      firstPromptedAt: null,
      lastPromptedAt: null,
    },
  ]);
  expect(sql`PRAGMA foreign_key_check`.all()).toEqual([]);
  expect(sql`PRAGMA integrity_check`.get()?.integrity_check).toBe("ok");
}

describe("Doctor canonical session SQLite targets", () => {
  it("fences live writers before recovering the physical shared owner", async () => {
    const store = await createHistoricalSharedStore();
    const before = fs.readFileSync(store.sqlitePath);
    // A real lease not attached to a cached handle survives maintenance's
    // local handle cleanup, just like another process's active writer.
    const lease = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: store.sqlitePath,
      env: store.env,
    });
    try {
      const migrated = await migrate(store);
      expect(migrated.changes).toEqual([]);
      expect(migrated.warnings).toEqual([
        expect.stringMatching(
          /^Agent database maintenance deferred: .*stop the Gateway and other OpenClaw processes, or reboot, then rerun openclaw doctor --fix/s,
        ),
      ]);
      await expect(repairHistoricalSharedStore(store)).rejects.toThrow(
        /stop the Gateway and other OpenClaw processes, or reboot, then rerun openclaw doctor --fix/,
      );
      expect(fs.readFileSync(store.sqlitePath)).toEqual(before);
    } finally {
      releaseOpenClawAgentDatabaseLease(lease, { env: store.env });
    }
    await repairHistoricalSharedStore(store);
    expectUpgradedSharedStore(store);
    const sql = sessionSqlFixture(openOpenClawAgentDatabase(store.options).db);
    expect(sql`SELECT value_json FROM cache_entries WHERE scope = 'doctor'`.get()).toEqual({
      value_json: '{"ok":true}',
    });
  });

  it("keeps shared data in place when participant dependencies refuse canonical-index recovery", async () => {
    const store = await createHistoricalSharedStore();
    const database = openNodeSqliteDatabase(store.sqlitePath);
    try {
      database.exec(
        "CREATE VIEW retained_participant_view AS SELECT actor_id FROM session_participants;",
      );
    } finally {
      database.close();
    }
    const report = await doctor(store, "recover");
    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({
        code: "sqlite_recovery_inspect_failed",
        message: expect.stringContaining(
          "Participant migration cannot rebuild unknown indexes, views, or triggers",
        ),
      }),
    ]);
    expect(report.targets[0]?.corruptRecovery).toBeUndefined();
    expect(
      fs.readdirSync(path.dirname(store.sqlitePath)).some((file) => file.includes(".corrupt-")),
    ).toBe(false);
    const migrated = await migrate(store);
    expect(migrated).toEqual({
      changes: [],
      warnings: [
        `Skipped agent database migration for ${store.sqlitePath}: Error: Participant migration cannot rebuild unknown indexes, views, or triggers.`,
      ],
    });
    const preserved = openNodeSqliteDatabase(store.sqlitePath, { readOnly: true });
    const sql = sessionSqlFixture(preserved);
    try {
      expect(readStoredGoalState(preserved, store.scope.sessionKey)).toEqual(store.goalState);
      expect(sql`PRAGMA user_version`.get()?.user_version).toBe(17);
      expect(sql`SELECT agent_id, schema_version FROM schema_meta`.get()).toEqual({
        agent_id: "main",
        schema_version: 17,
      });
      expect(
        sql`SELECT actor_id, contribution_count, first_prompted_at, last_prompted_at FROM session_participants`.all(),
      ).toEqual([
        { actor_id: "person", contribution_count: 3, first_prompted_at: 10, last_prompted_at: 20 },
      ]);
      expect(sql`SELECT actor_id FROM retained_participant_view`.all()).toEqual([
        { actor_id: "person" },
      ]);
      expect(
        sql`SELECT current_session_id FROM session_nodes WHERE session_key = ${store.scope.sessionKey}`.get(),
      ).toEqual({ current_session_id: "doctor-session" });
    } finally {
      preserved.close();
    }
  });

  it("never treats an exact SQLite database as a legacy import file", async () => {
    const store = await createStore();
    const original = fs.readFileSync(store.sqlitePath);
    const report = await runDoctorSessionSqlite({
      cfg: store.cfg,
      env: store.env,
      allAgents: true,
      mode: "import",
    });

    expect(report.targets).toEqual([]);
    expect(report.migrationRun).toBeUndefined();
    expect(fs.readFileSync(store.sqlitePath)).toEqual(original);
    expect(fs.existsSync(path.join(store.stateDir, "session-sqlite-migration-runs"))).toBe(false);
    expect(loadExactSessionEntry(store.scope)?.entry.sessionId).toBe("doctor-session");
  });

  it("inspects the shared SQLite database without a legacy session file", async () => {
    const store = await createStore();
    const report = await doctor(store, "inspect");

    expect(report.totals).toMatchObject({
      targets: 1,
      legacyEntries: 0,
      sqliteEntries: 1,
      issues: 0,
    });
    expect(report.targets[0]).toMatchObject({
      sqlitePath: store.sqlitePath,
      dbStats: { integrityCheck: "ok" },
    });
    expect(loadExactSessionEntry(store.scope)?.entry.sessionId).toBe("doctor-session");
    expect(openOpenClawAgentDatabase(store.options).agentId).toBe("main");
  });
});
