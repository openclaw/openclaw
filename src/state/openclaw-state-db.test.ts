// OpenClaw state database tests cover state DB migrations and persistence.
import { deepStrictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  cleanupTempDirs,
  makeTempDir,
  useAutoCleanupTempDirTracker,
} from "../../test/helpers/temp-dir.js";
import { resolveCronDeliveryPlan } from "../cron/delivery-plan.js";
import { loadedCronStoreFromRows, loadCronRows } from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import {
  countFailedDeliveryQueueEntries,
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntry,
  terminalizePendingDeliveryQueueEntry,
} from "../infra/delivery-queue-sqlite.js";
import { seedDeliveryQueueEntry } from "../infra/delivery-queue-sqlite.test-support.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { readStableSqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readRetainedAgentDeletionsFromDatabase } from "./agent-deletion-journal.read.js";
import {
  readConfigMachineState,
  readConfigMachineStateWithMetadata,
} from "./config-machine-state.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { listOpenClawRegisteredAgentDatabases } from "./openclaw-agent-db-registry.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import { snapshotPreflightSourceManifest } from "./openclaw-database-preflight.test-support.js";
import { recordOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.js";
import { recordOpenClawStateDatabaseOpenFailure } from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  createCorruptionRefusalStateDatabaseFixture,
  createDanglingSkillWorkshopReviewIndex,
  readDanglingSkillWorkshopReviewIndex,
} from "./openclaw-state-db-corruption.test-support.js";
import { hasDanglingSkillWorkshopCollectionReviewIndex } from "./openclaw-state-db-doctor-schema.js";
import {
  runHotRollbackJournalRecoveryProbe,
  runConcurrentSchemaProbe,
} from "./openclaw-state-db-hot-journal.test-support.js";
import { prepareStateDatabaseSchemaRepair } from "./openclaw-state-db-maintenance.js";
import { ensureGitHubPublicationSchema } from "./openclaw-state-db-schema-additive.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseReadabilityForDoctor,
  repairOpenClawStateDatabaseSchema,
  prepareOpenClawStateDatabaseSchema,
  runWithOpenClawStateBusyTimeout,
  runOpenClawStateWriteTransaction,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";
import { STATE_SCHEMA_11_TO_10_TABLES_SQL } from "./openclaw-state-schema-v11-retirement.test-support.js";
import { STATE_SCHEMA_12_TO_11_DOWNGRADE_SQL } from "./openclaw-state-schema-v12-foldin.test-support.js";
import {
  seedLegacyWideRowSubagentRun,
  STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL,
} from "./openclaw-state-schema-v13-widerow.test-support.js";
import { removePreparedWorkerOwnershipColumns } from "./openclaw-state-schema-v17.test-support.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import {
  createInitialStateSchemaShape,
  materializeV2026_7_1_2StateDatabase,
  V2026_7_1_2_STATE_FIXTURE_GZIP_SHA256,
  V2026_7_1_2_STATE_FIXTURE_RAW_SHA256,
} from "./openclaw-state-schema.test-support.js";
import { createUnsafeIndexDrift } from "./sqlite-index-drift.test-support.js";
import {
  collectSqliteSchemaShape,
  hashSqliteSchema,
  normalizeSqliteSchemaShapeSql,
} from "./sqlite-schema-shape.test-support.js";

const stateDbLogInfo = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "state/db" ? { ...logger, info: stateDbLogInfo } : logger;
    },
  };
});

type StateDbTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "diagnostic_events" | "schema_meta" | "skill_usage"
>;

const stateDbTempDirs: string[] = [];
// Vitest can enter teardown while a timed-out body is still closing its native owners.
const fixtureLifetime = createFixtureLifetime();
const processTempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await fixtureLifetime.cleanup();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    stateDbLogInfo.mockClear();
    vi.restoreAllMocks();
    cleanup();
  }),
);
let canonicalStateDatabaseTemplatePath: string | undefined;
const materializeCorruptionRefusalStateDatabase = createCorruptionRefusalStateDatabaseFixture(() =>
  materializeCurrentStateDatabase(createTempStateDir()),
);

function createTempStateDir(): string {
  return makeTempDir(stateDbTempDirs, "openclaw-state-db-");
}

function expectStateSchemaMigrationRequired(
  run: () => unknown,
  expected: {
    kind: OpenClawStateDatabaseSchemaMigrationRequiredError["kind"];
    pathname: string;
  },
): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OpenClawStateDatabaseSchemaMigrationRequiredError);
  expect(caught).toMatchObject(expected);
}

const LEGACY_SESSION_WATCH_SCHEMA_VERSION = 3;
const LEGACY_AMBIENT_WATCH_PREFIX = "ambient-group-watch:";
// Synthetic pre-v8 databases must not retain the current placement-only index.
function markStateDatabaseVersion(database: DatabaseSync, version: number): void {
  database.exec(`
    ${version < 8 ? "DROP INDEX IF EXISTS idx_worker_session_placements_environment;" : ""} PRAGMA user_version = ${version};
    UPDATE schema_meta SET schema_version = ${version} WHERE meta_key = 'primary';
  `);
}

const RETIRED_COMMITMENT_SCHEMA_OBJECTS = [
  "commitments",
  "idx_commitments_scope_due",
  "idx_commitments_status_due",
  "idx_commitments_scope_dedupe",
  "idx_commitments_agent_due",
  "idx_commitments_agent_sent",
] as const;

const RETIRED_STATE_TABLES_V10 = [
  "agent_model_catalogs",
  "android_notification_recent_packages",
  "command_log_entries",
  "diagnostic_stability_bundles",
  "media_blobs",
  "model_capability_cache",
] as const;

const FOLDED_STATE_TABLES_V12 = [
  "skill_curator_state",
  "update_check_state",
  "clawhub_promotions_feed_state",
  "model_catalog_remote",
  "voicewake_triggers",
  "voicewake_routing_config",
  "voicewake_routing_routes",
  "onboarding_recommendations",
  "cron_store_epochs",
  "tui_last_sessions",
  "sidebar_sections",
  "node_host_config",
  "web_push_vapid_keys",
] as const;

function seedV6CommitmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_id TEXT,
      recipient_id TEXT,
      thread_id TEXT,
      sender_id TEXT,
      kind TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      suggested_text TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      confidence REAL NOT NULL,
      due_earliest_ms INTEGER NOT NULL,
      due_latest_ms INTEGER NOT NULL,
      due_timezone TEXT NOT NULL,
      source_message_id TEXT,
      source_run_id TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      last_attempt_at_ms INTEGER,
      sent_at_ms INTEGER,
      dismissed_at_ms INTEGER,
      snoozed_until_ms INTEGER,
      expired_at_ms INTEGER,
      record_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_commitments_scope_due
      ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
    CREATE INDEX IF NOT EXISTS idx_commitments_status_due
      ON commitments(status, due_earliest_ms, due_latest_ms);
    CREATE INDEX IF NOT EXISTS idx_commitments_scope_dedupe
      ON commitments(agent_id, session_key, channel, dedupe_key, status);
    CREATE INDEX IF NOT EXISTS idx_commitments_agent_due
      ON commitments(agent_id, status, due_earliest_ms, due_latest_ms, session_key);
    CREATE INDEX IF NOT EXISTS idx_commitments_agent_sent
      ON commitments(agent_id, status, sent_at_ms, session_key);
    INSERT INTO commitments (
      id, agent_id, session_key, channel, kind, sensitivity, source, status,
      reason, suggested_text, dedupe_key, confidence, due_earliest_ms,
      due_latest_ms, due_timezone, created_at_ms, updated_at_ms, attempts, record_json
    ) VALUES (
      'retired-commitment', 'main', 'agent:main:main', 'telegram', 'followup',
      'normal', 'message', 'pending', 'inert', 'follow up', 'retired-dedupe',
      1.0, 10, 20, 'UTC', 1, 1, 0, '{}'
    );
    INSERT INTO state_leases (
      scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at
    ) VALUES ('test', 'preserved-lease', 'migration-test', 100, 50, '{}', 1, 2);
  `);
  markStateDatabaseVersion(database, 6);
}

function seedEarlyCommitmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE commitments (
      id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      due_earliest_ms INTEGER NOT NULL,
      due_latest_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX idx_commitments_scope_due
      ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
    CREATE INDEX idx_commitments_status_due
      ON commitments(status, due_earliest_ms, due_latest_ms);
  `);
}

function seedLegacySessionWatchCursorSchema(stateDir: string): {
  ambientTarget: string;
  bomTarget: string;
  bomWatcherSessionKey: string;
  corruptTarget: string;
  databasePath: string;
  explicitTarget: string;
  replacementWatcherSessionKey: string;
  watcherSessionKey: string;
} {
  const databasePath = materializeCurrentStateDatabase(stateDir);

  const watcherSessionKey = "agent:main:main";
  const ambientTarget = "agent:main:telegram:group:ambient";
  const bomTarget = "agent:main:telegram:group:bom";
  const bomWatcherSessionKey = "﻿agent:main:bom-watcher";
  const corruptTarget = "agent:main:telegram:group:corrupt";
  const explicitTarget = "agent:main:subagent:explicit";
  const replacementWatcherSessionKey = "�";
  const markerKey = `${LEGACY_AMBIENT_WATCH_PREFIX}${Buffer.from(watcherSessionKey, "utf8").toString("hex")}`;
  const bomMarkerKey = `${LEGACY_AMBIENT_WATCH_PREFIX}${Buffer.from(bomWatcherSessionKey, "utf8").toString("hex")}`;
  const orphanMarkerKey = `${LEGACY_AMBIENT_WATCH_PREFIX}${Buffer.from("agent:main:orphan", "utf8").toString("hex")}`;
  const { DatabaseSync } = requireNodeSqlite();
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      DROP INDEX idx_session_watch_cursors_target;
      ALTER TABLE session_watch_cursors RENAME TO session_watch_cursors_v4;
      CREATE TABLE session_watch_cursors (
        watcher_session_key TEXT NOT NULL,
        target_session_key TEXT NOT NULL,
        last_seen_sequence INTEGER NOT NULL DEFAULT 0,
        notified_sequence INTEGER NOT NULL DEFAULT 0,
        material_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (watcher_session_key, target_session_key)
      ) STRICT;
      DROP TABLE session_watch_cursors_v4;
      CREATE INDEX idx_session_watch_cursors_target
        ON session_watch_cursors(target_session_key);
      DROP INDEX idx_worker_session_placements_environment; PRAGMA user_version = ${LEGACY_SESSION_WATCH_SCHEMA_VERSION};
      UPDATE schema_meta
      SET schema_version = ${LEGACY_SESSION_WATCH_SCHEMA_VERSION}
      WHERE meta_key = 'primary';
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    const insert = legacy.prepare(`
      INSERT INTO session_watch_cursors (
        watcher_session_key, target_session_key, last_seen_sequence,
        notified_sequence, material_sequence, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(watcherSessionKey, ambientTarget, 7, 8, 9, 200);
    insert.run(watcherSessionKey, explicitTarget, 3, 4, 5, 300);
    insert.run(bomWatcherSessionKey, bomTarget, 10, 11, 12, 500);
    insert.run(replacementWatcherSessionKey, corruptTarget, 13, 14, 15, 600);
    insert.run(markerKey, ambientTarget, 7, 7, 7, 400);
    insert.run(bomMarkerKey, bomTarget, 10, 10, 10, 800);
    insert.run(`${LEGACY_AMBIENT_WATCH_PREFIX}ff`, corruptTarget, 13, 13, 13, 900);
    insert.run(orphanMarkerKey, "agent:main:telegram:group:orphan", 1, 1, 1, 100);
    insert.run(`${LEGACY_AMBIENT_WATCH_PREFIX}not-hex`, ambientTarget, 1, 1, 1, 100);
  } finally {
    legacy.close();
  }
  return {
    ambientTarget,
    bomTarget,
    bomWatcherSessionKey,
    corruptTarget,
    databasePath,
    explicitTarget,
    replacementWatcherSessionKey,
    watcherSessionKey,
  };
}

function createLegacyAuditStateDatabase(stateDir: string): string {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_meta (
        meta_key,
        role,
        schema_version,
        created_at,
        updated_at
      ) VALUES ('primary', 'global', 1, 10, 10);
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL UNIQUE,
        source_sequence INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        session_id TEXT,
        run_id TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT
      );
      CREATE INDEX idx_audit_events_time
        ON audit_events(occurred_at DESC, sequence DESC);
      CREATE INDEX idx_audit_events_agent_sequence
        ON audit_events(agent_id, sequence DESC);
      CREATE INDEX idx_audit_events_session_sequence
        ON audit_events(session_key, sequence DESC);
      CREATE INDEX idx_audit_events_run_sequence
        ON audit_events(run_id, sequence DESC);
      CREATE INDEX idx_audit_events_kind_sequence
        ON audit_events(kind, sequence DESC);
      CREATE INDEX idx_audit_events_status_sequence
        ON audit_events(status, sequence DESC);
      INSERT INTO audit_events (
        sequence,
        event_id,
        source_id,
        source_sequence,
        occurred_at,
        kind,
        action,
        status,
        actor_type,
        actor_id,
        agent_id,
        run_id
      ) VALUES (
        7,
        'event-legacy',
        'run-legacy:1:100:agent.run.started',
        1,
        100,
        'agent_run',
        'agent.run.started',
        'started',
        'agent',
        'main',
        'main',
        'run-legacy'
      );
      UPDATE sqlite_sequence SET seq = 40 WHERE name = 'audit_events';
    `);
  } finally {
    db.close();
  }
  return databasePath;
}

function materializeCurrentStateDatabase(stateDir: string): string {
  if (!canonicalStateDatabaseTemplatePath) {
    throw new Error("canonical state database template was not initialized");
  }
  // These cases own post-initialization schema or row behavior. Fresh creation stays real below.
  const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.copyFileSync(canonicalStateDatabaseTemplatePath, databasePath);
  return databasePath;
}

function downgradeWorkerPlacementsToV7(db: DatabaseSync): void {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'worker_session_placements'",
    )
    .get() as { sql?: unknown } | undefined;
  if (typeof row?.sql !== "string") {
    throw new Error("missing worker_session_placements table SQL");
  }
  const v8LocalClaim = `(turn_claim_owner IS 'local' AND (\n      state IN ('local', 'requested', 'failed')\n      OR (state IN ('active', 'draining') AND execution_mode IS 'remote-exec')\n    ))`;
  const v7Create = row.sql
    .replace("CREATE TABLE worker_session_placements", "CREATE TABLE worker_session_placements_v7")
    .replace(
      "\n  execution_mode TEXT CHECK (execution_mode IN ('worker-turn', 'remote-exec')),",
      "",
    )
    .replace(
      v8LocalClaim,
      `(turn_claim_owner IS 'local' AND state IN ('local', 'requested', 'failed'))`,
    )
    .replace("\n      AND (execution_mode IS NULL OR execution_mode IS 'worker-turn')", "");
  if (v7Create.includes("execution_mode")) {
    throw new Error("failed to derive v7 worker placement schema");
  }
  const columns = (
    db.prepare("PRAGMA table_xinfo(worker_session_placements)").all() as Array<{
      hidden: number;
      name: string;
    }>
  )
    .filter((column) => column.hidden === 0 && column.name !== "execution_mode")
    .map((column) => `"${column.name}"`)
    .join(", ");
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      ${v7Create};
      INSERT INTO worker_session_placements_v7 (${columns})
        SELECT ${columns} FROM worker_session_placements;
      DROP TABLE worker_session_placements;
      ALTER TABLE worker_session_placements_v7 RENAME TO worker_session_placements;
      CREATE INDEX idx_worker_session_placements_session_key
        ON worker_session_placements(agent_id, session_key);
      CREATE INDEX idx_worker_session_placements_reconcile
        ON worker_session_placements(updated_at_ms, session_id);
      PRAGMA user_version = 7;
      UPDATE schema_meta SET schema_version = 7 WHERE meta_key = 'primary';
      COMMIT;
    `);
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

function openMaterializedCurrentStateDatabase(stateDir = createTempStateDir()): DatabaseSync {
  const databasePath = materializeCurrentStateDatabase(stateDir);
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(databasePath);
}

function rebuildAuditEventsTable(
  db: DatabaseSync,
  transformCreateSql: (sql: string) => string,
): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
    .get() as { sql?: unknown } | undefined;
  if (typeof table?.sql !== "string") {
    throw new Error("missing audit_events table SQL");
  }
  const indexes = db
    .prepare(
      `SELECT sql
         FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'audit_events'
          AND sql IS NOT NULL
        ORDER BY name`,
    )
    .all() as Array<{ sql?: unknown }>;
  const transformedCreateSql = transformCreateSql(table.sql);
  if (transformedCreateSql === table.sql) {
    throw new Error("audit_events test schema transform did not change the table");
  }
  db.exec("DROP TABLE audit_events");
  db.exec(transformedCreateSql);
  for (const index of indexes) {
    if (typeof index.sql !== "string") {
      throw new Error("missing audit_events index SQL");
    }
    db.exec(index.sql);
  }
}

function insertAuditMarker(
  db: DatabaseSync,
  eventId: string,
  sourceId: string,
  sequence = 7,
): void {
  db.prepare(
    `INSERT INTO audit_events (
       sequence, event_id, source_id, source_sequence, occurred_at, kind, action, status,
       actor_type, actor_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sequence,
    eventId,
    sourceId,
    sequence,
    100,
    "message",
    "message.inbound.processed",
    "succeeded",
    "system",
    "gateway",
  );
}

function insertTaskRunProbe(database: DatabaseSync, taskId: string): void {
  database
    .prepare(
      `INSERT INTO task_runs (
         task_id, runtime, owner_key, scope_kind, task, status,
         delivery_status, notify_policy, created_at
       ) VALUES (?, 'subagent', 'owner', 'session', 'sqlite read probe',
                 'running', 'pending', 'summary', 1)`,
    )
    .run(taskId);
}

function expectNoncanonicalAuditSchemaRejected(
  stateDir: string,
  databasePath: string,
  doctorWarning = "cannot be repaired automatically",
): void {
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
    { kind: "audit-events-v2", path: databasePath },
  ]);
  expect(() => openOpenClawStateDatabase(options)).toThrow(/noncanonical audit event schema/);
  expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
    changes: [],
    warnings: [expect.stringContaining(doctorWarning)],
  });
}

beforeAll(() => {
  const stateDir = createTempStateDir();
  canonicalStateDatabaseTemplatePath = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: stateDir },
  }).path;
  closeOpenClawStateDatabaseForTest();
});

afterAll(async () => {
  await fixtureLifetime.cleanup();
  await closeOpenClawStateDatabaseAsync();
  cleanupTempDirs(stateDbTempDirs);
});

describe("openclaw state database", () => {
  it("migrates v15 Skill Workshop ownership and prepared workers without losing rows", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const legacy = openMaterializedCurrentStateDatabase(stateDir);
    removePreparedWorkerOwnershipColumns(legacy);
    const record = {
      schema: "openclaw.skill-workshop.proposal.v1",
      id: "workshop-v16-migration",
      kind: "create",
      status: "applied",
      title: "Create migration fixture",
      description: "Keep this row",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      createdBy: "skill-workshop",
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: "a".repeat(64),
      target: {
        skillName: "migration-fixture",
        skillKey: "migration-fixture",
        skillDir: "/tmp/workspace/skills/migration-fixture",
        skillFile: "/tmp/workspace/skills/migration-fixture/SKILL.md",
      },
      scan: {
        state: "clean",
        scannedAt: "2026-08-01T00:00:00.000Z",
        critical: 0,
        warn: 0,
        info: 0,
        findings: [],
      },
    };
    legacy.exec(`
      DROP TABLE skill_workshop_collection_reviews;
      CREATE TABLE IF NOT EXISTS skill_workshop_proposals (
        proposal_id TEXT NOT NULL PRIMARY KEY,
        record_json TEXT NOT NULL,
        owner_agent_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        draft_hash TEXT NOT NULL,
        origin_agent_id TEXT,
        origin_session_key TEXT,
        origin_run_id TEXT,
        origin_message_id TEXT,
        applied_at TEXT,
        rejected_at TEXT,
        quarantined_at TEXT,
        stale_at TEXT,
        status_reason TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS skill_workshop_collection_reviews (
        review_id TEXT NOT NULL PRIMARY KEY,
        backup_id TEXT NOT NULL,
        create_time INTEGER NOT NULL,
        kept_names_json TEXT NOT NULL,
        written_names_json TEXT NOT NULL,
        dropped_json TEXT NOT NULL
      ) STRICT;
      ALTER TABLE skill_workshop_proposals ADD COLUMN workspace_dir TEXT NOT NULL DEFAULT '';
      ALTER TABLE skill_workshop_proposals ADD COLUMN claim_released_time INTEGER;
      ALTER TABLE skill_workshop_collection_reviews ADD COLUMN workspace_dir TEXT NOT NULL DEFAULT '';
      CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
        ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC);
    `);
    const releasedRecord = {
      ...record,
      id: "workshop-v16-released",
      target: {
        skillName: "released-fixture",
        skillKey: "released-fixture",
        skillDir: "/tmp/workspace/skills/released-fixture",
        skillFile: "/tmp/workspace/skills/released-fixture/SKILL.md",
      },
    };
    const insertProposal = legacy.prepare(
      `INSERT INTO skill_workshop_proposals (
        proposal_id, record_json, owner_agent_id, workspace_dir, kind, status,
        created_at, updated_at, draft_hash, applied_at, claim_released_time
      ) VALUES (?, ?, 'main', '/tmp/workspace', 'create', 'applied', ?, ?, ?, ?, ?)`,
    );
    for (const [row, claimReleasedTime] of [
      [record, null],
      [releasedRecord, 1_756_684_800_000],
    ] as const) {
      insertProposal.run(
        row.id,
        JSON.stringify(row),
        row.createdAt,
        row.updatedAt,
        row.draftHash,
        row.updatedAt,
        claimReleasedTime,
      );
    }
    legacy
      .prepare(
        `INSERT INTO skill_workshop_collection_reviews (
          review_id, workspace_dir, backup_id, create_time,
          kept_names_json, written_names_json, dropped_json
        ) VALUES ('review-v15', '/tmp/workspace', 'backup-v15', 1, '[]', '[]', '[]')`,
      )
      .run();
    legacy.exec(`
      PRAGMA user_version = 15;
      UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';
    `);
    legacy.close();

    const migrated = openOpenClawStateDatabase(options);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(migrated.db.prepare("PRAGMA table_info(skill_workshop_proposals)").all()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "workspace_dir" }),
        expect.objectContaining({ name: "claim_released_time" }),
      ]),
    );
    expect(
      migrated.db.prepare("PRAGMA table_info(skill_workshop_collection_reviews)").all(),
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "workspace_dir" })]));
    expect(
      migrated.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_skill_workshop_collection_reviews_workspace_time'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      migrated.db
        .prepare(
          "SELECT owner_agent_id FROM skill_workshop_collection_reviews WHERE review_id = 'review-v15'",
        )
        .get(),
    ).toEqual({ owner_agent_id: "main" });
    const proposals = migrated.db
      .prepare(
        "SELECT proposal_id, status, status_reason, record_json FROM skill_workshop_proposals ORDER BY proposal_id",
      )
      .all() as Array<{
      proposal_id: string;
      status: string;
      status_reason: string | null;
      record_json: string;
    }>;
    expect(proposals[0]).toEqual({
      proposal_id: record.id,
      status: "applied",
      status_reason: null,
      record_json: JSON.stringify(record),
    });
    // A released claim loses its column, so the row becomes stale instead of an
    // applied create that Doctor would relocate out of the user's directory.
    expect(proposals[1]).toMatchObject({
      proposal_id: releasedRecord.id,
      status: "stale",
      status_reason: expect.stringContaining("stays user-owned"),
    });
    expect(JSON.parse(proposals[1]?.record_json ?? "{}")).toMatchObject({
      status: "stale",
      staleAt: expect.any(String),
      statusReason: proposals[1]?.status_reason,
      target: releasedRecord.target,
    });
    expect(
      migrated.db
        .prepare("SELECT review_id, backup_id FROM skill_workshop_collection_reviews")
        .get(),
    ).toEqual({ review_id: "review-v15", backup_id: "backup-v15" });
  });

  it("requires Doctor to repair the dangling Workshop review index in schema v16", async () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database
      .prepare(
        `INSERT INTO skill_workshop_collection_reviews (
           review_id, owner_agent_id, backup_id, create_time,
           kept_names_json, written_names_json, dropped_json
         ) VALUES ('review-preserved', 'main', 'backup-preserved', 1, '[]', '[]', '[]')`,
      )
      .run();

    removePreparedWorkerOwnershipColumns(database);
    database.exec(`
        PRAGMA user_version = 16;
        UPDATE schema_meta SET schema_version = 16 WHERE meta_key = 'primary';
      `);

    database.close();
    const rootpage = createDanglingSkillWorkshopReviewIndex(databasePath);

    const defensiveProbe = new DatabaseSync(databasePath);
    expect(hasDanglingSkillWorkshopCollectionReviewIndex(defensiveProbe)).toBe(true);
    const schemaVersion = readSqliteNumberPragma(defensiveProbe, "schema_version");
    defensiveProbe.exec(`PRAGMA schema_version = ${schemaVersion + 1};`);
    expect(readSqliteNumberPragma(defensiveProbe, "schema_version")).toBe(schemaVersion);
    defensiveProbe.close();

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /legacy-workshop-review-index.*openclaw doctor --fix/u,
    );
    await expect(prepareOpenClawStateDatabaseSchema(options)).rejects.toThrow(
      /legacy-workshop-review-index.*openclaw doctor --fix/u,
    );
    expect(readDanglingSkillWorkshopReviewIndex(databasePath)).toMatchObject({ rootpage });

    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: expect.arrayContaining([
        "Removed dangling legacy Skill Workshop review index",
        "Recorded prepared worker ownership and one-use lifecycle (v17)",
      ]),
      warnings: [],
    });

    const repaired = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        repaired
          .prepare(
            "SELECT review_id, backup_id FROM skill_workshop_collection_reviews WHERE review_id = 'review-preserved'",
          )
          .get(),
      ).toEqual({ review_id: "review-preserved", backup_id: "backup-preserved" });
      expect(repaired.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(readSqliteNumberPragma(repaired, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      expect(readDanglingSkillWorkshopReviewIndex(databasePath)).toBeUndefined();
    } finally {
      repaired.close();
    }
    expect(() => openOpenClawStateDatabase(options)).not.toThrow();
  });

  it.each([
    { refusal: "persisted", generationBound: false },
    { refusal: "persisted", generationBound: true },
    { refusal: "process", generationBound: true },
  ] as const)(
    "preserves $refusal corruption refusal during Doctor readability repair (generation-bound: $generationBound)",
    ({ refusal, generationBound }) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const sourcePath = materializeCorruptionRefusalStateDatabase(
        generationBound ? createTempStateDir() : stateDir,
      );
      const databasePath = resolveOpenClawStateSqlitePath(options.env);
      if (generationBound) {
        const { DatabaseSync } = requireNodeSqlite();
        const writer = new DatabaseSync(sourcePath);
        try {
          writer.enableDefensive?.(false);
          writer.exec(`
            PRAGMA writable_schema = ON;
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
              VALUES ('catalog-quarantine-probe', '{}', 1);
          `);
          fs.mkdirSync(path.dirname(databasePath), { recursive: true });
          fs.copyFileSync(sourcePath, databasePath);
          fs.copyFileSync(`${sourcePath}-wal`, `${databasePath}-wal`);
        } finally {
          writer.close();
        }
      }
      const before = readStableSqliteFileGeneration(databasePath);
      const beforeDatabase = fs.readFileSync(databasePath);
      const beforeWal = generationBound ? fs.readFileSync(`${databasePath}-wal`) : undefined;
      if (beforeWal) {
        expect(beforeWal.length).toBeGreaterThan(32);
      }
      expect(fs.existsSync(`${databasePath}-shm`)).toBe(false);
      const generation = generationBound ? before : undefined;
      const reason = "previously verified damage outside Workshop";
      if (refusal === "persisted") {
        expect(
          recordOpenClawDatabaseQuarantine({
            env: options.env,
            kind: "state",
            path: databasePath,
            reason,
            generation,
          }),
        ).toBe(true);
      } else {
        const error = new Error(reason);
        error.name = "SqliteIntegrityError";
        expect(recordOpenClawStateDatabaseOpenFailure(databasePath, error, generation)).toBe(true);
      }

      expect(() => repairOpenClawStateDatabaseReadabilityForDoctor(options)).toThrow(reason);
      expect(readStableSqliteFileGeneration(databasePath)).toEqual(before);
      deepStrictEqual(fs.readFileSync(databasePath), beforeDatabase);
      if (beforeWal) {
        deepStrictEqual(fs.readFileSync(`${databasePath}-wal`), beforeWal);
      }
      expect(fs.existsSync(`${databasePath}-shm`)).toBe(false);
      expect(() => openOpenClawStateDatabase(options)).toThrow(reason);
    },
  );

  it("rolls back Doctor readability repair for a foreign role", () => {
    const options = { env: { OPENCLAW_STATE_DIR: createTempStateDir() } };
    const databasePath = materializeCurrentStateDatabase(options.env.OPENCLAW_STATE_DIR);
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("UPDATE schema_meta SET role = 'agent' WHERE meta_key = 'primary';");
    } finally {
      database.close();
    }
    const rootpage = createDanglingSkillWorkshopReviewIndex(databasePath);
    const before = fs.readFileSync(databasePath);

    expect(repairOpenClawStateDatabaseReadabilityForDoctor(options)).toEqual({
      changes: [],
      warnings: [expect.stringMatching(/schema role agent; expected global/)],
    });
    deepStrictEqual(fs.readFileSync(databasePath), before);
    expect(readDanglingSkillWorkshopReviewIndex(databasePath)).toMatchObject({ rootpage });
  });

  it("rolls back dangling Workshop index reclamation and converges on retry", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const rootpage = createDanglingSkillWorkshopReviewIndex(databasePath);
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    const repairAdmittedSchema = prepareStateDatabaseSchemaRepair(
      database,
      databasePath,
      options.env,
    );
    expect(() =>
      runSqliteImmediateTransactionSync(database, () => {
        expect(repairAdmittedSchema()).toEqual([
          "Removed dangling legacy Skill Workshop review index",
        ]);
        throw new Error("injected post-reclamation failure");
      }),
    ).toThrow("injected post-reclamation failure");
    database.close();

    expect(readDanglingSkillWorkshopReviewIndex(databasePath)).toMatchObject({ rootpage });
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: ["Removed dangling legacy Skill Workshop review index"],
      warnings: [],
    });
    expect(readDanglingSkillWorkshopReviewIndex(databasePath)).toBeUndefined();
  });

  it("migrates v7 worker placement claims and missing terminal columns without losing rows", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy
      .prepare(
        `INSERT INTO worker_session_placements (
             session_id, agent_id, session_key, state, transition_generation,
             created_at_ms, updated_at_ms, state_changed_at_ms
           ) VALUES (?, ?, ?, 'local', 3, 1, 2, 2)`,
      )
      .run("legacy-session", "main", "agent:main:legacy");
    downgradeWorkerPlacementsToV7(legacy);
    legacy.exec(`
      ALTER TABLE worker_session_placements DROP COLUMN terminal_at_ms;
      ALTER TABLE worker_session_placements DROP COLUMN terminal_reason;
    `);
    legacy.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
      kind: "worker-placement-execution-mode-v8",
      path: databasePath,
    });

    const migrated = openOpenClawStateDatabase(options);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare(
          "SELECT session_id, transition_generation, execution_mode FROM worker_session_placements",
        )
        .get(),
    ).toEqual({ session_id: "legacy-session", transition_generation: 3, execution_mode: null });
    const columns = migrated.db.prepare("PRAGMA table_info(worker_session_placements)").all();
    expect(columns.map((column) => column.name).slice(-2)).toEqual([
      "terminal_reason",
      "terminal_at_ms",
    ]);
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).not.toContainEqual({
      kind: "worker-placement-execution-mode-v8",
      path: databasePath,
    });
  });

  it.each([OPENCLAW_AGENT_SCHEMA_VERSION])(
    "migrates v8 agent database registrations to state-relative paths (agent schema %s)",
    (agentSchemaVersion) => {
      const stateDir = createTempStateDir();
      const foreignStateDir = createTempStateDir();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const inRootPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      const dualInRootPath = path.join(
        stateDir,
        "agents",
        "dual",
        "agent",
        "openclaw-agent.sqlite",
      );
      const dualForeignPath = path.join(
        foreignStateDir,
        "agents",
        "dual",
        "agent",
        "openclaw-agent.sqlite",
      );
      const copiedForeignPath = path.join(
        foreignStateDir,
        "agents",
        "copied",
        "agent",
        "openclaw-agent.sqlite",
      );
      const copiedInRootPath = path.join(
        stateDir,
        "agents",
        "copied",
        "agent",
        "openclaw-agent.sqlite",
      );
      const preservedDefaultPath = path.join(
        foreignStateDir,
        "agents",
        "preserved",
        "agent",
        "openclaw-agent.sqlite",
      );
      const externalPath = path.join(foreignStateDir, "explicit", "external.sqlite");
      fs.mkdirSync(path.dirname(dualInRootPath), { recursive: true });
      fs.writeFileSync(dualInRootPath, "");
      fs.mkdirSync(path.dirname(copiedInRootPath), { recursive: true });
      fs.writeFileSync(copiedInRootPath, "");
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      const insert = legacy.prepare(
        `INSERT INTO agent_databases (
         agent_id, path, schema_version, last_seen_at, size_bytes
       ) VALUES (?, ?, ?, 1, NULL)`,
      );
      insert.run("main", inRootPath, agentSchemaVersion);
      insert.run("dual", dualInRootPath, agentSchemaVersion);
      insert.run("dual", dualForeignPath, agentSchemaVersion);
      insert.run("copied", copiedForeignPath, agentSchemaVersion);
      insert.run("preserved", preservedDefaultPath, agentSchemaVersion);
      insert.run("external", externalPath, agentSchemaVersion);
      legacy.exec(`
      PRAGMA user_version = 8;
      UPDATE schema_meta SET schema_version = 8 WHERE meta_key = 'primary';
    `);
      legacy.close();

      expect(detectOpenClawStateDatabaseSchemaMigrations({ env })).toContainEqual({
        kind: "agent-databases-relative-paths-v9",
        path: databasePath,
      });
      expect(repairOpenClawStateDatabaseSchema({ env })).toEqual({
        changes: [
          "Migrated agent database registry paths to state-relative storage (2 relativized, 1 re-anchored, 1 removed)",
          `Re-anchored agent database registry path ${copiedForeignPath} to the current state directory`,
          `Removed duplicate agent database registry path ${dualForeignPath}`,
          "Qualified historical cron creator attribution as unknown (v14)",
        ],
        warnings: [],
      });
      const migrated = openOpenClawStateDatabase({ env });
      expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(
        migrated.db.prepare("SELECT agent_id, path FROM agent_databases ORDER BY agent_id").all(),
      ).toEqual([
        {
          agent_id: "copied",
          path: path.join("agents", "copied", "agent", "openclaw-agent.sqlite"),
        },
        {
          agent_id: "dual",
          path: path.join("agents", "dual", "agent", "openclaw-agent.sqlite"),
        },
        { agent_id: "external", path: externalPath },
        {
          agent_id: "main",
          path: path.join("agents", "main", "agent", "openclaw-agent.sqlite"),
        },
        { agent_id: "preserved", path: preservedDefaultPath },
      ]);
      const expected = [
        expect.objectContaining({ agentId: "copied", path: copiedInRootPath }),
        expect.objectContaining({ agentId: "dual", path: dualInRootPath }),
        expect.objectContaining({ agentId: "external", path: externalPath }),
        expect.objectContaining({ agentId: "main", path: inRootPath }),
        expect.objectContaining({ agentId: "preserved", path: preservedDefaultPath }),
      ];
      expect(
        migrated.db.prepare("SELECT DISTINCT schema_version FROM agent_databases").all(),
      ).toEqual([{ schema_version: agentSchemaVersion }]);
      expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual(
        agentSchemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION ? expected : [],
      );
      expect(
        listOpenClawRegisteredAgentDatabases({ env, includeIncompatibleSchemaVersions: true }),
      ).toEqual(expected);
    },
  );

  it("retires v10 skill curator projections through runtime open while preserving live skill usage and proposal provenance", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(STATE_SCHEMA_12_TO_11_DOWNGRADE_SQL);
    legacy.exec(STATE_SCHEMA_11_TO_10_TABLES_SQL);
    legacy.exec(`
        ALTER TABLE skill_workshop_proposals
          ADD COLUMN workspace_dir TEXT NOT NULL DEFAULT '';
        ALTER TABLE skill_workshop_proposals
          ADD COLUMN claim_released_time INTEGER;
        INSERT INTO skill_workshop_proposals (
          proposal_id, record_json, workspace_dir, kind, status, created_at, updated_at, draft_hash
        ) VALUES (
          'proposal-retired', '{"originRunIds":["run-retired"]}', '/workspace',
          'create', 'applied', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'hash'
        );
        INSERT INTO skill_workshop_proposal_origin_runs (
          proposal_id, run_id, position, mutation_count
        ) VALUES ('proposal-retired', 'run-retired', 0, 1);
        INSERT INTO skill_lifecycle (
          skill_file, skill_key, skill_name, state, state_changed_at_ms, created_at_ms,
          archived_reason
        ) VALUES (
          '/skills/archived/SKILL.md', 'archived', 'Archived', 'archived', 20, 10, 'unused'
        );
        INSERT INTO skill_usage (
          skill_file, skill_key, skill_name, skill_source, first_used_at_ms,
          last_used_at_ms, use_count, last_agent_id
        ) VALUES (
          '/skills/archived/SKILL.md', 'archived', 'Archived', 'workspace', 10, 30, 4, 'main'
        );
        INSERT INTO skill_curator_state (
          id, last_attempt_at_ms, last_success_at_ms, last_error, last_result_json
        ) VALUES (1, 40, 40, NULL, '{}');
        PRAGMA user_version = 10;
        UPDATE schema_meta SET schema_version = 10 WHERE meta_key = 'primary';
      `);
    legacy.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
      kind: "state-table-retirement-v11",
      path: databasePath,
    });
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
      kind: "singleton-state-foldin-v12",
      path: databasePath,
    });

    const migrated = openOpenClawStateDatabase(options);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
    for (const name of [
      "skill_lifecycle",
      "idx_skill_lifecycle_key",
      "idx_skill_lifecycle_state",
      "skill_workshop_proposal_origin_runs",
      "skill_curator_state",
    ]) {
      expect(migrated.db.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(name)).toBe(
        undefined,
      );
    }
    expect(migrated.db.prepare("SELECT skill_file, use_count FROM skill_usage").get()).toEqual({
      skill_file: "/skills/archived/SKILL.md",
      use_count: 4,
    });
    expect(readConfigMachineState("skills.curatorState", options)).toBeUndefined();
    expect(
      migrated.db
        .prepare("SELECT record_json FROM skill_workshop_proposals WHERE proposal_id = ?")
        .get("proposal-retired"),
    ).toEqual({ record_json: '{"originRunIds":["run-retired"]}' });
  });

  it("folds v11 singleton state into machine-state keys through doctor repair", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(STATE_SCHEMA_12_TO_11_DOWNGRADE_SQL);
    legacy.exec(`
        INSERT INTO update_check_state (
          state_key, last_checked_at, last_notified_version, last_notified_tag,
          last_available_version, last_available_tag, auto_install_id,
          auto_first_seen_version, auto_first_seen_tag, auto_first_seen_at,
          auto_last_attempt_version, auto_last_attempt_at, auto_last_success_version,
          auto_last_success_at, updated_at_ms
        ) VALUES (
          'default', '2026-08-20T00:00:00.000Z', '2026.8.19', 'stable',
          '2026.8.20', 'beta', 'installation-42',
          '2026.8.18', 'stable', '2026-08-18T00:00:00.000Z',
          '2026.8.19', '2026-08-19T00:00:00.000Z', '2026.8.17',
          '2026-08-17T00:00:00.000Z', 200
        );
        INSERT INTO voicewake_triggers (config_key, position, trigger, updated_at_ms) VALUES
          ('default', 1, 'second wake word', 101),
          ('default', 0, 'first wake word', 100);
        INSERT INTO voicewake_routing_config (
          config_key, version, default_target_mode, default_target_agent_id,
          default_target_session_key, updated_at_ms
        ) VALUES ('default', 1, 'agent', 'assistant', NULL, 300);
        INSERT INTO voicewake_routing_routes (
          config_key, position, trigger, target_mode, target_agent_id,
          target_session_key, updated_at_ms
        ) VALUES ('default', 0, 'route wake word', 'session', NULL, 'agent:main:voice', 300);
        INSERT INTO onboarding_recommendations (
          config_key, inventory_hash, matches_json, offered_at_ms, accepted_at_ms, updated_at_ms
        ) VALUES
          ('workspace-a', 'inventory-a', '[{"candidateId":"first"}]', 400, 401, 402),
          ('workspace-b', 'inventory-b', '[{"candidateId":"second"}]', 500, NULL, 501),
          ('workspace-existing', 'old-inventory', '[]', 600, NULL, 601);
        INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
          VALUES ('onboarding.recommendations.workspace-existing', '{"newer":true}', 999);
        INSERT INTO skill_curator_state (
          id, last_attempt_at_ms, last_success_at_ms, last_error, last_result_json
        ) VALUES (1, 10, 20, NULL, '{"cached":true}');
        INSERT INTO clawhub_promotions_feed_state (
          state_key, payload_json, updated_at_ms
        ) VALUES ('default', '{"cached":true}', 30);
        INSERT INTO model_catalog_remote (
          id, bundle_json, generated_at, source_url, checked_at
        ) VALUES (1, '{"cached":true}', 40, 'https://example.invalid/catalog', 50);
        INSERT INTO cron_store_epochs (store_key, store_epoch) VALUES ('default', 60);
        INSERT INTO sidebar_sections (section_id, position) VALUES
          ('category:projects', 1),
          ('ungrouped', 0);
        INSERT INTO node_host_config (
          config_key, version, node_id, token, display_name, gateway_host,
          gateway_port, gateway_tls, gateway_tls_fingerprint, gateway_context_path,
          gateway_cloudflare_access_json, installed_apps_sharing, updated_at_ms
        ) VALUES (
          'current', 1, 'node-42', 'retired-token', 'Build Node', 'gateway.example',
          443, 1, 'fingerprint-42', '/openclaw-gw',
          '{"clientId":"access-id","clientSecret":"access-secret"}', 1, 700
        );
        INSERT INTO web_push_vapid_keys (
          key_id, public_key, private_key, subject, updated_at_ms
        ) VALUES ('default', 'public-vapid-key', 'private-vapid-key', 'https://openclaw.ai', 800);
        INSERT INTO tui_last_sessions (scope_key, session_key, updated_at)
          VALUES ('cached-scope', 'agent:main:cached', 900);
      `);
    legacy.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
      kind: "singleton-state-foldin-v12",
      path: databasePath,
    });

    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [
        "Folded singleton state tables into config_machine_state (v12)",
        "Qualified historical cron creator attribution as unknown (v14)",
      ],
      warnings: [],
    });

    const migrated = openOpenClawStateDatabase(options);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
    for (const tableName of FOLDED_STATE_TABLES_V12) {
      expect(
        migrated.db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(tableName),
      ).toBeUndefined();
    }
    expect(readConfigMachineState("update.checkState", options)).toEqual({
      lastCheckedAt: "2026-08-20T00:00:00.000Z",
      lastNotifiedVersion: "2026.8.19",
      lastNotifiedTag: "stable",
      lastAvailableVersion: "2026.8.20",
      lastAvailableTag: "beta",
      autoInstallId: "installation-42",
      autoFirstSeenVersion: "2026.8.18",
      autoFirstSeenTag: "stable",
      autoFirstSeenAt: "2026-08-18T00:00:00.000Z",
      autoLastAttemptVersion: "2026.8.19",
      autoLastAttemptAt: "2026-08-19T00:00:00.000Z",
      autoLastSuccessVersion: "2026.8.17",
      autoLastSuccessAt: "2026-08-17T00:00:00.000Z",
    });
    expect(readConfigMachineState("voicewake.triggers", options)).toEqual([
      "first wake word",
      "second wake word",
    ]);
    expect(readConfigMachineState("voicewake.routing", options)).toEqual({
      version: 1,
      defaultTarget: { agentId: "assistant" },
      routes: [{ trigger: "route wake word", target: { sessionKey: "agent:main:voice" } }],
      updatedAtMs: 300,
    });
    expect(readConfigMachineState("onboarding.recommendations.workspace-a", options)).toEqual({
      inventoryHash: "inventory-a",
      matches: [{ candidateId: "first" }],
      offeredAt: 400,
      acceptedAt: 401,
      updatedAt: 402,
    });
    expect(readConfigMachineState("onboarding.recommendations.workspace-b", options)).toEqual({
      inventoryHash: "inventory-b",
      matches: [{ candidateId: "second" }],
      offeredAt: 500,
      acceptedAt: null,
      updatedAt: 501,
    });
    expect(
      readConfigMachineState("onboarding.recommendations.workspace-existing", options),
    ).toEqual({ newer: true });
    expect(readConfigMachineState("sidebar.sectionOrder", options)).toEqual([
      "ungrouped",
      "category:projects",
    ]);
    expect(readConfigMachineStateWithMetadata("nodeHost.config", options)).toEqual({
      value: {
        version: 1,
        nodeId: "node-42",
        displayName: "Build Node",
        gateway: {
          host: "gateway.example",
          port: 443,
          tls: true,
          tlsFingerprint: "fingerprint-42",
          contextPath: "/openclaw-gw",
          cloudflareAccess: { clientId: "access-id", clientSecret: "access-secret" },
        },
        installedAppsSharing: true,
      },
      updatedAtMs: 700,
    });
    expect(readConfigMachineStateWithMetadata("webPush.vapidKeys", options)).toEqual({
      value: {
        publicKey: "public-vapid-key",
        privateKey: "private-vapid-key",
        subject: "https://openclaw.ai",
      },
      updatedAtMs: 800,
    });
    expect(readConfigMachineState("tui.lastSession.cached-scope", options)).toBeUndefined();
    expect(readConfigMachineState("skills.curatorState", options)).toBeUndefined();
    expect(readConfigMachineState("clawhub.promotionsFeed", options)).toBeUndefined();
    expect(readConfigMachineState("modelCatalog.remote", options)).toBeUndefined();
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).not.toContainEqual({
      kind: "singleton-state-foldin-v12",
      path: databasePath,
    });
  });

  it("migrates legacy wide rows through Doctor without path aliases while preserving store provenance and hydrated jobs", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
    legacy.exec("DROP TABLE gateway_origin_device_tokens;");

    const job = {
      id: "legacy-wide-job",
      name: "Legacy wide job",
      description: "preserved cron configuration",
      declarationKey: "legacy-declaration",
      owner: { agentId: "legacy-owner" },
      createdAtMs: 100,
      updatedAtMs: 250,
      agentId: "legacy-agent",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        failureDestination: { channel: "slack", to: null },
      },
    };
    const storeKey = path.join(stateDir, "cron", "jobs.json");
    legacy
      .prepare(
        `INSERT INTO cron_jobs (
             store_key, job_id, declaration_key, owner_agent_id, name, description,
             enabled, created_at_ms, agent_id, payload_kind, job_json, state_json,
             runtime_updated_at_ms, schedule_identity, sort_order, updated_at,
             schedule_kind, every_ms, session_target, wake_mode, payload_message,
             delivery_mode, delivery_channel, failure_delivery_mode,
             failure_delivery_channel, failure_delivery_to, failure_delivery_account_id,
             last_run_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        storeKey,
        job.id,
        "legacy-declaration",
        "legacy-owner",
        job.name,
        job.description,
        1,
        job.createdAtMs,
        job.agentId,
        job.payload.kind,
        JSON.stringify(job),
        JSON.stringify({ lastStatus: "error" }),
        job.updatedAtMs,
        "every:60000",
        4,
        job.updatedAtMs,
        job.schedule.kind,
        job.schedule.everyMs,
        job.sessionTarget,
        job.wakeMode,
        job.payload.message,
        job.delivery.mode,
        job.delivery.channel,
        "announce",
        "discord",
        "https://example.invalid/failure",
        "",
        "ok",
      );
    const authoritySchemaStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
      "CREATE TABLE IF NOT EXISTS cron_job_runtime_authorities (",
    );
    const authoritySchemaEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
      "\n) STRICT;",
      authoritySchemaStart,
    );
    legacy.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(authoritySchemaStart, authoritySchemaEnd + 10));
    legacy
      .prepare(
        `INSERT INTO cron_job_runtime_authorities (
             store_key, job_id, authority_json, authority_input_fingerprint, recovery_required
           ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(storeKey, job.id, '{"owner":"preserved"}', "preserved-fingerprint", 0);
    const runPayload = {
      runId: "legacy-run",
      childSessionKey: "agent:child:legacy",
      requesterSessionKey: "agent:main:legacy",
      task: "preserved subagent task",
    };
    const requesterStorePath = path.join(stateDir, "requester.sqlite");
    const controllerStorePath = path.join(stateDir, "controller.sqlite");
    seedLegacyWideRowSubagentRun(legacy, {
      payload: runPayload,
      requesterStorePath,
      controllerStorePath,
    });
    legacy
      .prepare(
        `INSERT INTO workspace_setup_state (
             workspace_key, workspace_path, version, bootstrap_seeded_at, setup_completed_at,
             updated_at
           ) VALUES (?, ?, 1, ?, ?, ?)`,
      )
      .run(
        "wk-setup",
        "/tmp/wk-setup",
        "2026-07-15T10:00:00.000Z",
        "2026-07-15T10:01:00.000Z",
        500,
      );
    const insertLegacyAttestation = legacy.prepare(
      "INSERT INTO workspace_attestations (workspace_key, attested_at_ms, updated_at_ms) VALUES (?, ?, ?)",
    );
    insertLegacyAttestation.run("wk-setup", 1_000, 1_100);
    insertLegacyAttestation.run("wk-alias", 2_000, 2_100);
    insertLegacyAttestation.run("wk-orphan", 3_000, 3_100);

    legacy.exec(`
          DROP TABLE workspace_path_aliases; DROP INDEX idx_worker_session_placements_environment;
          PRAGMA user_version = 1;
          UPDATE schema_meta SET schema_version = 1, app_version = '2026.6.35'
           WHERE meta_key = 'primary';
        `);

    const insertLegacyHash = legacy.prepare(
      "INSERT INTO workspace_generated_bootstrap_hashes (workspace_key, filename, sha256) VALUES (?, ?, ?)",
    );
    insertLegacyHash.run("wk-setup", "AGENTS.md", "a".repeat(64));
    insertLegacyHash.run("wk-alias", "TOOLS.md", "b".repeat(64));
    insertLegacyHash.run("wk-orphan", "USER.md", "c".repeat(64));
    const sharedStoreJson = JSON.stringify({
      version: 1,
      profiles: { "openai:default": { type: "api_key", provider: "openai", key: "sk-shared" } },
    });
    const sharedStateJson = JSON.stringify({
      version: 1,
      order: { openai: ["openai:default"] },
    });
    const insertLegacyAuthStore = legacy.prepare(
      "INSERT INTO auth_profile_stores (store_key, store_json, updated_at) VALUES (?, ?, ?)",
    );
    insertLegacyAuthStore.run("shared", sharedStoreJson, 91);
    insertLegacyAuthStore.run("stray", '{"version":1,"profiles":{}}', 93);
    legacy
      .prepare(
        "INSERT INTO auth_profile_state (store_key, state_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("shared", sharedStateJson, 92);
    legacy.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
      kind: "state-consolidation-v13",
      path: databasePath,
    });

    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [
        "Migrated cloud worker placements to execution modes",
        "Migrated shared state session watch cursors → provenance column (0 ambient, 0 sentinels removed)",
        "Consolidated shared state tables (v13)",
        "Qualified historical cron creator attribution as unknown (v14)",
      ],
      warnings: [],
    });

    const migrated = openOpenClawStateDatabase(options);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(collectSqliteSchemaShape(migrated.db).gateway_origin_device_tokens).toEqual(
      createInitialStateSchemaShape().gateway_origin_device_tokens,
    );
    const cronColumns = migrated.db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{
      name: string;
    }>;
    expect(cronColumns.map((column) => column.name)).toEqual([
      "store_key",
      "job_id",
      "declaration_key",
      "owner_agent_id",
      "name",
      "description",
      "enabled",
      "agent_id",
      ..."payload_kind job_json".split(" "),
      ...["revision", "generation", "updated_at"].map((name) => `grant_definition_${name}`),
      "state_json",
      "runtime_updated_at_ms",
      "schedule_identity",
      "sort_order",
      "updated_at",
    ]);
    expect(
      migrated.db
        .prepare(
          `SELECT name FROM sqlite_master
              WHERE type = 'index'
                AND name IN (
                  'idx_cron_jobs_store_updated',
                  'idx_cron_jobs_enabled_next_run',
                  'idx_cron_jobs_store_order'
                )
              ORDER BY name`,
        )
        .all(),
    ).toEqual([{ name: "idx_cron_jobs_store_order" }]);
    const row = migrated.db
      .prepare(
        `SELECT declaration_key, owner_agent_id, agent_id, payload_kind,
                  runtime_updated_at_ms, schedule_identity, sort_order, job_json, state_json
             FROM cron_jobs WHERE job_id = ?`,
      )
      .get(job.id) as {
      declaration_key: string;
      owner_agent_id: string;
      agent_id: string;
      payload_kind: string;
      runtime_updated_at_ms: number;
      schedule_identity: string;
      sort_order: number;
      job_json: string;
      state_json: string;
    };
    expect(row).toMatchObject({
      declaration_key: "legacy-declaration",
      owner_agent_id: "legacy-owner",
      agent_id: "legacy-agent",
      payload_kind: "agentTurn",
      runtime_updated_at_ms: 250,
      schedule_identity: "every:60000",
      sort_order: 4,
    });
    expect(JSON.parse(row.job_json).delivery.failureDestination).toEqual({
      mode: "announce",
      channel: "slack",
      to: null,
      accountId: null,
    });
    expect(JSON.parse(row.job_json).enabled).toBe(true);
    expect(JSON.parse(row.state_json)).toEqual({
      lastStatus: "error",
      lastRunStatus: "error",
    });
    expect(loadedCronStoreFromRows(loadCronRows(migrated.db, storeKey)).store.jobs).toEqual([
      {
        ...job,
        enabled: true,
        declarationKey: "legacy-declaration",
        owner: { agentId: "legacy-owner" },
        delivery: {
          ...job.delivery,
          failureDestination: {
            mode: "announce",
            channel: "slack",
            to: undefined,
            accountId: undefined,
          },
        },
        state: { lastStatus: "error", lastRunStatus: "error" },
      },
    ]);
    expect(
      migrated.db
        .prepare(
          `SELECT store_key, job_id, authority_json, authority_input_fingerprint,
                    recovery_required
               FROM cron_job_runtime_authorities WHERE job_id = ?`,
        )
        .get(job.id),
    ).toEqual({
      store_key: storeKey,
      job_id: job.id,
      authority_json: '{"owner":"preserved"}',
      authority_input_fingerprint: "preserved-fingerprint",
      recovery_required: 0,
    });
    expect(
      migrated.db.prepare("SELECT * FROM subagent_runs WHERE run_id = ?").get(runPayload.runId),
    ).toEqual({
      run_id: runPayload.runId,
      child_session_key: runPayload.childSessionKey,
      controller_session_key: "agent:controller:legacy",
      controller_store_path: controllerStorePath,
      requester_session_key: runPayload.requesterSessionKey,
      requester_store_path: requesterStorePath,
      created_at: 200,
      payload_json: JSON.stringify(runPayload),
    });
    expect(
      migrated.db
        .prepare(
          `SELECT workspace_key, workspace_path, version, bootstrap_seeded_at,
                    setup_completed_at, updated_at, attested_at_ms, attestation_updated_at_ms
               FROM workspace_setup_state ORDER BY workspace_key`,
        )
        .all(),
    ).toEqual([
      {
        workspace_key: "wk-alias",
        workspace_path: null,
        version: null,
        bootstrap_seeded_at: null,
        setup_completed_at: null,
        updated_at: null,
        attested_at_ms: 2_000,
        attestation_updated_at_ms: 2_100,
      },
      {
        workspace_key: "wk-orphan",
        workspace_path: null,
        version: null,
        bootstrap_seeded_at: null,
        setup_completed_at: null,
        updated_at: null,
        attested_at_ms: 3_000,
        attestation_updated_at_ms: 3_100,
      },
      {
        workspace_key: "wk-setup",
        workspace_path: "/tmp/wk-setup",
        version: 1,
        bootstrap_seeded_at: "2026-07-15T10:00:00.000Z",
        setup_completed_at: "2026-07-15T10:01:00.000Z",
        updated_at: 500,
        attested_at_ms: 1_000,
        attestation_updated_at_ms: 1_100,
      },
    ]);
    expect(
      migrated.db
        .prepare(
          `SELECT workspace_key, filename, sha256 FROM workspace_generated_bootstrap_hashes
              ORDER BY workspace_key`,
        )
        .all(),
    ).toEqual([
      { workspace_key: "wk-alias", filename: "TOOLS.md", sha256: "b".repeat(64) },
      { workspace_key: "wk-orphan", filename: "USER.md", sha256: "c".repeat(64) },
      { workspace_key: "wk-setup", filename: "AGENTS.md", sha256: "a".repeat(64) },
    ]);
    expect(
      migrated.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_attestations'",
        )
        .all(),
    ).toEqual([]);
    expect(
      migrated.db
        .prepare(
          `SELECT value_json, updated_at_ms FROM config_machine_state
              WHERE state_key = 'authProfiles.store'`,
        )
        .get(),
    ).toEqual({ value_json: sharedStoreJson, updated_at_ms: 91 });
    expect(
      migrated.db
        .prepare(
          `SELECT value_json, updated_at_ms FROM config_machine_state
              WHERE state_key = 'authProfiles.state'`,
        )
        .get(),
    ).toEqual({ value_json: sharedStateJson, updated_at_ms: 92 });
    expect(
      migrated.db
        .prepare(
          `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name IN ('auth_profile_stores', 'auth_profile_state')`,
        )
        .all(),
    ).toEqual([]);
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
  });

  it("preserves cron delivery when recovering v12 enabled state through runtime open", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const legacy = openMaterializedCurrentStateDatabase(stateDir);
    legacy.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
    const storeKey = path.join(stateDir, "cron", "jobs.json");
    const cases: Array<{ enabled: boolean; delivery?: { mode: "none" } }> = [
      { enabled: true },
      { enabled: false },
      { enabled: true, delivery: { mode: "none" } },
    ];
    const jobs: CronStoredJob[] = cases.map(({ enabled, delivery }, index) => ({
      id: `legacy-main-${index}`,
      name: "Legacy main job",
      enabled,
      createdAtMs: 100,
      updatedAtMs: 250,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      delivery,
      state: {},
    }));
    const insert = legacy.prepare(
      `INSERT INTO cron_jobs (
           store_key, job_id, name, enabled, created_at_ms, schedule_kind, every_ms,
           session_target, wake_mode, payload_kind, payload_message, job_json, state_json,
           sort_order, updated_at
         ) VALUES (?, ?, ?, ?, 100, 'every', 60000, 'main', 'now', 'systemEvent',
                   'tick', ?, ?, ?, 250)`,
    );
    for (const [index, job] of jobs.entries()) {
      const { enabled, state, ...legacyJob } = job;
      insert.run(
        storeKey,
        job.id,
        job.name,
        Number(enabled),
        JSON.stringify(legacyJob),
        JSON.stringify(state),
        index,
      );
    }
    legacy.close();

    const migrated = openOpenClawStateDatabase(options);
    const loaded = loadedCronStoreFromRows(loadCronRows(migrated.db, storeKey)).store.jobs;
    expect(loaded).toEqual(jobs);
    for (const job of loaded) {
      expect(resolveCronDeliveryPlan(job)).toMatchObject({ mode: "none", requested: false });
    }
  });

  it("preserves malformed cron JSON for quarantine through the v13 doctor repair", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const legacy = openMaterializedCurrentStateDatabase(stateDir);
    legacy.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
    const insert = legacy.prepare(
      `INSERT INTO cron_jobs (
           store_key, job_id, name, enabled, created_at_ms, schedule_kind, schedule_expr,
           session_target, wake_mode, payload_kind, payload_message, job_json, state_json,
           sort_order, updated_at
         ) VALUES (?, ?, ?, 1, 1, 'cron', '0 6 * * *', 'main', 'now',
                   'systemEvent', 'tick', ?, ?, ?, 1)`,
    );
    const storeKey = path.join(stateDir, "cron", "jobs.json");
    insert.run(storeKey, "malformed-job", "Malformed job", "{", "{}", 0);
    insert.run(storeKey, "malformed-state", "Malformed state", '{"id":"malformed-state"}', "[]", 1);
    legacy.close();

    expect(repairOpenClawStateDatabaseSchema(options).changes).toContain(
      "Consolidated shared state tables (v13)",
    );

    const migrated = openOpenClawStateDatabase(options);
    expect(
      migrated.db
        .prepare("SELECT job_id, job_json, state_json FROM cron_jobs ORDER BY sort_order, job_id")
        .all(),
    ).toEqual([
      { job_id: "malformed-job", job_json: "{", state_json: "{}" },
      { job_id: "malformed-state", job_json: '{"id":"malformed-state"}', state_json: "[]" },
    ]);
    expect(migrated.db.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    closeOpenClawStateDatabaseForTest();
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare("SELECT COUNT(*) AS count FROM cron_jobs")
        .get(),
    ).toEqual({ count: 2 });
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
  });

  it("logs a destructive retirement only after the schema transaction commits", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    seedV6CommitmentSchema(legacy);
    legacy.exec(`
      CREATE TRIGGER fail_schema_meta_update
      BEFORE UPDATE ON schema_meta
      BEGIN
        SELECT RAISE(ABORT, 'forced migration rollback');
      END;
    `);
    legacy.close();

    expect(() => openOpenClawStateDatabase(options)).toThrow(/forced migration rollback/);
    expect(stateDbLogInfo).not.toHaveBeenCalledWith(
      "Discarded retired shared-state commitments rows, table, and indexes",
    );
    const rolledBack = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        rolledBack.prepare("SELECT name FROM sqlite_schema WHERE name = 'commitments'").get(),
      ).toEqual({ name: "commitments" });
    } finally {
      rolledBack.close();
    }
  });

  it("retires the supported early commitments layout through doctor repair", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const early = new DatabaseSync(databasePath);
    seedEarlyCommitmentSchema(early);
    early.close();

    const result = repairOpenClawStateDatabaseSchema(options);
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Discarded retired shared-state commitments rows, table, and indexes",
    );

    const migrated = openOpenClawStateDatabase(options);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(
      migrated.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'commitments'").get(),
    ).toBeUndefined();
  });

  it("migrates the exact v2026.7.1-2 shared state database through Doctor", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const fixture = materializeV2026_7_1_2StateDatabase(stateDir);
    expect(fixture.compressedSha256).toBe(V2026_7_1_2_STATE_FIXTURE_GZIP_SHA256);
    expect(fixture.rawSha256).toBe(V2026_7_1_2_STATE_FIXTURE_RAW_SHA256);

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "commitments-retirement-v7", path: fixture.databasePath },
      { kind: "state-table-retirement-v10", path: fixture.databasePath },
      { kind: "state-table-retirement-v11", path: fixture.databasePath },
      { kind: "singleton-state-foldin-v12", path: fixture.databasePath },
      { kind: "state-consolidation-v13", path: fixture.databasePath },
      { kind: "creator-namespace-v14", path: fixture.databasePath },
      { kind: "conversation-binding-targets-v15", path: fixture.databasePath },
      { kind: "automation-policy-fence-v21", path: fixture.databasePath },
      { kind: "audit-events-v2", path: fixture.databasePath },
      { kind: "strict-tables-v3", path: fixture.databasePath },
    ]);
    expectStateSchemaMigrationRequired(() => openOpenClawStateDatabase(options), {
      kind: "audit-events-v2",
      pathname: fixture.databasePath,
    });

    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [
        "Discarded retired shared-state commitments rows, table, and indexes",
        "Retired six dead shared-state tables (v10)",
        "Retired legacy skill curator lifecycle and proposal origin-run tables",
        "Folded singleton state tables into config_machine_state (v12)",
        "Migrated shared state audit event ledger → versioned message lifecycle schema",
        "Consolidated shared state tables (v13)",
        "Qualified historical cron creator attribution as unknown (v14)",
        "Removed redundant conversation binding target projections (v15)",
        "Migrated shared state tables to SQLite STRICT typing (48)",
      ],
      warnings: [],
    });
    const migrated = openOpenClawStateDatabase(options);

    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
    expect(migrated.db.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // The shipped v2026.7.1-2 database really carried these curator projections.
    for (const tableName of ["skill_lifecycle", "skill_workshop_proposal_origin_runs"]) {
      expect(
        migrated.db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(tableName),
      ).toBeUndefined();
    }
    // Published v1 state has no deletion history to lose; migration initializes its journal.
    const expected = createInitialStateSchemaShape();
    expect(normalizeSqliteSchemaShapeSql(collectSqliteSchemaShape(migrated.db))).toEqual(
      normalizeSqliteSchemaShapeSql(expected),
    );
    expect(readRetainedAgentDeletionsFromDatabase(migrated.db, fixture.databasePath)).toEqual({
      status: "empty",
    });
    // The fixture's auth_profile_stores row is keyed 'fixture-store', not the
    // production 'shared' key, so the v13 fold drops the table without
    // importing it into the KV.
    expect(
      migrated.db
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      migrated.db
        .prepare(
          "SELECT sequence, event_id, source_id, schema_version, agent_id, run_id FROM audit_events WHERE event_id = ?",
        )
        .get("fixture-audit-event"),
    ).toEqual({
      sequence: 7,
      event_id: "fixture-audit-event",
      source_id: "fixture-source",
      schema_version: 1,
      agent_id: "fixture-agent",
      run_id: "fixture-run",
    });
    expect(
      migrated.db
        .prepare(
          `INSERT INTO audit_events (
             event_id, source_id, source_sequence, occurred_at, kind, action, status,
             actor_type, actor_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "fixture-audit-next",
          "fixture-source-next",
          2,
          1600,
          "message",
          "message.received",
          "succeeded",
          "channel_sender",
          "fixture-sender",
        ).lastInsertRowid,
    ).toBe(41);
    expect(
      migrated.db
        .prepare(
          `SELECT scope, event_key, sequence
             FROM diagnostic_events
            ORDER BY scope, sequence`,
        )
        .all(),
    ).toEqual([
      { scope: "fixture-scope", event_key: "event-a", sequence: 1 },
      { scope: "fixture-scope", event_key: "event-b", sequence: 2 },
      { scope: "other-scope", event_key: "event-c", sequence: 1 },
    ]);
    expect(
      migrated.db
        .prepare(
          `SELECT task_id, runtime, source_id, status, ended_at
             FROM task_runs
            WHERE runtime = 'cron' AND source_id = 'fixture-cron'`,
        )
        .get(),
    ).toEqual({
      task_id: "cron-runlog-import:fixture-cron:1500:1",
      runtime: "cron",
      source_id: "fixture-cron",
      status: "succeeded",
      ended_at: 1500,
    });
    expect(
      migrated.db
        .prepare(
          `SELECT task_runs.task_id, task_runs.status, task_delivery_state.last_notified_event_at
             FROM task_runs
             JOIN task_delivery_state USING (task_id)
            WHERE task_runs.task_id = 'fixture-task'`,
        )
        .get(),
    ).toEqual({
      task_id: "fixture-task",
      status: "completed",
      last_notified_event_at: 1320,
    });
    for (const name of [
      ...RETIRED_COMMITMENT_SCHEMA_OBJECTS,
      ...RETIRED_STATE_TABLES_V10,
      "cron_run_logs",
      "node_pairing_pending",
      "node_pairing_paired",
      "idx_diagnostic_events_scope_created",
    ]) {
      expect(
        migrated.db.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(name),
      ).toBeUndefined();
    }
    expect(
      migrated.db
        .prepare(
          `SELECT type, name
             FROM sqlite_schema
            WHERE lower(name) LIKE '%commitment%'
            ORDER BY type, name`,
        )
        .all(),
    ).toEqual([]);
    expect(
      migrated.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'idx_diagnostic_events_scope_sequence'",
        )
        .get(),
    ).toEqual({ name: "idx_diagnostic_events_scope_sequence" });

    closeOpenClawStateDatabaseForTest();
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({ changes: [], warnings: [] });
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
    const reopened = openOpenClawStateDatabase(options);
    expect(reopened.db.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);
    expect(reopened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("refuses retirement and leaves an extra index unchanged on the final v6 commitments layout", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const customized = new DatabaseSync(databasePath);
    seedV6CommitmentSchema(customized);
    customized.exec("CREATE INDEX foreign_commitments_status ON commitments(status);");
    customized.close();

    expect(() => openOpenClawStateDatabase(options)).toThrow(/commitments/u);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readSqliteNumberPragma(preserved, "user_version")).toBe(6);
      expect(
        preserved.prepare("SELECT name FROM sqlite_schema WHERE name = 'commitments'").get(),
      ).toEqual({ name: "commitments" });
      expect(
        preserved
          .prepare("SELECT type, tbl_name FROM sqlite_schema WHERE name = ?")
          .get("foreign_commitments_status"),
      ).toEqual({ type: "index", tbl_name: "commitments" });
    } finally {
      preserved.close();
    }
  });

  it("refuses retirement and leaves an inbound foreign-key dependency unchanged through doctor repair", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const dependent = new DatabaseSync(databasePath);
    seedV6CommitmentSchema(dependent);
    dependent.exec(`
        CREATE TABLE sqliteX_dependents (
          id TEXT NOT NULL PRIMARY KEY,
          commitment_id TEXT NOT NULL REFERENCES commitments(id) ON DELETE CASCADE
        ) STRICT;
        INSERT INTO sqliteX_dependents (id, commitment_id)
        VALUES ('dependent-row', 'retired-commitment');
      `);
    dependent.close();

    const result = repairOpenClawStateDatabaseSchema(options);
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/referenced by table sqliteX_dependents/iu);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readSqliteNumberPragma(preserved, "user_version")).toBe(6);
      expect(preserved.prepare("SELECT id FROM commitments").all()).toEqual([
        { id: "retired-commitment" },
      ]);
      expect(preserved.prepare("SELECT id, commitment_id FROM sqliteX_dependents").all()).toEqual([
        { id: "dependent-row", commitment_id: "retired-commitment" },
      ]);
    } finally {
      preserved.close();
    }
  });

  it.each([
    {
      name: "commitment_projection",
      sql: "CREATE VIEW commitment_projection AS SELECT id FROM 'commitments';",
      error: /referenced by view commitment_projection/iu,
    },
    {
      name: "commitment_search",
      sql: `create virtual table commitment_search USING fts5(
        suggested_text, content='commitments', content_rowid='rowid'
      );`,
      error: /SQLite virtual table commitment_search is unusable/iu,
    },
    {
      name: "unrelated_broken_view",
      sql: "CREATE VIEW unrelated_broken_view AS SELECT id FROM missing_unrelated_table;",
      error: /Could not prove retained SQLite views and triggers independent of commitments/iu,
    },
  ])("refuses retirement and preserves the unresolved dependency $name", ({ name, sql, error }) => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const dependent = new DatabaseSync(databasePath);
    seedV6CommitmentSchema(dependent);
    dependent.exec(sql);
    dependent.close();

    expect(() => openOpenClawStateDatabase(options)).toThrow(error);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readSqliteNumberPragma(preserved, "user_version")).toBe(6);
      expect(preserved.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(name)).toEqual({
        name,
      });
      expect(preserved.prepare("SELECT id FROM commitments").all()).toEqual([
        { id: "retired-commitment" },
      ]);
    } finally {
      preserved.close();
    }
  });

  it("skips exclusive repair when the automatic schema gate is already current", async () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const before = new DatabaseSync(databasePath);
    before.prepare("UPDATE schema_meta SET updated_at = 123 WHERE meta_key = 'primary'").run();
    before.close();

    expect(await prepareOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [],
    });

    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        after.prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ updated_at: 123 });
    } finally {
      after.close();
    }
  });

  it("doctor migrates version 3 ambient watch sentinels into cursor provenance", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const seeded = seedLegacySessionWatchCursorSchema(stateDir);

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "creator-namespace-v14", path: seeded.databasePath },
      { kind: "automation-policy-fence-v21", path: seeded.databasePath },
      { kind: "session-watch-cursor-provenance-v4", path: seeded.databasePath },
    ]);
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [
        "Migrated cloud worker placements to execution modes",
        "Migrated shared state session watch cursors → provenance column (2 ambient, 5 sentinels removed)",
        "Qualified historical cron creator attribution as unknown (v14)",
      ],
      warnings: [],
    });

    const migrated = openOpenClawStateDatabase(options);
    expect(
      migrated.db
        .prepare(
          `SELECT watcher_session_key, target_session_key, last_seen_sequence,
                  notified_sequence, material_sequence, provenance, updated_at
           FROM session_watch_cursors
           ORDER BY target_session_key`,
        )
        .all(),
    ).toEqual([
      {
        watcher_session_key: seeded.watcherSessionKey,
        target_session_key: seeded.explicitTarget,
        last_seen_sequence: 3,
        notified_sequence: 4,
        material_sequence: 5,
        provenance: "explicit",
        updated_at: 300,
      },
      {
        watcher_session_key: seeded.watcherSessionKey,
        target_session_key: seeded.ambientTarget,
        last_seen_sequence: 7,
        notified_sequence: 8,
        material_sequence: 9,
        provenance: "ambient-group",
        updated_at: 400,
      },
      {
        watcher_session_key: seeded.bomWatcherSessionKey,
        target_session_key: seeded.bomTarget,
        last_seen_sequence: 10,
        notified_sequence: 11,
        material_sequence: 12,
        provenance: "ambient-group",
        updated_at: 800,
      },
      {
        watcher_session_key: seeded.replacementWatcherSessionKey,
        target_session_key: seeded.corruptTarget,
        last_seen_sequence: 13,
        notified_sequence: 14,
        material_sequence: 15,
        provenance: "explicit",
        updated_at: 600,
      },
    ]);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
    closeOpenClawStateDatabaseForTest();
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({ changes: [], warnings: [] });
  });

  it("repairs same-version Claw bootstrap columns with a missing index through its admitted path", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const shippedSchema = new DatabaseSync(databasePath);
    try {
      shippedSchema.exec(`
        ALTER TABLE claw_installs DROP COLUMN bootstrap_source_path;
        ALTER TABLE claw_installs DROP COLUMN bootstrap_content_digest;
      `);

      shippedSchema.exec("DROP INDEX idx_task_runs_status;");

      expect(readSqliteNumberPragma(shippedSchema, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
    } finally {
      shippedSchema.close();
    }

    const reopened = openOpenClawStateDatabase({ env });
    const columns = reopened.db.prepare("PRAGMA table_info(claw_installs)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["bootstrap_source_path", "bootstrap_content_digest"]),
    );

    expect(normalizeSqliteSchemaShapeSql(collectSqliteSchemaShape(reopened.db))).toEqual(
      normalizeSqliteSchemaShapeSql(createInitialStateSchemaShape()),
    );
  });

  it("keeps GitHub publication lazy across current-schema open, first use, and reopen", async () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const previousV9 = new DatabaseSync(databasePath);
    previousV9.exec(`
      DROP INDEX idx_github_publication_requests_pending;
      DROP TABLE github_publication_requests;
    `);
    expect(readSqliteNumberPragma(previousV9, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    previousV9.close();

    const beforeFirstUse = await openExistingOpenClawStateDatabaseReadOnly({ path: databasePath });
    expect(
      beforeFirstUse?.db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'github_publication_requests'")
        .get(),
    ).toBeUndefined();
    beforeFirstUse?.walMaintenance.close();

    const currentSchema = openOpenClawStateDatabase(options);
    expect(readSqliteNumberPragma(currentSchema.db, "user_version")).toBe(
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
    ensureGitHubPublicationSchema(currentSchema.db);
    expect(
      currentSchema.db
        .prepare(
          "SELECT type, name FROM sqlite_schema WHERE name IN ('github_publication_requests', 'idx_github_publication_requests_pending') ORDER BY type DESC",
        )
        .all(),
    ).toEqual([
      { type: "table", name: "github_publication_requests" },
      { type: "index", name: "idx_github_publication_requests_pending" },
    ]);
    expect(() =>
      assertSqliteSchemaContains(
        currentSchema.db,
        "previous v9 reader",
        getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
      ),
    ).not.toThrow();
    closeOpenClawStateDatabaseForTest();

    const reopened = openOpenClawStateDatabase(options);
    expect(() =>
      assertOpenClawStateDatabaseForMaintenance(reopened.db, { pathname: reopened.path }),
    ).not.toThrow();
    closeOpenClawStateDatabaseForTest();
    const readOnly = await openExistingOpenClawStateDatabaseReadOnly({ path: databasePath });
    expect(readOnly?.db.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    readOnly?.walMaintenance.close();
  });

  it("rejects a missing current-schema table instead of recreating it empty", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const drifted = new DatabaseSync(databasePath);
    drifted.exec("DROP TABLE apns_registration_tombstones;");
    const schemaBefore = hashSqliteSchema(drifted);
    drifted.close();

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /missing table apns_registration_tombstones/iu,
    );
    const refusal = {
      changes: [],
      warnings: [
        `Failed migrating shared state database schema at ${databasePath}: SqliteSchemaMismatchError: SQLite schema is incomplete or noncanonical for ${databasePath}: missing table apns_registration_tombstones; run openclaw doctor --fix to repair it.`,
      ],
    };
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual(refusal);

    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(hashSqliteSchema(after)).toBe(schemaBefore);
      expect(
        after
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'apns_registration_tombstones'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      after.close();
    }
  });

  it("rejects a missing stable v5 table before migration through startup admission", async () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    {
      const intact = new DatabaseSync(databasePath);
      markStateDatabaseVersion(intact, 5);
      intact.close();
      const before = snapshotPreflightSourceManifest(stateDir);
      await expect(
        assertOpenClawDatabasesReady({
          env: options.env,
          operation: "gateway-startup",
          config: {},
        }),
      ).resolves.toBeUndefined();
      expect(snapshotPreflightSourceManifest(stateDir)).toEqual(before);
    }
    const damaged = new DatabaseSync(databasePath);
    damaged.exec("DROP TABLE apns_registration_tombstones;");
    markStateDatabaseVersion(damaged, 5);
    const schemaBefore = hashSqliteSchema(damaged);
    const metadataBefore = damaged.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all();
    damaged.close();

    const message = `SQLite schema is incomplete or noncanonical for ${databasePath}: missing table apns_registration_tombstones; run openclaw doctor --fix to repair it.`;
    {
      const before = snapshotPreflightSourceManifest(stateDir);
      await expect(
        assertOpenClawDatabasesReady({
          env: options.env,
          operation: "gateway-startup",
          config: {},
        }),
      ).rejects.toThrow(new SqliteSchemaMismatchError(message));
      expect(snapshotPreflightSourceManifest(stateDir)).toEqual(before);
    }

    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        after
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'apns_registration_tombstones'",
          )
          .get(),
      ).toBeUndefined();
      expect(readSqliteNumberPragma(after, "user_version")).toBe(5);
      expect(hashSqliteSchema(after)).toBe(schemaBefore);
      expect(after.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all()).toEqual(
        metadataBefore,
      );
    } finally {
      after.close();
    }
  });

  it("keeps an unrecognized agent registry schema fail-closed and nonrepairable", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const malformed = openMaterializedCurrentStateDatabase(stateDir);
    malformed.exec(`
      DROP TABLE agent_databases;
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL PRIMARY KEY,
        path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `);
    malformed.close();

    let caught: unknown;
    try {
      openOpenClawStateDatabase(options);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(OpenClawStateDatabaseSchemaMigrationRequiredError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("unsupported agent database registry schema");
  });

  it("refuses an audit sequence high-water mark outside the supported cursor range", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("UPDATE sqlite_sequence SET seq = 9007199254740992 WHERE name = 'audit_events';");
    legacy.close();

    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [expect.stringContaining("exceeds the supported integer range")],
    });

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare(
            "SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'audit_events'",
          )
          .get(),
      ).toEqual({ seq: "9007199254740992" });
      expect(
        preserved.prepare("SELECT event_id FROM audit_events WHERE sequence = 7").get(),
      ).toEqual({ event_id: "event-legacy" });
    } finally {
      preserved.close();
    }
  });

  it("completes a recognized pre-v2 schema through runtime open before read-only consumers", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE audit_events;
      CREATE TABLE workspace_setup_state (
        workspace_key TEXT NOT NULL PRIMARY KEY, workspace_path TEXT NOT NULL,
        version INTEGER NOT NULL, bootstrap_seeded_at TEXT, setup_completed_at TEXT,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO workspace_setup_state VALUES ('legacy-workspace', '/tmp/legacy-workspace', 1,
        '2026-06-01T00:00:00.000Z', NULL, 100);
    `);
    legacy.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);

    openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();

    const repaired = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assertOpenClawStateDatabaseForMaintenance(repaired, { pathname: databasePath });
      expect(readSqliteNumberPragma(repaired, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      expect(
        repaired
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
          .get(),
      ).toEqual({ name: "audit_events" });
      expect(repaired.prepare("SELECT * FROM workspace_setup_state").get()).toMatchObject({
        workspace_key: "legacy-workspace",
        workspace_path: "/tmp/legacy-workspace",
        version: 1,
        bootstrap_seeded_at: "2026-06-01T00:00:00.000Z",
        updated_at: 100,
      });
    } finally {
      repaired.close();
    }
    expect(listOpenClawRegisteredAgentDatabases(options)).toEqual([]);
  });

  it.each([
    { ownership: "missing", auditLedger: false },
    { ownership: "foreign", auditLedger: true },
  ] as const)(
    "does not claim pre-v2 state with $ownership ownership metadata and audit ledger $auditLedger",
    ({ ownership, auditLedger }) => {
      const stateDir = createTempStateDir();
      const databasePath = createLegacyAuditStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      if (!auditLedger) {
        legacy.exec("DROP TABLE audit_events;");
      }
      legacy.exec(
        ownership === "missing"
          ? "DROP TABLE schema_meta;"
          : "UPDATE schema_meta SET role = 'agent', agent_id = 'worker-1';",
      );
      legacy.close();
      const before = fs.readFileSync(databasePath);
      expect(repairOpenClawStateDatabaseSchema({ env: { OPENCLAW_STATE_DIR: stateDir } })).toEqual({
        changes: [],
        warnings: [
          expect.stringContaining(
            auditLedger ? "schema role agent; expected global" : "expected global",
          ),
        ],
      });
      expect(fs.readFileSync(databasePath)).toEqual(before);
      if (auditLedger) {
        const preserved = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(readSqliteNumberPragma(preserved, "user_version")).toBe(1);
          expect(
            preserved
              .prepare(
                "SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'",
              )
              .get(),
          ).toEqual({ role: "agent", schema_version: 1, agent_id: "worker-1" });
          expect(
            preserved
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'apns_registration_tombstones'",
              )
              .get(),
          ).toBeUndefined();
        } finally {
          preserved.close();
        }
      }
    },
  );

  it.each([
    {
      name: "missing source identity uniqueness",
      mutate: (db: DatabaseSync) => {
        rebuildAuditEventsTable(db, (sql) =>
          sql.replace("source_id TEXT NOT NULL UNIQUE", "source_id TEXT NOT NULL"),
        );
        insertAuditMarker(db, "event-duplicate-source-1", "duplicate-source", 7);
        insertAuditMarker(db, "event-duplicate-source-2", "duplicate-source", 8);
      },
      query: "SELECT COUNT(*) AS count FROM audit_events WHERE source_id = 'duplicate-source'",
      expected: { count: 2 },
      warning: undefined,
    },
  ])(
    "refuses a noncanonical v2 audit ledger with $name",
    ({ mutate, query, expected, warning }) => {
      const stateDir = createTempStateDir();
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const malformed = new DatabaseSync(databasePath);
      mutate(malformed);
      malformed.close();
      expectNoncanonicalAuditSchemaRejected(stateDir, databasePath, warning);
      const preserved = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(preserved.prepare(query).get()).toEqual(expected);
      } finally {
        preserved.close();
      }
    },
  );

  it.each(["directory removal", "native close"] as const)(
    "retains a read-only snapshot until failed %s succeeds",
    async (failureStage) => {
      const stateDir = createTempStateDir();
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const database = await openExistingOpenClawStateDatabaseReadOnly({ path: databasePath });
      if (!database) {
        throw new Error("Expected the existing state snapshot");
      }
      const privatePath = database.db.location();
      if (!privatePath) {
        throw new Error("Expected a filesystem-backed snapshot");
      }
      const privateDirectory = path.dirname(privatePath);
      const failure = new Error("snapshot native close failed");
      let restore: () => void;
      if (failureStage === "native close") {
        const close = vi.spyOn(database.db, "close").mockImplementationOnce(() => {
          throw failure;
        });
        restore = () => close.mockRestore();
      } else {
        const rmSync = fs.rmSync.bind(fs);
        let failRemoval = true;
        const remove = vi.spyOn(fs, "rmSync").mockImplementation(((pathname, options) => {
          if (
            failRemoval &&
            isPathInside(
              fs.realpathSync.native(String(pathname)),
              fs.realpathSync.native(privateDirectory),
            )
          ) {
            failRemoval = false;
            const error = new Error("busy");
            (error as NodeJS.ErrnoException).code = "EBUSY";
            throw error;
          }
          return rmSync(pathname, options);
        }) as typeof fs.rmSync);
        restore = () => remove.mockRestore();
      }
      try {
        if (failureStage === "native close") {
          expect(() => database.walMaintenance.close()).toThrow(failure);
          expect(database.db.isOpen).toBe(true);
        } else {
          expect(database.walMaintenance.close()).toBe(false);
        }
        expect(fs.existsSync(privateDirectory)).toBe(true);
        expect(database.walMaintenance.close()).toBe(true);
        expect(database.db.isOpen).toBe(false);
        expect(fs.existsSync(privateDirectory)).toBe(false);
        expect(database.walMaintenance.close()).toBe(false);
      } finally {
        restore();
        database.walMaintenance.close();
      }
    },
  );

  it("retains refused snapshot cleanup for lifecycle retry without hiding the schema error", async () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const futureVersion = OPENCLAW_STATE_SCHEMA_VERSION + 1;
    const source = new DatabaseSync(databasePath);
    source.exec(`PRAGMA user_version = ${futureVersion}`);
    source.close();
    const readers = new Set<DatabaseSync>();
    let privateDirectory: string | undefined;
    let refuseClose = true;
    const sqlite = await import("../infra/node-sqlite.js");
    const openNative = sqlite.openNodeSqliteDatabase;
    const open = vi
      .spyOn(sqlite, "openNodeSqliteDatabase")
      .mockImplementation((location, options) => {
        const reader = openNative(location, options);
        const readerPath = reader.location();
        if (
          options?.readOnly &&
          readerPath &&
          readerPath !== databasePath &&
          reader.prepare("PRAGMA user_version").get()?.user_version === futureVersion
        ) {
          readers.add(reader);
          privateDirectory = path.dirname(readerPath);
          const closeNative = reader.close.bind(reader);
          reader.close = () => {
            if (refuseClose) {
              throw new Error("refused snapshot native close failed");
            }
            closeNative();
          };
        }
        return reader;
      });
    try {
      await expect(
        openExistingOpenClawStateDatabaseReadOnly({ path: databasePath }),
      ).rejects.toMatchObject({ name: "SqliteSchemaVersionError" });
      const reader = readers.values().next().value;
      if (!reader || !privateDirectory) {
        throw new Error("Expected the refused private snapshot reader");
      }
      expect(reader.isOpen).toBe(true);
      expect(fs.existsSync(privateDirectory)).toBe(true);
      refuseClose = false;
      closeOpenClawStateDatabaseForTest();
      expect(reader.isOpen).toBe(false);
      expect(fs.existsSync(privateDirectory)).toBe(false);
    } finally {
      refuseClose = false;
      open.mockRestore();
      try {
        closeOpenClawStateDatabaseForTest();
      } finally {
        for (const reader of readers) {
          if (reader.isOpen) {
            reader.close();
          }
        }
      }
    }
  });

  it("reads committed live WAL rows without changing source database content", async () => {
    const stateDir = createTempStateDir();
    const writer = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    writer.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint = 0;");
    insertTaskRunProbe(writer.db, "task-live-wal");
    expect(fs.existsSync(`${writer.path}-wal`)).toBe(true);
    expect(fs.existsSync(`${writer.path}-shm`)).toBe(true);
    const beforeMain = fs.readFileSync(writer.path);
    const beforeWal = fs.readFileSync(`${writer.path}-wal`);
    const beforeShmSize = fs.statSync(`${writer.path}-shm`).size;
    const beforeEntries = fs.readdirSync(stateDir).toSorted();

    const database = await openExistingOpenClawStateDatabaseReadOnly({ path: writer.path });
    expect(
      database?.db.prepare("SELECT task_id FROM task_runs WHERE task_id = ?").get("task-live-wal"),
    ).toEqual({ task_id: "task-live-wal" });
    const openedPath = database?.db.prepare("PRAGMA database_list").get() as
      | { file?: unknown }
      | undefined;
    expect(path.resolve(String(openedPath?.file))).not.toBe(path.resolve(writer.path));
    const privateDirectory = path.dirname(String(openedPath?.file));
    expect(database?.walMaintenance.close()).toBe(true);

    expect(fs.existsSync(privateDirectory)).toBe(false);
    deepStrictEqual(fs.readFileSync(writer.path), beforeMain);
    deepStrictEqual(fs.readFileSync(`${writer.path}-wal`), beforeWal);
    expect(fs.statSync(`${writer.path}-shm`).size).toBe(beforeShmSize);
    expect(fs.readdirSync(stateDir).toSorted()).toEqual(beforeEntries);
  });

  it("rejects unrelated current-schema index corruption before exposure", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    createUnsafeIndexDrift(databasePath);

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /integrity_check failed.*missing from index unsafe_index_records_value/iu,
    );
    const checkpointCallback = vi.fn();
    expect(() =>
      withOpenClawStateStartupMigrationCheckpointDatabase(checkpointCallback, options),
    ).toThrow(/integrity_check failed.*missing from index unsafe_index_records_value/iu);
    expect(checkpointCallback).not.toHaveBeenCalled();
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [
        expect.stringContaining("Saved pre-repair SQLite backup:"),
        expect.stringContaining(
          "Rebuilt corrupt shared-state SQLite indexes: unsafe_index_records_value",
        ),
      ],
      warnings: [],
    });
    expect(openOpenClawStateDatabase(options).db.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
  });

  it("configures checkpoint lock waits before schema mutation", () => {
    const stateDir = createTempStateDir();

    withOpenClawStateStartupMigrationCheckpointDatabase(
      (db) => {
        expect(readSqliteNumberPragma(db, "busy_timeout")).toBe(OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
      },
      { env: { OPENCLAW_STATE_DIR: stateDir } },
    );
  });

  it("preserves orphan delivery payload before Doctor recovery from 2026.7.1-2", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeV2026_7_1_2StateDatabase(stateDir).databasePath;
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const corrupted = new DatabaseSync(databasePath);
    const payload = '  {"channel":"synthetic","to":"recover-me"}\n\u0000';
    const timestamp = 9007199254740993n;
    try {
      corrupted.exec(
        "PRAGMA foreign_keys = OFF; PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;",
      );
      corrupted.exec(`INSERT INTO task_runs
          (task_id,runtime,owner_key,scope_kind,task,status,delivery_status,notify_policy,created_at)
          VALUES ('healthy-task','subagent','synthetic-owner','session','keep me','completed','delivered','silent',1);
          INSERT INTO task_delivery_state(task_id) VALUES ('healthy-task');`);
      const insert = corrupted.prepare(`INSERT INTO task_delivery_state
          (task_id,requester_origin_json,last_notified_event_at) VALUES (?,?,?)`);
      for (let index = 0; index < 18; index += 1) {
        insert.run(`missing-task-${index}`, payload, timestamp);
      }
      expect(corrupted.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(corrupted.prepare("PRAGMA foreign_key_check").all()).toHaveLength(18);
      expect(fs.statSync(`${databasePath}-wal`).size).toBeGreaterThan(0);
      const failure = /foreign_key_check failed.*task_delivery_state.*references task_runs/iu;
      expect(() => openOpenClawStateDatabase(options)).toThrow(failure);
      const checkpointCallback = vi.fn();
      expect(() =>
        withOpenClawStateStartupMigrationCheckpointDatabase(checkpointCallback, options),
      ).toThrow(failure);
      expect(checkpointCallback).not.toHaveBeenCalled();

      const result = repairOpenClawStateDatabaseSchema(options);
      expect(result.warnings).toEqual([]);
      expect(result.changes).toContainEqual(
        expect.stringContaining("Preserved and recovered 18 orphan task delivery rows"),
      );
      const recoveryDirs = fs
        .readdirSync(path.dirname(databasePath))
        .filter((name) => name.startsWith("openclaw-task-delivery-recovery-"));
      expect(recoveryDirs).toHaveLength(1);
      const recoveryDir = path.join(path.dirname(databasePath), recoveryDirs[0]!);
      const backup = new DatabaseSync(path.join(recoveryDir, "database.sqlite"), {
        readOnly: true,
      });
      try {
        expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(backup.prepare("PRAGMA foreign_key_check").all()).toHaveLength(18);
        const row = backup.prepare(
          "SELECT requester_origin_json,last_notified_event_at FROM task_delivery_state WHERE task_id = ?",
        );
        row.setReadBigInts(true);
        expect(row.get("missing-task-0")).toEqual({
          requester_origin_json: payload,
          last_notified_event_at: timestamp,
        });
      } finally {
        backup.close();
      }
      const exported = fs
        .readFileSync(path.join(recoveryDir, "orphan-rows.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(exported).toHaveLength(18);
      expect(exported[0]).toMatchObject({
        requester_origin_json: payload,
        last_notified_event_at: timestamp.toString(),
      });
      const repaired = openOpenClawStateDatabase(options);
      expect(repaired.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(repaired.db.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(repaired.db.prepare("SELECT task_id FROM task_delivery_state").all()).toContainEqual({
        task_id: "healthy-task",
      });
      expect(
        repaired.db
          .prepare("SELECT 1 FROM task_delivery_state WHERE task_id LIKE 'missing-task-%'")
          .all(),
      ).toEqual([]);
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      expect(
        fs
          .readdirSync(path.dirname(databasePath))
          .filter((name) => name.startsWith("openclaw-task-delivery-recovery-")),
      ).toEqual(recoveryDirs);
    } finally {
      corrupted.close();
    }
  });

  it.each(["unrelated foreign key", "trigger"])(
    "refuses orphan delivery recovery with %s without changing data",
    (variant) => {
      const stateDir = createTempStateDir();
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const seed = new DatabaseSync(databasePath);
      try {
        seed.exec(
          "PRAGMA foreign_keys = OFF; INSERT INTO task_delivery_state(task_id, requester_origin_json) VALUES ('orphan', 'preserve me')",
        );
        if (variant === "unrelated foreign key") {
          seed.exec(
            "CREATE TABLE other_child(task_id TEXT REFERENCES task_runs(task_id)); INSERT INTO other_child VALUES ('unrelated-orphan')",
          );
        } else {
          seed.exec(
            "CREATE TRIGGER unknown_delivery_cleanup AFTER DELETE ON task_delivery_state BEGIN DELETE FROM task_runs; END",
          );
        }
        const before = seed.prepare("PRAGMA foreign_key_check").all();
        const result = repairOpenClawStateDatabaseSchema({ env: { OPENCLAW_STATE_DIR: stateDir } });
        expect(result.changes).toEqual([]);
        expect(result.warnings.join("\n")).toMatch(
          variant === "unrelated foreign key"
            ? /foreign_key_check failed/
            : /refused an unrecognized/,
        );
        expect(
          seed
            .prepare(
              "SELECT requester_origin_json FROM task_delivery_state WHERE task_id = 'orphan'",
            )
            .get(),
        ).toEqual({ requester_origin_json: "preserve me" });
        expect(seed.prepare("PRAGMA foreign_key_check").all()).toEqual(before);
        expect(
          fs
            .readdirSync(path.dirname(databasePath))
            .filter((name) => name.startsWith("openclaw-task-delivery-recovery-")),
        ).toEqual([]);
      } finally {
        seed.close();
      }
    },
  );

  it("rolls back orphan delivery recovery after CASCADE and retains the original backup", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const seed = new DatabaseSync(databasePath);

    try {
      seed.exec(
        "PRAGMA foreign_keys = OFF; INSERT INTO task_delivery_state(task_id, requester_origin_json) VALUES ('orphan', 'preserve me')",
      );

      seed.exec(
        "CREATE TABLE delivery_dependent(task_id TEXT REFERENCES task_delivery_state(task_id) ON DELETE CASCADE); INSERT INTO delivery_dependent VALUES ('orphan')",
      );

      const result = repairOpenClawStateDatabaseSchema({ env: { OPENCLAW_STATE_DIR: stateDir } });
      expect(result.changes).toEqual([]);
      expect(result.warnings.join("\n")).toMatch(/foreign_key_check failed.*delivery_dependent/);
      expect(
        seed
          .prepare("SELECT requester_origin_json FROM task_delivery_state WHERE task_id = 'orphan'")
          .get(),
      ).toEqual({ requester_origin_json: "preserve me" });
      expect(seed.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);

      expect(seed.prepare("SELECT task_id FROM delivery_dependent").all()).toEqual([
        { task_id: "orphan" },
      ]);

      const artifacts = fs
        .readdirSync(path.dirname(databasePath))
        .filter((name) => name.startsWith("openclaw-task-delivery-recovery-"));
      expect(artifacts).toHaveLength(1);
      const backup = new DatabaseSync(
        path.join(path.dirname(databasePath), artifacts[0]!, "database.sqlite"),
        { readOnly: true },
      );
      try {
        expect(
          backup
            .prepare(
              "SELECT requester_origin_json FROM task_delivery_state WHERE task_id = 'orphan'",
            )
            .get(),
        ).toEqual({ requester_origin_json: "preserve me" });
        expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        backup.close();
      }
    } finally {
      seed.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "recovers a hot rollback journal privately before writable recovery",
    ({ signal }) =>
      fixtureLifetime.run(async () => {
        signal.throwIfAborted();
        const result = await runHotRollbackJournalRecoveryProbe({
          moduleUrl: resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase).href,
          rootDir: processTempDirs.make("openclaw-state-db-"),
          signal,
          verifyCleanup: fixtureLifetime.verifyCleanup,
        });

        expect(result.readOnly).toEqual({
          error: null,
          opened: true,
          uncommittedRows: 0,
        });
        expect(result).toMatchObject({
          committedRowsAfterRecovery: 256,
          immutableDirtyRowsBeforeKill: expect.any(Number),
          integrity: "ok",
          journalBytesBeforeReadOnly: expect.any(Number),
          journalExistsAfterReadOnly: true,
          journalExistsAfterRecovery: false,
        });
        expect(result.immutableDirtyRowsBeforeKill).toBeGreaterThan(0);
        expect(result.journalBytesBeforeReadOnly).toBeGreaterThan(0);
        expect(result.journalShaAfterReadOnly).toBe(result.journalShaBeforeReadOnly);
      }),
  );

  it("adds and backfills Claw package update timestamps in existing state databases", () => {
    const stateDir = createTempStateDir();
    const legacyDb = openMaterializedCurrentStateDatabase(stateDir);
    legacyDb
      .prepare(
        "INSERT INTO claw_package_refs (" +
          "agent_id, package_kind, package_source, package_ref, package_version, " +
          "package_integrity, schema_version, claw_name, package_status, relationship, origin, independent_owner, installed_at_ms, updated_at_ms" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "incident",
        "plugin",
        "clawhub",
        "@owner/audit",
        "2.0.1",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "openclaw.clawPackageRef.v1",
        "incident-claw",
        "complete",
        "referenced",
        "claw-introduced",
        0,
        1234,
        5678,
      );
    legacyDb.exec("ALTER TABLE claw_package_refs DROP COLUMN updated_at_ms");
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(
      reopened.db.prepare("SELECT installed_at_ms, updated_at_ms FROM claw_package_refs").get(),
    ).toEqual({ installed_at_ms: 1234, updated_at_ms: 1234 });
  });

  it("backfills durable approval transport references in databases created by PR 1", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const approvalId = "approval/from-pr1";
    const expectedRef = buildApprovalResolutionRef({ approvalId, approvalKind: "exec" });
    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb
      .prepare(
        `INSERT INTO operator_approvals (
          approval_id,
          resolution_ref,
          kind,
          status,
          presentation_json,
          requested_by_device_token_auth,
          reviewer_device_ids_json,
          audience_session_keys_json,
          runtime_epoch,
          created_at_ms,
          expires_at_ms,
          updated_at_ms
        ) VALUES (?, ?, 'exec', 'pending', ?, 0, '[]', '[]', 'pr1-runtime', 1, 1000, 1)`,
      )
      .run(
        approvalId,
        expectedRef,
        JSON.stringify({
          kind: "exec",
          commandText: "echo migration",
          commandPreview: null,
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "deny"],
        }),
      );
    legacyDb.exec(`
      DROP INDEX idx_operator_approvals_resolution_ref;
      ALTER TABLE operator_approvals DROP COLUMN resolution_ref;
    `);
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    expect(
      reopened.db
        .prepare("SELECT resolution_ref FROM operator_approvals WHERE approval_id = ?")
        .get(approvalId),
    ).toEqual({ resolution_ref: expectedRef });
    const indexes = reopened.db.prepare("PRAGMA index_list(operator_approvals)").all() as Array<{
      name?: unknown;
      unique?: unknown;
    }>;
    expect(indexes).toContainEqual(
      expect.objectContaining({ name: "idx_operator_approvals_resolution_ref", unique: 1 }),
    );
  });

  it("migrates operator approvals to accept system-agent records", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    const currentSql = (
      legacyDb
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approvals'",
        )
        .get() as { sql: string }
    ).sql;
    legacyDb.exec("ALTER TABLE operator_approvals RENAME TO operator_approvals_current");
    legacyDb.exec(currentSql.replace("'exec', 'plugin', 'system-agent'", "'exec', 'plugin'"));
    legacyDb.exec("DROP TABLE operator_approvals_current");
    legacyDb.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
      kind: "operator-approvals-system-agent",
      path: databasePath,
    });
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [
        "Migrated shared state operator approvals → OpenClaw system changes",
        expect.stringMatching(/^Rebuilt canonical shared-state SQLite indexes \(\d+\)$/u),
      ],
      warnings: [],
    });

    const reopened = openOpenClawStateDatabase(options);
    const migratedSql = reopened.db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approvals'")
      .get() as { sql: string };
    expect(migratedSql.sql).toContain("'system-agent'");
  });

  it("does not recursively recommend doctor when operator approval repair refuses a shape", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const customizedDb = openMaterializedCurrentStateDatabase(stateDir);
    const currentSql = (
      customizedDb
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approvals'",
        )
        .get() as { sql: string }
    ).sql;
    customizedDb.exec("ALTER TABLE operator_approvals RENAME TO operator_approvals_current");
    customizedDb.exec(
      currentSql.replace("'exec', 'plugin', 'system-agent'", "'exec', 'plugin', 'custom-thing'"),
    );
    customizedDb.exec("DROP TABLE operator_approvals_current");
    customizedDb.close();

    const result = repairOpenClawStateDatabaseSchema(options);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("automatic repair refused the unrecognized schema shape"),
    ]);
    expect(result.warnings[0]).not.toContain("run openclaw doctor --fix");
  });

  it.for(["upgrade", "fresh"] as const)(
    "serializes concurrent %s database initialization across processes",
    { timeout: 60_000 },
    (mode, { signal }) =>
      fixtureLifetime.run(async () => {
        signal.throwIfAborted();
        const rootDir = processTempDirs.make("openclaw-state-db-");
        const moduleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase).href;
        const databasePaths = await runConcurrentSchemaProbe({
          mode,
          moduleUrl,
          rootDir,
          signal,
          verifyCleanup: fixtureLifetime.verifyCleanup,
        });
        const expectedShape = createInitialStateSchemaShape();
        const { DatabaseSync } = requireNodeSqlite();

        expect(databasePaths).toHaveLength(1);
        for (const databasePath of databasePaths) {
          const db = new DatabaseSync(databasePath, { readOnly: true });
          try {
            expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
            expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
            if (mode === "fresh") {
              expect(readSqliteNumberPragma(db, "auto_vacuum")).toBe(2);
            }
            expect(readSqliteNumberPragma(db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
            expect(
              db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
            ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
            expect(collectSqliteSchemaShape(db)).toEqual(expectedShape);
          } finally {
            db.close();
          }
        }
      }),
  );

  it("opens databases with early cron tables before creating cron indexes", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    const jobJson = JSON.stringify({
      id: "legacy-job",
      name: "Legacy job",
      enabled: true,
      deleteAfterRun: true,
      createdAtMs: 123,
      updatedAtMs: 456,
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 0 },
      payload: { kind: "agentTurn", message: "hello", model: "anthropic/claude-sonnet-4-6" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "chat-1",
        accountId: "acct-1",
        bestEffort: true,
        failureDestination: { to: "https://example.invalid/hook" },
      },
      failureAlert: { mode: "announce", channel: "discord", to: "ops", after: 2 },
    });
    const projectedJobJson = JSON.stringify({ delivery: { threadId: 1008013 } });
    db.exec(`
      CREATE TABLE cron_jobs (
        store_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        schedule_kind TEXT NOT NULL DEFAULT 'manual',
        payload_kind TEXT NOT NULL DEFAULT 'message',
        delivery_thread_id TEXT,
        job_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store_key, job_id)
      );
    `);
    db.prepare(
      `INSERT INTO cron_jobs (store_key, job_id, job_json, updated_at)
         VALUES (?, ?, ?, ?)`,
    ).run(path.join(stateDir, "cron", "jobs.json"), "legacy-job", jobJson, 456);
    db.prepare(
      `INSERT INTO cron_jobs (
         store_key, job_id, name, schedule_kind, payload_kind, delivery_thread_id, job_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      path.join(stateDir, "cron", "jobs.json"),
      "already-projected-job",
      "Already projected",
      "every",
      "agentTurn",
      null,
      projectedJobJson,
      456,
    );
    db.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(
      database.db
        .prepare(
          `SELECT name, enabled, payload_kind, agent_id, job_json
             FROM cron_jobs
            WHERE job_id = ?`,
        )
        .get("legacy-job"),
    ).toEqual({
      enabled: 1,
      agent_id: "agent-a",
      name: "Legacy job",
      payload_kind: "agentTurn",
      job_json: jobJson,
    });
    expect(
      database.db
        .prepare(
          `SELECT json_extract(job_json, '$.delivery.threadId') AS delivery_thread_id
             FROM cron_jobs
            WHERE job_id = ?`,
        )
        .get("already-projected-job"),
    ).toEqual({ delivery_thread_id: 1008013 });
  });

  it("opens databases with early queue tables before creating newer indexes", async () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE sandbox_registry_entries (
        registry_kind TEXT NOT NULL,
        container_name TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (registry_kind, container_name)
      );
      CREATE TABLE delivery_queue_entries (
        queue_name TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        failed_at INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (queue_name, id)
      );
    `);
    db.prepare(
      `INSERT INTO delivery_queue_entries (
          queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "outbound",
      "delivery-1",
      "pending",
      JSON.stringify({
        id: "delivery-1",
        enqueuedAt: 10,
        retryCount: 3,
        lastAttemptAt: 20,
        lastError: "no listener",
        kind: "message",
        sessionKey: "agent:main:main",
        route: { channel: "telegram", to: "chat-1", accountId: "acct-1" },
      }),
      10,
      10,
      null,
    );
    db.prepare(
      `INSERT INTO delivery_queue_entries (
          queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "outbound",
      "delivery-invalid-integers",
      "pending",
      JSON.stringify({
        id: "delivery-invalid-integers",
        enqueuedAt: 11,
        retryCount: 1.5,
        lastAttemptAt: Number.MAX_SAFE_INTEGER + 1,
        platformSendStartedAt: 2.5,
      }),
      11,
      11,
      null,
    );
    const boundedRetention = {
      idPrefix: "cron-direct-delivery:v1:",
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxEntries: 10,
    };
    const pendingBoundedRetention = {
      idPrefix: "upgrade-bounded:v1:",
      maxAgeMs: 86_400_000,
      maxEntries: 2,
    };
    const insertPendingQueueRow = db.prepare(
      `INSERT INTO delivery_queue_entries (
          queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at
        ) VALUES (?, ?, 'pending', ?, 20, 20, NULL)`,
    );
    const pendingEntries = [
      {
        queueName: "outbound",
        id: "pending-failure-retention",
        enqueuedAt: 20,
        retryCount: 0,
        failureRetention: "permanent",
        payloads: [{ text: "keep until terminal transition" }],
      },
      {
        queueName: "outbound",
        id: "upgrade-bounded:v1:pending-completion-retention",
        enqueuedAt: 20,
        retryCount: 0,
        completionRetention: pendingBoundedRetention,
        payloads: [{ text: "private" }],
      },
      {
        queueName: "outbound",
        id: "pending-required-claim",
        enqueuedAt: 20,
        retryCount: 0,
        requiresProducerClaim: true,
        payloads: [{ text: "private" }],
      },
      {
        queueName: "outbound",
        id: "pending-producer-claim",
        enqueuedAt: 20,
        retryCount: 0,
        producerClaimId: "claim-before-upgrade",
        payloads: [{ text: "private" }],
      },
      {
        queueName: "outbound-prepared-v1",
        id: "pending-ambiguous-platform-send",
        enqueuedAt: 20,
        retryCount: 0,
        platformSendAttemptId: "attempt-before-upgrade",
        recoveryState: "unknown_after_send",
        payloads: [{ text: "private ambiguous send" }],
      },
      {
        queueName: "session",
        id: "pending-session-available-at",
        enqueuedAt: 20,
        retryCount: 0,
        availableAt: 30,
        payloads: [{ text: "private claimed session" }],
      },
      {
        queueName: "outbound-preparing-v1",
        id: "pending-stable-preparation",
        enqueuedAt: 20,
        retryCount: 0,
        payloads: [{ text: "private stable preparation" }],
      },
      {
        queueName: "outbound-prepared-v1",
        id: "pending-delivery-completion",
        enqueuedAt: 20,
        retryCount: 0,
        deliveryCompletion: { kind: "conversation", operationId: "op-before-upgrade" },
        payloads: [{ text: "private durable completion" }],
      },
    ];
    for (const { queueName, ...entry } of pendingEntries) {
      insertPendingQueueRow.run(queueName, entry.id, JSON.stringify(entry));
    }
    const insertQueueRow = db.prepare(
      `INSERT INTO delivery_queue_entries (
          queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at
        ) VALUES (?, ?, 'failed', ?, ?, ?, ?)`,
    );
    insertQueueRow.run(
      "outbound",
      "rich-failure",
      JSON.stringify({
        id: "rich-failure",
        enqueuedAt: 30,
        retryCount: 2,
        channel: "private-channel",
        to: "private-target",
        accountId: "private-account",
        lastError: "raw provider error",
        payloads: [{ text: "private payload", mediaUrl: "/private/media" }],
      }),
      30,
      31,
      32,
    );
    insertQueueRow.run("session", "malformed-failure", "{corrupt private bytes", 40, -1, -1);
    insertQueueRow.run(
      "session",
      "minimal-failure",
      JSON.stringify({ id: "minimal-failure", enqueuedAt: 50, failedAt: 52, retryCount: 1 }),
      50,
      51,
      52,
    );
    insertQueueRow.run(
      "outbound-prepared-v1",
      "ambiguous-beta-failure",
      JSON.stringify({
        id: "ambiguous-beta-failure",
        enqueuedAt: 53,
        retryCount: 2,
        platformSendAttemptId: "beta-attempt",
        payloads: [{ text: "private ambiguous payload" }],
      }),
      53,
      54,
      55,
    );
    for (const [id, metadata, retryCount] of [
      ["cron-direct-delivery:v1:canonical", { completionRetention: boundedRetention }, 3],
      ["cron-direct-delivery:v1:failure", { failureRetention: boundedRetention }, 4],
      [
        "cron-direct-delivery:v1:terminal",
        { terminalPolicy: { fence: { kind: "producer-bounded", ...boundedRetention } } },
        5,
      ],
      ["terminal-permanent", { terminalPolicy: { fence: { kind: "permanent" } } }, 6],
      ["terminal-none", { retainOnFailure: true, terminalPolicy: { fence: { kind: "none" } } }, 7],
      ["legacy-none", { failureRetention: "none" }, 8],
      ["delivery-completion", { deliveryCompletion: { kind: "conversation" } }, 9],
      ["fractional-retry", { retainOnFailure: true }, 1.5],
      ["negative-retry", { retainOnFailure: true }, -1],
      ["unsafe-retry", { retainOnFailure: true }, Number.MAX_SAFE_INTEGER + 1],
      ["string-retry", { retainOnFailure: true }, "7"],
    ] as const) {
      insertQueueRow.run(
        "outbound",
        id,
        JSON.stringify({ id, enqueuedAt: 60, retryCount, ...metadata }),
        60,
        61,
        62,
      );
    }
    insertQueueRow.run(
      "session",
      "claimed-session-failure",
      JSON.stringify({
        id: "claimed-session-failure",
        enqueuedAt: 60,
        retryCount: 1,
        availableAt: 70,
      }),
      60,
      61,
      62,
    );
    const unsafeTimestampRetention = {
      idPrefix: "unsafe-timestamp:",
      maxAgeMs: 86_400_000,
      maxEntries: 1,
    };
    insertQueueRow.run(
      "outbound",
      "unsafe-timestamp:bounded",
      JSON.stringify({
        id: "unsafe-timestamp:bounded",
        enqueuedAt: 60,
        retryCount: 1,
        completionRetention: unsafeTimestampRetention,
      }),
      60,
      61,
      62,
    );
    const backfillCapRetention = {
      idPrefix: "backfill-cap:",
      maxAgeMs: 86_400_000,
      maxEntries: 1,
    };
    for (const [id, terminalAt] of [
      ["backfill-cap:old", 70],
      ["backfill-cap:new", 71],
    ] as const) {
      insertQueueRow.run(
        "outbound",
        id,
        JSON.stringify({
          id,
          enqueuedAt: terminalAt,
          retryCount: 0,
          completionRetention: backfillCapRetention,
        }),
        terminalAt,
        terminalAt,
        terminalAt,
      );
    }
    db.exec(
      "UPDATE delivery_queue_entries SET retry_count = 9223372036854775807 WHERE id = 'unsafe-retry'",
    );
    db.exec(
      "UPDATE delivery_queue_entries SET updated_at = 9223372036854775807, failed_at = 9223372036854775807 WHERE id = 'unsafe-timestamp:bounded'",
    );
    db.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(() =>
      database.db.prepare("SELECT session_key FROM sandbox_registry_entries LIMIT 1").all(),
    ).not.toThrow();
    expect(() =>
      database.db.prepare("SELECT session_key FROM delivery_queue_entries LIMIT 1").all(),
    ).not.toThrow();
    expect(
      database.db
        .prepare(
          `SELECT retry_count, last_attempt_at, last_error, entry_kind, session_key,
                  channel, target, account_id
             FROM delivery_queue_entries
            WHERE id = ?`,
        )
        .get("delivery-1"),
    ).toEqual({
      account_id: "acct-1",
      channel: "telegram",
      entry_kind: "message",
      last_attempt_at: 20,
      last_error: "no listener",
      retry_count: 3,
      session_key: "agent:main:main",
      target: "chat-1",
    });
    expect(
      database.db
        .prepare(
          `SELECT retry_count, last_attempt_at, platform_send_started_at
             FROM delivery_queue_entries
            WHERE id = 'delivery-invalid-integers'`,
        )
        .get(),
    ).toEqual({ retry_count: 0, last_attempt_at: null, platform_send_started_at: null });
    expect(loadDeliveryQueueEntry("outbound", "pending-failure-retention", stateDir)).toMatchObject(
      {
        failureRetention: "permanent",
        payloads: [{ text: "keep until terminal transition" }],
      },
    );
    expect(
      loadDeliveryQueueEntry(
        "outbound",
        "upgrade-bounded:v1:pending-completion-retention",
        stateDir,
      ),
    ).toMatchObject({
      completionRetention: pendingBoundedRetention,
      payloads: [{ text: "private" }],
    });
    expect(
      loadDeliveryQueueEntry("session", "pending-session-available-at", stateDir),
    ).toMatchObject({
      retainOnFailure: true,
      availableAt: 30,
      payloads: [{ text: "private claimed session" }],
    });
    expect(
      loadDeliveryQueueEntry("outbound-preparing-v1", "pending-stable-preparation", stateDir),
    ).toMatchObject({
      retainOnFailure: true,
      payloads: [{ text: "private stable preparation" }],
    });
    expect(
      loadDeliveryQueueEntry("outbound-prepared-v1", "pending-delivery-completion", stateDir),
    ).toMatchObject({
      retainOnFailure: true,
      deliveryCompletion: { kind: "conversation", operationId: "op-before-upgrade" },
      payloads: [{ text: "private durable completion" }],
    });
    expect(
      loadDeliveryQueueEntry("outbound-prepared-v1", "pending-ambiguous-platform-send", stateDir),
    ).toMatchObject({
      retainOnFailure: true,
      platformSendAttemptId: "attempt-before-upgrade",
      payloads: [{ text: "private ambiguous send" }],
    });
    const transientClaimIds = new Set(["pending-required-claim", "pending-producer-claim"]);
    for (const { queueName, ...pending } of pendingEntries) {
      const entry = loadDeliveryQueueEntry(queueName, pending.id, stateDir);
      expect(entry).not.toBeNull();
      expect(
        terminalizePendingDeliveryQueueEntry({
          queueName,
          id: pending.id,
          entry: entry!,
          stateDir,
        }),
      ).toEqual({ status: "terminalized", retained: !transientClaimIds.has(pending.id) });
    }
    const failureRowsSql = `
      SELECT id, entry_kind, session_key, channel, target, account_id, retry_count,
             last_attempt_at, last_error, recovery_state, platform_send_started_at,
             entry_json, enqueued_at, failed_at
        FROM delivery_queue_entries
       WHERE status = 'failed'
       ORDER BY id`;
    const failureRows = database.db.prepare(failureRowsSql).all() as Array<Record<string, unknown>>;
    const boundedRetentions = new Map([
      ["cron-direct-delivery:v1:canonical", boundedRetention],
      ["cron-direct-delivery:v1:failure", boundedRetention],
      ["cron-direct-delivery:v1:terminal", boundedRetention],
      ["upgrade-bounded:v1:pending-completion-retention", pendingBoundedRetention],
      ["unsafe-timestamp:bounded", unsafeTimestampRetention],
      ["backfill-cap:new", backfillCapRetention],
    ]);
    const retryCounts = new Map<string, number>([
      ["claimed-session-failure", 1],
      ["cron-direct-delivery:v1:canonical", 3],
      ["cron-direct-delivery:v1:failure", 4],
      ["cron-direct-delivery:v1:terminal", 5],
      ["delivery-completion", 9],
      ["terminal-permanent", 6],
      ["ambiguous-beta-failure", 2],
      ["unsafe-timestamp:bounded", 1],
    ]);
    for (const row of failureRows) {
      const id = String(row.id);
      const retryCount = retryCounts.get(id) ?? 0;
      const completionRetention = boundedRetentions.get(id) ?? "permanent";
      const recoveryState = boundedRetentions.has(id) ? "completed_bounded" : "completed_permanent";
      expect(row).toMatchObject({
        entry_kind: null,
        session_key: null,
        channel: null,
        target: null,
        account_id: null,
        retry_count: retryCount,
        last_attempt_at: null,
        last_error: null,
        recovery_state: recoveryState,
        platform_send_started_at: null,
        enqueued_at: row.failed_at,
      });
      expect(Number.isSafeInteger(row.retry_count)).toBe(true);
      expect(Number(row.retry_count)).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(String(row.entry_json))).toEqual({
        id,
        enqueuedAt: Number(row.failed_at),
        failedAt: Number(row.failed_at),
        retryCount,
        completionRetention,
        recoveryState,
      });
    }
    expect(failureRows).toHaveLength(19);
    for (const id of ["ambiguous-beta-failure", "malformed-failure", "unsafe-timestamp:bounded"]) {
      expect(failureRows.some((row) => row.id === id)).toBe(true);
    }
    const malformedRow = failureRows.find((row) => row.id === "malformed-failure");
    expect(Number(malformedRow?.failed_at)).toBeGreaterThan(0);
    expect(String(malformedRow?.entry_json)).not.toContain("private bytes");
    for (const id of [
      "legacy-none",
      "minimal-failure",
      "pending-producer-claim",
      "pending-required-claim",
      "rich-failure",
      "terminal-none",
      "backfill-cap:old",
    ]) {
      expect(failureRows.some((row) => row.id === id)).toBe(false);
    }
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);

    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    expect(reopened.db.prepare(failureRowsSql).all()).toEqual(failureRows);
    expect(getDeliveryQueueEntryStatus("outbound", "unsafe-timestamp:bounded", stateDir)).toBe(
      "failed",
    );
    expect(
      (await countFailedDeliveryQueueEntries(stateDir)).some(
        ({ queueName, count }) => queueName === "outbound" && count > 0,
      ),
    ).toBe(true);
  });

  it("reopens a canonical current schema while another connection holds the writer lock", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = openOpenClawStateDatabase(options).path;
    seedDeliveryQueueEntry({
      queueName: "outbound",
      entry: {
        id: "pending-telegram-delivery",
        enqueuedAt: 1,
        retryCount: 0,
      },
      metadata: { channel: "telegram", target: "chat-1" },
      stateDir,
    });
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(databasePath);
    writer.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
    try {
      expect(runWithOpenClawStateBusyTimeout((database) => database.db.isOpen, options, 0)).toBe(
        true,
      );
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
    }
  });

  it("configures the busy timeout before a doctor schema repair transaction", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const originalExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
      | ((this: import("node:sqlite").DatabaseSync, sql: string) => void)
      | undefined;
    if (!originalExec) {
      throw new Error("DatabaseSync.exec descriptor is unavailable");
    }
    const statements: string[] = [];
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: import("node:sqlite").DatabaseSync,
      sql: string,
    ) {
      statements.push(sql);
      return originalExec.call(this, sql);
    });

    expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);

    const timeoutIndex = statements.findIndex((sql) =>
      sql.includes(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}`),
    );
    const transactionIndex = statements.indexOf("BEGIN IMMEDIATE");
    expect(timeoutIndex).toBeGreaterThanOrEqual(0);
    expect(transactionIndex).toBeGreaterThan(timeoutIndex);
  });

  it("latches newer global schema failures before integrity scans", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = openOpenClawStateDatabase(options).path;
    closeOpenClawStateDatabaseForTest();
    createUnsafeIndexDrift(databasePath);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    db.close();

    let firstFailure: unknown;
    try {
      openOpenClawStateDatabase(options);
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toMatchObject({
      name: "SqliteSchemaVersionError",
      message: expect.stringContaining("https://docs.openclaw.ai/reference/database-schemas"),
    });

    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      fs.rmSync(candidate, { force: true });
    }
    let secondFailure: unknown;
    try {
      openOpenClawStateDatabase(options);
    } catch (error) {
      secondFailure = error;
    }
    expect(secondFailure).toBe(firstFailure);

    clearOpenClawStateDatabaseOpenFailure(databasePath);
    expect(openOpenClawStateDatabase(options).db.isOpen).toBe(true);
  });

  it("keys explicit relative paths by resolved database pathname", () => {
    const moduleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase);
    const output = execFileSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(moduleUrl).slice(0, -1),
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          import os from "node:os";
          import path from "node:path";
          import {
            closeOpenClawStateDatabaseForTest,
            openOpenClawStateDatabase,
          } from ${JSON.stringify(moduleUrl.href)};

          const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-db-relative-"));
          const firstDir = path.join(root, "first");
          const secondDir = path.join(root, "second");
          fs.mkdirSync(firstDir);
          fs.mkdirSync(secondDir);
          const previousCwd = process.cwd();
          try {
            process.chdir(firstDir);
            const firstPath = path.resolve("state.sqlite");
            const first = openOpenClawStateDatabase({ path: "state.sqlite" });
            first.db
              .prepare("INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at) VALUES (?, ?, ?, ?)")
              .run("relative-path", "first", "{}", 1);

            process.chdir(secondDir);
            const secondPath = path.resolve("state.sqlite");
            const second = openOpenClawStateDatabase({ path: "state.sqlite" });
            second.db
              .prepare("INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at) VALUES (?, ?, ?, ?)")
              .run("relative-path", "second", "{}", 2);

            console.log(JSON.stringify({
              sameHandle: first === second,
              firstPath,
              secondPath,
              firstFileExists: fs.existsSync(path.join(firstDir, "state.sqlite")),
              secondFileExists: fs.existsSync(path.join(secondDir, "state.sqlite")),
              firstRows: first.db.prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?").all("relative-path"),
              secondRows: second.db.prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?").all("relative-path"),
            }));
          } finally {
            process.chdir(previousCwd);
            closeOpenClawStateDatabaseForTest();
          }
        `,
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output) as {
      firstFileExists: boolean;
      firstRows: Array<{ event_key: string }>;
      sameHandle: boolean;
      secondFileExists: boolean;
      secondRows: Array<{ event_key: string }>;
    };

    expect(result.sameHandle).toBe(false);
    expect(result.firstFileExists).toBe(true);
    expect(result.secondFileExists).toBe(true);
    expect(result.firstRows).toEqual([{ event_key: "first" }]);
    expect(result.secondRows).toEqual([{ event_key: "second" }]);
  });

  it("uses savepoints for nested write transaction rollback", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    runOpenClawStateWriteTransaction((database) => {
      const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        stateDb.insertInto("diagnostic_events").values({
          scope: "transaction-test",
          event_key: "outer",
          payload_json: "{}",
          created_at: 1,
        }),
      );
      expect(() =>
        runOpenClawStateWriteTransaction((inner) => {
          const innerDb = getNodeSqliteKysely<StateDbTestDatabase>(inner.db);
          executeSqliteQuerySync(
            inner.db,
            innerDb.insertInto("diagnostic_events").values({
              scope: "transaction-test",
              event_key: "inner",
              payload_json: "{}",
              created_at: 2,
            }),
          );
          throw new Error("rollback nested");
        }, options),
      ).toThrow("rollback nested");
    }, options);

    const database = openOpenClawStateDatabase(options);
    const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
    expect(
      executeSqliteQuerySync(
        database.db,
        stateDb
          .selectFrom("diagnostic_events")
          .select("event_key")
          .where("scope", "=", "transaction-test")
          .orderBy("event_key"),
      ).rows.map((row) => row.event_key),
    ).toEqual(["outer"]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
