import { deepStrictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
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
import { OLDER_OPERATOR_APPROVAL_SCHEMA_SQL } from "../gateway/operator-approval-store.older-reader.test-support.js";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import { bindFreshClientCredentialStore } from "../infra/client-credential-migration.js";
import {
  countFailedDeliveryQueueEntries,
  terminalizePendingDeliveryQueueEntry,
} from "../infra/delivery-queue-sqlite.js";
import {
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntry,
} from "../infra/delivery-queue-sqlite.test-support.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { SqlConnection } from "../infra/sql-connection.js";
import { readStableSqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readConfigMachineStateWithMetadata } from "../test-utils/config-machine-state.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { readRetainedAgentDeletionsFromDatabase } from "./agent-deletion-journal.read.js";
import { readConfigMachineState } from "./config-machine-state.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { listOpenClawRegisteredAgentDatabases } from "./openclaw-agent-db-registry.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import { snapshotPreflightSourceManifest } from "./openclaw-database-preflight.test-support.js";
import { seedOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.test-support.js";
import { recordOpenClawStateDatabaseOpenFailure } from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  createCorruptionRefusalStateDatabaseFixture,
  createDanglingSkillWorkshopReviewIndex,
  readDanglingSkillWorkshopReviewIndex,
} from "./openclaw-state-db-corruption.test-support.js";
import { hasDanglingSkillWorkshopCollectionReviewIndex } from "./openclaw-state-db-doctor-schema.js";
import {
  markStateDatabaseVersion,
  materializeV2026_7_1_2StateDatabase,
} from "./openclaw-state-db-historical-fixtures.test-support.js";
import { runHotRollbackJournalRecoveryProbe } from "./openclaw-state-db-hot-journal.test-support.js";
import { prepareStateDatabaseSchemaRepair } from "./openclaw-state-db-maintenance.js";
import { ensureGitHubPublicationSchema } from "./openclaw-state-db-schema-additive.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseReadabilityForDoctor,
  repairOpenClawStateDatabaseSchema,
  prepareOpenClawStateDatabaseSchema,
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
  addPreCutoverClientCredentialTablesForTest,
  createInitialStateSchemaShape,
  withStateMigrationBackupForTest,
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
let shippedStateDatabasePath: string;
const materializeCorruptionRefusalStateDatabase = createCorruptionRefusalStateDatabaseFixture(() =>
  materializeCurrentStateDatabase(createTempStateDir()),
);

const V2026_7_1_2_STATE_FIXTURE_GZIP_SHA256 =
  "c775499d9a46462ae2368090a0c4ec75877784c40694046dd3af63df77b8737c";
const V2026_7_1_2_STATE_FIXTURE_RAW_SHA256 =
  "8511bb91f02d104f818c70b08397a678045d04741c931b0ee7ce6650b5519e85";

function insertRow(database: SqlConnection, table: string, values: Record<string, SQLInputValue>) {
  const columns = Object.keys(values)
    .map((column) => `"${column}"`)
    .join(", ");
  const placeholders = Object.keys(values)
    .map(() => "?")
    .join(", ");
  return database
    .prepare(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`)
    .run(...Object.values(values));
}

function expectRow(database: SqlConnection, sql: string, ...parameters: SQLInputValue[]) {
  return expect(database.prepare(sql).get(...parameters));
}

function expectRows(database: SqlConnection, sql: string, ...parameters: SQLInputValue[]) {
  return expect(database.prepare(sql).all(...parameters));
}

function expectRecord(
  database: SqlConnection,
  from: string,
  expected: Record<string, unknown>,
  ...parameters: SQLInputValue[]
) {
  const columns = Object.keys(expected).join(", ");
  expectRow(database, `SELECT ${columns} FROM ${from}`, ...parameters).toEqual(expected);
}

function expectRecords(
  database: SqlConnection,
  from: string,
  expected: [Record<string, unknown>, ...Record<string, unknown>[]],
  ...parameters: SQLInputValue[]
) {
  const columns = Object.keys(expected[0]).join(", ");
  expectRows(database, `SELECT ${columns} FROM ${from}`, ...parameters).toEqual(expected);
}

function openNativeDatabase(pathname: string, options: { readOnly?: boolean } = {}): DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(pathname, options);
}

function withDatabase<T>(
  pathname: string,
  run: (database: DatabaseSync) => T,
  options?: { readOnly?: boolean },
): T {
  const database = openNativeDatabase(pathname, options);
  try {
    return run(database);
  } finally {
    database.close();
  }
}

function withReadOnlyDatabase(pathname: string, read: (database: DatabaseSync) => void) {
  withDatabase(pathname, read, { readOnly: true });
}

async function expectRepair(
  options: NonNullable<Parameters<typeof repairOpenClawStateDatabaseSchema>[0]>,
  changes: unknown[],
  warnings: unknown[] = [],
) {
  expect(
    await withStateMigrationBackupForTest(options, () =>
      repairOpenClawStateDatabaseSchema(options),
    ),
  ).toEqual({ changes, warnings });
}

function expectMigrations(
  options: Parameters<typeof detectOpenClawStateDatabaseSchemaMigrations>[0],
  pathname: string,
) {
  const migrations = detectOpenClawStateDatabaseSchemaMigrations(options);
  return {
    exactly: (...kinds: string[]) =>
      expect(migrations).toEqual(kinds.map((kind) => ({ kind, path: pathname }))),
    contains: (kind: string) => expect(migrations).toContainEqual({ kind, path: pathname }),
    excludes: (kind: string) => expect(migrations).not.toContainEqual({ kind, path: pathname }),
  };
}

function expectAbsent(database: SqlConnection, ...names: string[]) {
  for (const name of names) {
    expectRow(database, "SELECT name FROM sqlite_schema WHERE name = ?", name).toBeUndefined();
  }
}

function recoveryArtifacts(databasePath: string) {
  return fs
    .readdirSync(path.dirname(databasePath))
    .filter((name) => name.startsWith("openclaw-task-delivery-recovery-"));
}

function expectIntegrity(database: SqlConnection) {
  expectRow(database, "PRAGMA integrity_check").toEqual({ integrity_check: "ok" });
}

function expectCurrentStateVersion(database: DatabaseSync) {
  expect(readSqliteNumberPragma(database, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
  expectRecord(database, "schema_meta WHERE meta_key = 'primary'", {
    schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
}

function createStateFixture(
  seed?: (database: DatabaseSync) => void,
  materialize = materializeCurrentStateDatabase,
) {
  const stateDir = createTempStateDir();
  const databasePath = materialize(stateDir);
  if (seed) {
    withDatabase(databasePath, seed);
  }
  return {
    stateDir,
    options: { env: { OPENCLAW_STATE_DIR: stateDir } },
    databasePath,
  };
}

function createTempStateDir(): string {
  return makeTempDir(stateDbTempDirs, "openclaw-state-db-");
}

function captureFailure(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}

function expectStateSchemaMigrationRequired(
  run: () => unknown,
  expected: {
    kind: OpenClawStateDatabaseSchemaMigrationRequiredError["kind"];
    pathname: string;
  },
): void {
  const caught = captureFailure(run);
  expect(caught).toBeInstanceOf(OpenClawStateDatabaseSchemaMigrationRequiredError);
  expect(caught).toMatchObject(expected);
}

const LEGACY_SESSION_WATCH_SCHEMA_VERSION = 3;
const LEGACY_AMBIENT_WATCH_PREFIX = "ambient-group-watch:";

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

function installShippedTables(database: DatabaseSync, names: string[], strict = false) {
  withReadOnlyDatabase(shippedStateDatabasePath, (shipped) => {
    for (const name of names) {
      const definitions = shipped
        .prepare(
          "SELECT type, sql FROM sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type DESC, name",
        )
        .all(name);
      expect(definitions.length).toBeGreaterThan(0);
      for (const definition of definitions) {
        if (typeof definition.sql !== "string") {
          throw new Error("Missing shipped schema SQL");
        }
        database.exec(
          strict && definition.type === "table"
            ? definition.sql.replace(/\)\s*$/u, ") STRICT")
            : definition.sql,
        );
      }
    }
  });
}

function seedV6CommitmentSchema(database: DatabaseSync): void {
  installShippedTables(database, ["commitments"], true);
  database.exec(`
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

function seedLegacySessionWatchCursorSchema(stateDir: string) {
  const databasePath = materializeCurrentStateDatabase(stateDir);

  const cursor = (
    watcher: string,
    target: string,
    seen: number,
    notified: number,
    material: number,
    at: number,
    provenance = "explicit",
  ) => ({
    watcher_session_key: watcher,
    target_session_key: target,
    last_seen_sequence: seen,
    notified_sequence: notified,
    material_sequence: material,
    updated_at: at,
    provenance,
  });
  const explicit = cursor("agent:main:main", "agent:main:subagent:explicit", 3, 4, 5, 300);
  const ambient = cursor("agent:main:main", "agent:main:telegram:group:ambient", 7, 8, 9, 200);
  const bom = cursor("﻿agent:main:bom-watcher", "agent:main:telegram:group:bom", 10, 11, 12, 500);
  const corrupt = cursor("�", "agent:main:telegram:group:corrupt", 13, 14, 15, 600);
  const marker = (watcher: string) =>
    LEGACY_AMBIENT_WATCH_PREFIX + Buffer.from(watcher, "utf8").toString("hex");
  withDatabase(databasePath, (legacy) => {
    addPreCutoverClientCredentialTablesForTest(legacy);
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
    for (const { provenance: _provenance, ...row } of [
      explicit,
      ambient,
      bom,
      corrupt,
      cursor(marker(ambient.watcher_session_key), ambient.target_session_key, 7, 7, 7, 400),
      cursor(marker(bom.watcher_session_key), bom.target_session_key, 10, 10, 10, 800),
      cursor(LEGACY_AMBIENT_WATCH_PREFIX + "ff", corrupt.target_session_key, 13, 13, 13, 900),
      cursor(marker("agent:main:orphan"), "agent:main:telegram:group:orphan", 1, 1, 1, 100),
      cursor(LEGACY_AMBIENT_WATCH_PREFIX + "not-hex", ambient.target_session_key, 1, 1, 1, 100),
    ]) {
      insertRow(legacy, "session_watch_cursors", row);
    }
  });
  return {
    databasePath,
    expected: [
      explicit,
      { ...ambient, provenance: "ambient-group", updated_at: 400 },
      { ...bom, provenance: "ambient-group", updated_at: 800 },
      corrupt,
    ] satisfies [typeof explicit, ...(typeof explicit)[]],
  };
}

function createLegacyAuditStateDatabase(stateDir: string): string {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  withDatabase(databasePath, (db) => {
    addPreCutoverClientCredentialTablesForTest(db);
    installShippedTables(db, ["schema_meta", "audit_events"]);
    db.exec(`
      PRAGMA user_version = 1;
      INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
        VALUES ('primary', 'global', 1, 10, 10);
      INSERT INTO audit_events (
        sequence, event_id, source_id, source_sequence, occurred_at, kind,
        action, status, actor_type, actor_id, agent_id, run_id
      ) VALUES (
        7, 'event-legacy', 'run-legacy:1:100:agent.run.started', 1, 100, 'agent_run',
        'agent.run.started', 'started', 'agent', 'main', 'main', 'run-legacy'
      );
      UPDATE sqlite_sequence SET seq = 40 WHERE name = 'audit_events';
    `);
  });
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
  const { DatabaseSync } = requireNodeSqlite();
  using database = new DatabaseSync(databasePath);
  runSqliteImmediateTransactionSync(database, () =>
    bindFreshClientCredentialStore(database, {
      path: databasePath,
      env: { OPENCLAW_STATE_DIR: stateDir },
    }),
  );
  return databasePath;
}

function downgradeWorkerPlacementsToV7(db: DatabaseSync): void {
  addPreCutoverClientCredentialTablesForTest(db);
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
  return openNativeDatabase(databasePath);
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
  insertRow(db, "audit_events", {
    sequence,
    event_id: eventId,
    source_id: sourceId,
    source_sequence: sequence,
    occurred_at: 100,
    kind: "message",
    action: "message.inbound.processed",
    status: "succeeded",
    actor_type: "system",
    actor_id: "gateway",
  });
}

function seedLegacyCronJob(
  database: DatabaseSync,
  storeKey: string,
  job: Pick<
    CronStoredJob,
    "id" | "name" | "createdAtMs" | "updatedAtMs" | "sessionTarget" | "wakeMode"
  > & { payload: Pick<CronStoredJob["payload"], "kind"> },
  fields: Record<string, SQLInputValue> = {},
) {
  insertRow(database, "cron_jobs", {
    store_key: storeKey,
    job_id: job.id,
    name: job.name,
    enabled: 1,
    created_at_ms: job.createdAtMs,
    updated_at: job.updatedAtMs,
    schedule_kind: "every",
    every_ms: 60_000,
    session_target: job.sessionTarget,
    wake_mode: job.wakeMode,
    payload_kind: job.payload.kind,
    job_json: JSON.stringify(job),
    state_json: "{}",
    sort_order: 0,
    ...fields,
  });
}

function insertTaskRunProbe(database: DatabaseSync, taskId: string): void {
  insertRow(database, "task_runs", {
    task_id: taskId,
    runtime: "subagent",
    owner_key: "owner",
    scope_kind: "session",
    task: "sqlite read probe",
    status: "running",
    delivery_status: "pending",
    notify_policy: "summary",
    created_at: 1,
  });
}

beforeAll(() => {
  shippedStateDatabasePath = materializeV2026_7_1_2StateDatabase(createTempStateDir()).databasePath;
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
  it("requires Doctor to repair the dangling Workshop review index in schema v16", async () => {
    const { options, databasePath } = createStateFixture((database) => {
      addPreCutoverClientCredentialTablesForTest(database);
      database.exec(
        "CREATE TABLE skill_workshop_collection_reviews (review_id TEXT NOT NULL PRIMARY KEY, owner_agent_id TEXT NOT NULL, backup_id TEXT NOT NULL, create_time INTEGER NOT NULL, kept_names_json TEXT NOT NULL, written_names_json TEXT NOT NULL, dropped_json TEXT NOT NULL) STRICT;",
      );
      insertRow(database, "skill_workshop_collection_reviews", {
        review_id: "review-preserved",
        owner_agent_id: "main",
        backup_id: "backup-preserved",
        create_time: 1,
        kept_names_json: "[]",
        written_names_json: "[]",
        dropped_json: "[]",
      });
      removePreparedWorkerOwnershipColumns(database);
      database.exec(`
        PRAGMA user_version = 16;
        UPDATE schema_meta SET schema_version = 16 WHERE meta_key = 'primary';
      `);
    });
    const rootpage = createDanglingSkillWorkshopReviewIndex(databasePath);
    const defensiveProbe = openNativeDatabase(databasePath);
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

    expect(
      await withStateMigrationBackupForTest(options, () =>
        repairOpenClawStateDatabaseSchema(options),
      ),
    ).toEqual({
      changes: expect.arrayContaining([
        "Removed dangling legacy Skill Workshop review index",
        "Recorded prepared worker ownership and one-use lifecycle (v17)",
      ]),
      warnings: [],
    });

    withReadOnlyDatabase(databasePath, (repaired) => {
      expectRecord(
        repaired,
        "skill_workshop_collection_reviews WHERE review_id = 'review-preserved'",
        { review_id: "review-preserved", backup_id: "backup-preserved" },
      );
      expectRows(repaired, "PRAGMA integrity_check").toEqual([{ integrity_check: "ok" }]);
      expectCurrentStateVersion(repaired);
      expect(readDanglingSkillWorkshopReviewIndex(databasePath)).toBeUndefined();
    });
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
        withDatabase(sourcePath, (writer) => {
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
        });
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
        seedOpenClawDatabaseQuarantine({
          env: options.env,
          kind: "state",
          path: databasePath,
          reason,
          generation,
        });
      } else {
        const error = new Error(reason);
        error.name = "SqliteIntegrityError";
        recordOpenClawStateDatabaseOpenFailure(databasePath, error);
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
    withDatabase(databasePath, (database) => {
      database.exec("UPDATE schema_meta SET role = 'agent' WHERE meta_key = 'primary';");
    });
    const rootpage = createDanglingSkillWorkshopReviewIndex(databasePath);
    const before = fs.readFileSync(databasePath);

    expect(repairOpenClawStateDatabaseReadabilityForDoctor(options)).toEqual({
      changes: [],
      warnings: [expect.stringMatching(/schema role agent; expected global/)],
    });
    deepStrictEqual(fs.readFileSync(databasePath), before);
    expect(readDanglingSkillWorkshopReviewIndex(databasePath)).toMatchObject({ rootpage });
  });

  it("rolls back dangling Workshop index reclamation and converges on retry", async () => {
    const { options, databasePath } = createStateFixture();
    const rootpage = createDanglingSkillWorkshopReviewIndex(databasePath);
    const database = openNativeDatabase(databasePath);
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
    await expectRepair(options, ["Removed dangling legacy Skill Workshop review index"]);
    expect(readDanglingSkillWorkshopReviewIndex(databasePath)).toBeUndefined();
  });

  it("migrates v7 worker placement claims and missing terminal columns without losing rows", async () => {
    const { options, databasePath } = createStateFixture((legacy) => {
      insertRow(legacy, "worker_session_placements", {
        session_id: "legacy-session",
        agent_id: "main",
        session_key: "agent:main:legacy",
        state: "local",
        transition_generation: 3,
        created_at_ms: 1,
        updated_at_ms: 2,
        state_changed_at_ms: 2,
      });
      downgradeWorkerPlacementsToV7(legacy);
      legacy.exec(`
      ALTER TABLE worker_session_placements DROP COLUMN terminal_at_ms;
      ALTER TABLE worker_session_placements DROP COLUMN terminal_reason;
    `);
    });

    expectMigrations(options, databasePath).contains("worker-placement-execution-mode-v8");

    await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
    const migrated = openOpenClawStateDatabase(options);
    expectCurrentStateVersion(requireNativeSqliteDatabase(migrated.db));
    expectRecord(migrated.db, "worker_session_placements", {
      session_id: "legacy-session",
      transition_generation: 3,
      execution_mode: null,
    });
    const columns = migrated.db.prepare("PRAGMA table_info(worker_session_placements)").all();
    expect(columns.map((column) => column.name).slice(-2)).toEqual([
      "terminal_reason",
      "terminal_at_ms",
    ]);
    expectMigrations(options, databasePath).excludes("worker-placement-execution-mode-v8");
  });

  it.each([OPENCLAW_AGENT_SCHEMA_VERSION])(
    "migrates v8 agent database registrations to state-relative paths (agent schema %s)",
    async (agentSchemaVersion) => {
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
      addPreCutoverClientCredentialTablesForTest(legacy);
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
      expect(
        await withStateMigrationBackupForTest({ env }, () =>
          repairOpenClawStateDatabaseSchema({ env }),
        ),
      ).toEqual({
        changes: [
          "Migrated agent database registry paths to state-relative storage (2 relativized, 1 re-anchored, 1 removed)",
          `Re-anchored agent database registry path ${copiedForeignPath} to the current state directory`,
          `Removed duplicate agent database registry path ${dualForeignPath}`,
          "Qualified historical cron creator attribution as unknown (v14)",
          "Replaced retained task indexes with ordered cron history indexes (v24)",
          "Removed redundant replay and skill indexes and narrowed the lease-owner index (v27)",
        ],
        warnings: [],
      });
      const migrated = openOpenClawStateDatabase({ env });
      expectCurrentStateVersion(requireNativeSqliteDatabase(migrated.db));
      expectRows(
        migrated.db,
        "SELECT agent_id, path FROM agent_databases ORDER BY agent_id",
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
      expectRows(migrated.db, "SELECT DISTINCT schema_version FROM agent_databases").toEqual([
        { schema_version: agentSchemaVersion },
      ]);
      expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual(
        agentSchemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION ? expected : [],
      );
      expect(
        listOpenClawRegisteredAgentDatabases({ env, includeIncompatibleSchemaVersions: true }),
      ).toEqual(expected);
    },
  );

  it("retires v10 skill curator projections through runtime open while preserving live skill usage and proposal provenance", async () => {
    const { options, databasePath } = createStateFixture((legacy) => {
      addPreCutoverClientCredentialTablesForTest(legacy);
      legacy.exec(STATE_SCHEMA_12_TO_11_DOWNGRADE_SQL);
      legacy.exec(STATE_SCHEMA_11_TO_10_TABLES_SQL);
      legacy.exec(`
        CREATE TABLE skill_workshop_proposals (
          proposal_id TEXT NOT NULL PRIMARY KEY,
          record_json TEXT NOT NULL,
          owner_agent_id TEXT,
          workspace_dir TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          draft_hash TEXT NOT NULL,
          claim_released_time INTEGER
        ) STRICT;
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
    });

    expectMigrations(options, databasePath).contains("state-table-retirement-v11");
    expectMigrations(options, databasePath).contains("singleton-state-foldin-v12");

    await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
    const migrated = openOpenClawStateDatabase(options);
    expectCurrentStateVersion(requireNativeSqliteDatabase(migrated.db));
    expectAbsent(
      migrated.db,
      "skill_lifecycle",
      "idx_skill_lifecycle_key",
      "idx_skill_lifecycle_state",
      "skill_workshop_proposal_origin_runs",
      "skill_curator_state",
    );
    expectRecord(migrated.db, "skill_usage", {
      skill_file: "/skills/archived/SKILL.md",
      use_count: 4,
    });
    expect(readConfigMachineState("skills.curatorState", options)).toBeUndefined();
    expectRecord(
      migrated.db,
      "skill_workshop_proposals WHERE proposal_id = ?",
      { record_json: '{"originRunIds":["run-retired"]}' },
      "proposal-retired",
    );
  });

  it("folds v11 singleton state into machine-state keys through doctor repair", async () => {
    const { options, databasePath } = createStateFixture((legacy) => {
      addPreCutoverClientCredentialTablesForTest(legacy);
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
    });

    expectMigrations(options, databasePath).contains("singleton-state-foldin-v12");

    await expectRepair(options, [
      "Folded singleton state tables into config_machine_state (v12)",
      "Qualified historical cron creator attribution as unknown (v14)",
      "Replaced retained task indexes with ordered cron history indexes (v24)",
      "Removed redundant replay and skill indexes and narrowed the lease-owner index (v27)",
    ]);

    const migrated = openOpenClawStateDatabase(options);
    expectCurrentStateVersion(requireNativeSqliteDatabase(migrated.db));
    expectAbsent(migrated.db, ...FOLDED_STATE_TABLES_V12);
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
    expectMigrations(options, databasePath).excludes("singleton-state-foldin-v12");
  });

  it("migrates legacy wide rows through Doctor without path aliases while preserving store provenance and hydrated jobs", async () => {
    const { stateDir, options, databasePath } = createStateFixture();
    const legacy = openNativeDatabase(databasePath);
    addPreCutoverClientCredentialTablesForTest(legacy);
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
    } as const;
    const storeKey = path.join(stateDir, "cron", "jobs.json");
    seedLegacyCronJob(legacy, storeKey, job, {
      payload_message: job.payload.message,
      declaration_key: "legacy-declaration",
      owner_agent_id: "legacy-owner",
      description: job.description,
      agent_id: job.agentId,
      state_json: JSON.stringify({ lastStatus: "error" }),
      runtime_updated_at_ms: job.updatedAtMs,
      schedule_identity: "every:60000",
      sort_order: 4,
      delivery_mode: job.delivery.mode,
      delivery_channel: job.delivery.channel,
      failure_delivery_mode: "announce",
      failure_delivery_channel: "discord",
      failure_delivery_to: "https://example.invalid/failure",
      failure_delivery_account_id: "",
      last_run_status: "ok",
    });
    const authoritySchemaStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
      "CREATE TABLE IF NOT EXISTS cron_job_runtime_authorities (",
    );
    const authoritySchemaEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
      "\n) STRICT;",
      authoritySchemaStart,
    );
    legacy.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(authoritySchemaStart, authoritySchemaEnd + 10));
    const authority = {
      store_key: storeKey,
      job_id: job.id,
      authority_json: '{"owner":"preserved"}',
      authority_input_fingerprint: "preserved-fingerprint",
      recovery_required: 0,
    };
    insertRow(legacy, "cron_job_runtime_authorities", authority);
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
    const workspaceSetup = {
      workspace_key: "wk-setup",
      workspace_path: "/tmp/wk-setup",
      version: 1,
      bootstrap_seeded_at: "2026-07-15T10:00:00.000Z",
      setup_completed_at: "2026-07-15T10:01:00.000Z",
      updated_at: 500,
    };
    insertRow(legacy, "workspace_setup_state", workspaceSetup);
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
    insertRow(legacy, "auth_profile_state", {
      store_key: "shared",
      state_json: sharedStateJson,
      updated_at: 92,
    });
    legacy.close();

    expectMigrations(options, databasePath).contains("state-consolidation-v13");

    await expectRepair(options, [
      "Migrated cloud worker placements to execution modes",
      "Migrated shared state session watch cursors → provenance column (0 ambient, 0 sentinels removed)",
      "Consolidated shared state tables (v13)",
      "Qualified historical cron creator attribution as unknown (v14)",
      "Replaced retained task indexes with ordered cron history indexes (v24)",
      "Removed redundant replay and skill indexes and narrowed the lease-owner index (v27)",
    ]);

    const migrated = openOpenClawStateDatabase(options);
    expectCurrentStateVersion(requireNativeSqliteDatabase(migrated.db));
    expect(
      collectSqliteSchemaShape(requireNativeSqliteDatabase(migrated.db))
        .gateway_origin_device_tokens,
    ).toBeUndefined();
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
    expectRecords(
      migrated.db,
      "sqlite_master WHERE type = 'index' AND name IN ( 'idx_cron_jobs_store_updated', 'idx_cron_jobs_enabled_next_run', 'idx_cron_jobs_store_order' ) ORDER BY name",
      [{ name: "idx_cron_jobs_store_order" }],
    );
    expectRecord(
      migrated.db,
      "cron_jobs WHERE job_id = ?",
      {
        declaration_key: "legacy-declaration",
        owner_agent_id: "legacy-owner",
        agent_id: "legacy-agent",
        payload_kind: "agentTurn",
        runtime_updated_at_ms: 250,
        schedule_identity: "every:60000",
        sort_order: 4,
      },
      job.id,
    );
    const row = migrated.db
      .prepare("SELECT job_json, state_json FROM cron_jobs WHERE job_id = ?")
      .get(job.id) as { job_json: string; state_json: string };
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
    expectRecord(migrated.db, "cron_job_runtime_authorities WHERE job_id = ?", authority, job.id);
    expectRow(
      migrated.db,
      "SELECT * FROM subagent_runs WHERE run_id = ?",
      runPayload.runId,
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
    const orphanWorkspace = (key: string, at: number) => ({
      workspace_key: key,
      workspace_path: null,
      version: null,
      bootstrap_seeded_at: null,
      setup_completed_at: null,
      updated_at: null,
      attested_at_ms: at,
      attestation_updated_at_ms: at + 100,
    });
    expectRecords(migrated.db, "workspace_setup_state ORDER BY workspace_key", [
      orphanWorkspace("wk-alias", 2_000),
      orphanWorkspace("wk-orphan", 3_000),
      { ...workspaceSetup, attested_at_ms: 1_000, attestation_updated_at_ms: 1_100 },
    ]);
    expectRecords(migrated.db, "workspace_generated_bootstrap_hashes ORDER BY workspace_key", [
      { workspace_key: "wk-alias", filename: "TOOLS.md", sha256: "b".repeat(64) },
      { workspace_key: "wk-orphan", filename: "USER.md", sha256: "c".repeat(64) },
      { workspace_key: "wk-setup", filename: "AGENTS.md", sha256: "a".repeat(64) },
    ]);
    expectRows(
      migrated.db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_attestations'",
    ).toEqual([]);
    expectRecord(migrated.db, "config_machine_state WHERE state_key = 'authProfiles.store'", {
      value_json: sharedStoreJson,
      updated_at_ms: 91,
    });
    expectRecord(migrated.db, "config_machine_state WHERE state_key = 'authProfiles.state'", {
      value_json: sharedStateJson,
      updated_at_ms: 92,
    });
    expectRows(
      migrated.db,
      `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name IN ('auth_profile_stores', 'auth_profile_state')`,
    ).toEqual([]);
    expectRows(migrated.db, "PRAGMA foreign_key_check").toEqual([]);
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
  });

  it("preserves cron delivery when recovering v12 enabled state through runtime open", async () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const legacy = openMaterializedCurrentStateDatabase(stateDir);
    addPreCutoverClientCredentialTablesForTest(legacy);
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
    for (const [index, job] of jobs.entries()) {
      const { enabled, state, ...legacyJob } = job;
      seedLegacyCronJob(legacy, storeKey, legacyJob, {
        payload_message: "tick",
        enabled: Number(enabled),
        job_json: JSON.stringify(legacyJob),
        state_json: JSON.stringify(state),
        sort_order: index,
      });
    }
    legacy.close();

    await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
    const migrated = openOpenClawStateDatabase(options);
    const loaded = loadedCronStoreFromRows(loadCronRows(migrated.db, storeKey)).store.jobs;
    expect(loaded).toEqual(jobs);
    for (const job of loaded) {
      expect(resolveCronDeliveryPlan(job)).toMatchObject({ mode: "none", requested: false });
    }
  });

  it("preserves malformed cron JSON for quarantine through the v13 doctor repair", async () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const legacy = openMaterializedCurrentStateDatabase(stateDir);
    addPreCutoverClientCredentialTablesForTest(legacy);
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

    expect(
      (
        await withStateMigrationBackupForTest(options, () =>
          repairOpenClawStateDatabaseSchema(options),
        )
      ).changes,
    ).toContain("Consolidated shared state tables (v13)");

    const migrated = openOpenClawStateDatabase(options);
    expectRecords(migrated.db, "cron_jobs ORDER BY sort_order, job_id", [
      { job_id: "malformed-job", job_json: "{", state_json: "{}" },
      { job_id: "malformed-state", job_json: '{"id":"malformed-state"}', state_json: "[]" },
    ]);
    expectIntegrity(migrated.db);
    expectRows(migrated.db, "PRAGMA foreign_key_check").toEqual([]);
    closeOpenClawStateDatabaseForTest();
    expectRow(
      openOpenClawStateDatabase(options).db,
      "SELECT COUNT(*) AS count FROM cron_jobs",
    ).toEqual({ count: 2 });
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
  });

  it("logs a destructive retirement only after the schema transaction commits", async () => {
    const { options, databasePath } = createStateFixture((legacy) => {
      seedV6CommitmentSchema(legacy);
      legacy.exec(`
      CREATE TRIGGER fail_schema_meta_update
      BEFORE UPDATE ON schema_meta
      BEGIN
        SELECT RAISE(ABORT, 'forced migration rollback');
      END;
    `);
    });

    await expect(
      withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
    ).rejects.toThrow(/forced migration rollback/);
    expect(stateDbLogInfo).not.toHaveBeenCalledWith(
      "Discarded retired shared-state commitments rows, table, and indexes",
    );
    withReadOnlyDatabase(databasePath, (rolledBack) => {
      expectRecord(rolledBack, "sqlite_schema WHERE name = 'commitments'", {
        name: "commitments",
      });
    });
  });

  it("retires the supported early commitments layout through doctor repair", async () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeV2026_7_1_2StateDatabase(stateDir).databasePath;
    const early = openNativeDatabase(databasePath);
    early.exec("DROP TABLE commitments");
    seedEarlyCommitmentSchema(early);
    early.close();

    const result = await withStateMigrationBackupForTest(options, () =>
      repairOpenClawStateDatabaseSchema(options),
    );
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Discarded retired shared-state commitments rows, table, and indexes",
    );

    const migrated = openOpenClawStateDatabase(options);
    expectCurrentStateVersion(requireNativeSqliteDatabase(migrated.db));
    expectAbsent(migrated.db, "commitments");
  });

  it("migrates the exact v2026.7.1-2 shared state database through Doctor", async () => {
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
      { kind: "predicate-columns-v21", path: fixture.databasePath },
      { kind: "portable-identity-columns-v22", path: fixture.databasePath },
      { kind: "task-run-indexes-v24", path: fixture.databasePath },
      { kind: "subagent-operator-recovery-v25", path: fixture.databasePath },
      { kind: "state-write-indexes-v27", path: fixture.databasePath },
      { kind: "github-publication-draft-v28", path: fixture.databasePath },
      { kind: "local-client-credentials-v29", path: fixture.databasePath },
      { kind: "automation-policy-fence-v30", path: fixture.databasePath },
      { kind: "audit-events-v2", path: fixture.databasePath },
      { kind: "strict-tables-v3", path: fixture.databasePath },
    ]);
    expectStateSchemaMigrationRequired(() => openOpenClawStateDatabase(options), {
      kind: "audit-events-v2",
      pathname: fixture.databasePath,
    });

    await expectRepair(options, [
      "Discarded retired shared-state commitments rows, table, and indexes",
      "Retired six dead shared-state tables (v10)",
      "Retired legacy skill curator lifecycle and proposal origin-run tables",
      "Folded singleton state tables into config_machine_state (v12)",
      "Migrated shared state audit event ledger → versioned message lifecycle schema",
      "Derived meeting transcript selectors and bounded delivery retention columns (v21)",
      "Promoted portable ACP resume keys and cursor identities (v22)",
      "Consolidated shared state tables (v13)",
      "Qualified historical cron creator attribution as unknown (v14)",
      "Removed redundant conversation binding target projections (v15)",
      "Replaced retained task indexes with ordered cron history indexes (v24)",
      "Removed redundant replay and skill indexes and narrowed the lease-owner index (v27)",
      "Migrated shared state tables to SQLite STRICT typing (46)",
    ]);
    const migrated = openOpenClawStateDatabase(options);
    const native = requireNativeSqliteDatabase(migrated.db);
    expectCurrentStateVersion(native);
    expectRows(native, "PRAGMA integrity_check").toEqual([{ integrity_check: "ok" }]);
    expectRows(migrated.db, "PRAGMA foreign_key_check").toEqual([]);
    // The shipped v2026.7.1-2 database really carried these curator projections.
    expectAbsent(migrated.db, "skill_lifecycle", "skill_workshop_proposal_origin_runs");
    // Published v1 state has no deletion history to lose; migration initializes its journal.
    const expected = createInitialStateSchemaShape();
    expect(normalizeSqliteSchemaShapeSql(collectSqliteSchemaShape(native))).toEqual(
      normalizeSqliteSchemaShapeSql(expected),
    );
    expect(readRetainedAgentDeletionsFromDatabase(migrated.db, fixture.databasePath)).toEqual({
      status: "empty",
    });
    // The fixture's auth_profile_stores row is keyed 'fixture-store', not the
    // production 'shared' key, so the v13 fold drops the table without
    // importing it into the KV.
    expectRow(
      migrated.db,
      "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'",
    ).toBeUndefined();
    expectRecord(
      migrated.db,
      "audit_events WHERE event_id = ?",
      {
        sequence: 7,
        event_id: "fixture-audit-event",
        source_id: "fixture-source",
        schema_version: 1,
        agent_id: "fixture-agent",
        run_id: "fixture-run",
      },
      "fixture-audit-event",
    );
    expect(
      insertRow(migrated.db, "audit_events", {
        event_id: "fixture-audit-next",
        source_id: "fixture-source-next",
        source_sequence: 2,
        occurred_at: 1600,
        kind: "message",
        action: "message.received",
        status: "succeeded",
        actor_type: "channel_sender",
        actor_id: "fixture-sender",
      }).lastInsertRowid,
    ).toBe(41);
    expectRecords(migrated.db, "diagnostic_events ORDER BY scope, sequence", [
      { scope: "fixture-scope", event_key: "event-a", sequence: 1 },
      { scope: "fixture-scope", event_key: "event-b", sequence: 2 },
      { scope: "other-scope", event_key: "event-c", sequence: 1 },
    ]);
    expectRecord(migrated.db, "task_runs WHERE runtime = 'cron' AND source_id = 'fixture-cron'", {
      task_id: "cron-runlog-import:fixture-cron:1500:1",
      runtime: "cron",
      source_id: "fixture-cron",
      status: "succeeded",
      ended_at: 1500,
    });
    expectRow(
      migrated.db,
      `SELECT task_runs.task_id, task_runs.status, task_delivery_state.last_notified_event_at
             FROM task_runs
             JOIN task_delivery_state USING (task_id)
            WHERE task_runs.task_id = 'fixture-task'`,
    ).toEqual({
      task_id: "fixture-task",
      status: "completed",
      last_notified_event_at: 1320,
    });
    expectRows(
      migrated.db,
      `SELECT type, name
             FROM sqlite_schema
            WHERE lower(name) LIKE '%commitment%'
            ORDER BY type, name`,
    ).toEqual([]);

    closeOpenClawStateDatabaseForTest();
    await expectRepair(options, []);
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
    const reopened = openOpenClawStateDatabase(options);
    expectRows(reopened.db, "PRAGMA integrity_check").toEqual([{ integrity_check: "ok" }]);
    expectRows(reopened.db, "PRAGMA foreign_key_check").toEqual([]);
  });

  it("refuses retirement and leaves an inbound foreign-key dependency unchanged through doctor repair", async () => {
    const { options, databasePath } = createStateFixture((dependent) => {
      seedV6CommitmentSchema(dependent);
      dependent.exec(`
        CREATE TABLE sqliteX_dependents (
          id TEXT NOT NULL PRIMARY KEY,
          commitment_id TEXT NOT NULL REFERENCES commitments(id) ON DELETE CASCADE
        ) STRICT;
        INSERT INTO sqliteX_dependents (id, commitment_id)
        VALUES ('dependent-row', 'retired-commitment');
      `);
    });

    const result = await withStateMigrationBackupForTest(options, () =>
      repairOpenClawStateDatabaseSchema(options),
    );
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/referenced by table sqliteX_dependents/iu);

    withReadOnlyDatabase(databasePath, (preserved) => {
      expect(readSqliteNumberPragma(preserved, "user_version")).toBe(6);
      expectRecords(preserved, "commitments", [{ id: "retired-commitment" }]);
      expectRecords(preserved, "sqliteX_dependents", [
        { id: "dependent-row", commitment_id: "retired-commitment" },
      ]);
    });
  });

  it.each([
    {
      name: "foreign_commitments_status",
      sql: "CREATE INDEX foreign_commitments_status ON commitments(status);",
      error: /commitments/u,
    },
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
  ])(
    "refuses retirement and preserves the unresolved dependency $name",
    async ({ name, sql, error }) => {
      const { options, databasePath } = createStateFixture((dependent) => {
        seedV6CommitmentSchema(dependent);
        dependent.exec(sql);
      });

      await expect(
        withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
      ).rejects.toThrow(error);

      withReadOnlyDatabase(databasePath, (preserved) => {
        expect(readSqliteNumberPragma(preserved, "user_version")).toBe(6);
        expectRecord(
          preserved,
          "sqlite_schema WHERE name = ?",
          {
            name,
          },
          name,
        );
        expectRecords(preserved, "commitments", [{ id: "retired-commitment" }]);
        if (name === "foreign_commitments_status") {
          expectRecord(
            preserved,
            "sqlite_schema WHERE name = ?",
            {
              type: "index",
              tbl_name: "commitments",
            },
            name,
          );
        }
      });
    },
  );

  it("skips exclusive repair when the automatic schema gate is already current", async () => {
    const { options, databasePath } = createStateFixture((before) => {
      before.prepare("UPDATE schema_meta SET updated_at = 123 WHERE meta_key = 'primary'").run();
    });

    expect(await prepareOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [],
    });

    withReadOnlyDatabase(databasePath, (after) => {
      expectRecord(after, "schema_meta WHERE meta_key = 'primary'", {
        updated_at: 123,
      });
    });
  });

  it("doctor migrates version 3 ambient watch sentinels into cursor provenance", async () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const seeded = seedLegacySessionWatchCursorSchema(stateDir);

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "creator-namespace-v14", path: seeded.databasePath },
      { kind: "predicate-columns-v21", path: seeded.databasePath },
      { kind: "portable-identity-columns-v22", path: seeded.databasePath },
      { kind: "meeting-transcript-start-time", path: seeded.databasePath },
      { kind: "task-run-indexes-v24", path: seeded.databasePath },
      { kind: "subagent-operator-recovery-v25", path: seeded.databasePath },
      { kind: "session-state-head-layout-v26", path: seeded.databasePath },
      { kind: "state-write-indexes-v27", path: seeded.databasePath },
      { kind: "github-publication-draft-v28", path: seeded.databasePath },
      { kind: "local-client-credentials-v29", path: seeded.databasePath },
      { kind: "automation-policy-fence-v30", path: seeded.databasePath },
      { kind: "session-watch-cursor-provenance-v4", path: seeded.databasePath },
    ]);
    await expectRepair(options, [
      "Migrated cloud worker placements to execution modes",
      "Migrated shared state session watch cursors → provenance column (2 ambient, 5 sentinels removed)",
      "Qualified historical cron creator attribution as unknown (v14)",
      "Replaced retained task indexes with ordered cron history indexes (v24)",
      "Removed redundant replay and skill indexes and narrowed the lease-owner index (v27)",
    ]);

    const migrated = openOpenClawStateDatabase(options);
    expectRecords(
      migrated.db,
      "session_watch_cursors ORDER BY target_session_key",
      seeded.expected,
    );
    expectCurrentStateVersion(requireNativeSqliteDatabase(migrated.db));
    closeOpenClawStateDatabaseForTest();
    await expectRepair(options, []);
  });

  it("repairs same-version Claw bootstrap columns with a missing index through its admitted path", () => {
    const { options } = createStateFixture((shippedSchema) => {
      shippedSchema.exec(`
        ALTER TABLE claw_installs DROP COLUMN bootstrap_source_path;
        ALTER TABLE claw_installs DROP COLUMN bootstrap_content_digest;
      `);

      shippedSchema.exec("DROP INDEX idx_task_runs_runtime_run;");

      expectCurrentStateVersion(shippedSchema);
    });

    const reopened = openOpenClawStateDatabase(options);
    const columns = reopened.db.prepare("PRAGMA table_info(claw_installs)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["bootstrap_source_path", "bootstrap_content_digest"]),
    );

    expect(
      normalizeSqliteSchemaShapeSql(
        collectSqliteSchemaShape(requireNativeSqliteDatabase(reopened.db)),
      ),
    ).toEqual(normalizeSqliteSchemaShapeSql(createInitialStateSchemaShape()));
  });

  it("keeps GitHub publication lazy across current-schema open, first use, and reopen", async () => {
    const { options, databasePath } = createStateFixture((previousV9) => {
      previousV9.exec(`
      DROP INDEX idx_github_publication_requests_pending;
      DROP TABLE github_publication_requests;
    `);
      expectCurrentStateVersion(previousV9);
    });

    const beforeFirstUse = await openExistingOpenClawStateDatabaseReadOnly({ path: databasePath });
    expect(
      beforeFirstUse?.db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'github_publication_requests'")
        .get(),
    ).toBeUndefined();
    beforeFirstUse?.walMaintenance.close();

    const currentSchema = openOpenClawStateDatabase(options);
    expectCurrentStateVersion(requireNativeSqliteDatabase(currentSchema.db));
    ensureGitHubPublicationSchema(currentSchema.db);
    expectRecords(
      currentSchema.db,
      "sqlite_schema WHERE name IN ('github_publication_requests', 'idx_github_publication_requests_pending') ORDER BY type DESC",
      [
        { type: "table", name: "github_publication_requests" },
        { type: "index", name: "idx_github_publication_requests_pending" },
      ],
    );
    expect(() =>
      assertSqliteSchemaContains(
        requireNativeSqliteDatabase(currentSchema.db),
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

  it.each([22, 23, OPENCLAW_STATE_SCHEMA_VERSION])(
    "rejects a missing v%i table instead of recreating it empty",
    async (version) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const drifted = openNativeDatabase(databasePath);
      drifted.exec("DROP TABLE apns_registration_tombstones;");
      markStateDatabaseVersion(drifted, version);
      const schemaBefore = hashSqliteSchema(drifted);
      drifted.close();

      await expect(
        withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
      ).rejects.toThrow(/missing table apns_registration_tombstones/iu);
      const refusal = {
        changes: [],
        warnings: [
          `Failed migrating shared state database schema at ${databasePath}: SqliteSchemaMismatchError: SQLite schema is incomplete or noncanonical for ${databasePath}: missing table apns_registration_tombstones; run openclaw doctor --fix to repair it.`,
        ],
      };
      expect(
        await withStateMigrationBackupForTest(options, () =>
          repairOpenClawStateDatabaseSchema(options),
        ),
      ).toEqual(refusal);

      withReadOnlyDatabase(databasePath, (after) => {
        expect(hashSqliteSchema(after)).toBe(schemaBefore);
        expectAbsent(after, "apns_registration_tombstones");
      });
    },
  );

  it("rejects a missing stable v5 table before migration through startup admission", async () => {
    const { stateDir, options, databasePath } = createStateFixture();

    {
      const intact = openNativeDatabase(databasePath);
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
    const damaged = openNativeDatabase(databasePath);
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

    withReadOnlyDatabase(databasePath, (after) => {
      expectAbsent(after, "apns_registration_tombstones");
      expect(readSqliteNumberPragma(after, "user_version")).toBe(5);
      expect(hashSqliteSchema(after)).toBe(schemaBefore);
      expectRows(after, "SELECT * FROM schema_meta ORDER BY meta_key").toEqual(metadataBefore);
    });
  });

  it("keeps an unrecognized agent registry schema fail-closed and nonrepairable", () => {
    const { options } = createStateFixture((malformed) => {
      malformed.exec(`
      DROP TABLE agent_databases;
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL PRIMARY KEY,
        path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `);
    });

    const caught = captureFailure(() => openOpenClawStateDatabase(options));
    expect(caught).not.toBeInstanceOf(OpenClawStateDatabaseSchemaMigrationRequiredError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("unsupported agent database registry schema");
  });

  it("refuses an audit sequence high-water mark outside the supported cursor range", async () => {
    const { options, databasePath } = createStateFixture((legacy) => {
      legacy.exec("UPDATE sqlite_sequence SET seq = 9007199254740992 WHERE name = 'audit_events';");
    }, createLegacyAuditStateDatabase);

    await expectRepair(
      options,
      [],
      [expect.stringContaining("exceeds the supported integer range")],
    );

    withReadOnlyDatabase(databasePath, (preserved) => {
      expectRow(
        preserved,
        "SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'audit_events'",
      ).toEqual({ seq: "9007199254740992" });
      expectRecord(preserved, "audit_events WHERE sequence = 7", {
        event_id: "event-legacy",
      });
    });
  });

  it("completes a recognized pre-v2 schema through runtime open before read-only consumers", async () => {
    const { options, databasePath } = createStateFixture((legacy) => {
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
    }, createLegacyAuditStateDatabase);

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "subagent-operator-recovery-v25", path: databasePath },
      { kind: "state-write-indexes-v27", path: databasePath },
      { kind: "github-publication-draft-v28", path: databasePath },
      { kind: "local-client-credentials-v29", path: databasePath },
      { kind: "automation-policy-fence-v30", path: databasePath },
    ]);

    await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
    closeOpenClawStateDatabaseForTest();

    withReadOnlyDatabase(databasePath, (repaired) => {
      assertOpenClawStateDatabaseForMaintenance(repaired, { pathname: databasePath });
      expectCurrentStateVersion(repaired);
      expectRecord(repaired, "sqlite_master WHERE type = 'table' AND name = 'audit_events'", {
        name: "audit_events",
      });
      expectRow(repaired, "SELECT * FROM workspace_setup_state").toMatchObject({
        workspace_key: "legacy-workspace",
        workspace_path: "/tmp/legacy-workspace",
        version: 1,
        bootstrap_seeded_at: "2026-06-01T00:00:00.000Z",
        updated_at: 100,
      });
    });
    expect(listOpenClawRegisteredAgentDatabases(options)).toEqual([]);
  });

  it.each([
    { ownership: "missing", auditLedger: false },
    { ownership: "foreign", auditLedger: true },
  ] as const)(
    "does not claim pre-v2 state with $ownership ownership metadata and audit ledger $auditLedger",
    async ({ ownership, auditLedger }) => {
      const stateDir = createTempStateDir();
      const databasePath = createLegacyAuditStateDatabase(stateDir);
      const legacy = openNativeDatabase(databasePath);
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
      await expectRepair(
        { env: { OPENCLAW_STATE_DIR: stateDir } },
        [],
        [
          expect.stringContaining(
            auditLedger ? "schema role agent; expected global" : "expected global",
          ),
        ],
      );
      expect(fs.readFileSync(databasePath)).toEqual(before);
      if (auditLedger) {
        withReadOnlyDatabase(databasePath, (preserved) => {
          expect(readSqliteNumberPragma(preserved, "user_version")).toBe(1);
          expectRecord(preserved, "schema_meta WHERE meta_key = 'primary'", {
            role: "agent",
            schema_version: 1,
            agent_id: "worker-1",
          });
          expectRow(
            preserved,
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'apns_registration_tombstones'",
          ).toBeUndefined();
        });
      }
    },
  );

  it("refuses a v2 audit ledger without unique source identities", async () => {
    const { options, databasePath } = createStateFixture((malformed) => {
      rebuildAuditEventsTable(malformed, (sql) =>
        sql.replace("source_id TEXT NOT NULL UNIQUE", "source_id TEXT NOT NULL"),
      );
      insertAuditMarker(malformed, "event-duplicate-source-1", "duplicate-source", 7);
      insertAuditMarker(malformed, "event-duplicate-source-2", "duplicate-source", 8);
    });
    expectMigrations(options, databasePath).exactly("audit-events-v2");
    expect(() => openOpenClawStateDatabase(options)).toThrow(/noncanonical audit event schema/);
    await expectRepair(options, [], [expect.stringContaining("cannot be repaired automatically")]);
    withReadOnlyDatabase(databasePath, (preserved) => {
      expectRow(
        preserved,
        "SELECT COUNT(*) AS count FROM audit_events WHERE source_id = 'duplicate-source'",
      ).toEqual({ count: 2 });
    });
  });

  it.each(["directory removal", "native close"] as const)(
    "retains a read-only snapshot until failed %s succeeds",
    async (failureStage) => {
      const stateDir = createTempStateDir();
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const database = await openExistingOpenClawStateDatabaseReadOnly({ path: databasePath });
      if (!database) {
        throw new Error("Expected the existing state snapshot");
      }
      const privatePath = requireNativeSqliteDatabase(database.db).location();
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
    const { databasePath } = createStateFixture();

    const futureVersion = OPENCLAW_STATE_SCHEMA_VERSION + 1;
    const source = openNativeDatabase(databasePath);
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
    insertTaskRunProbe(requireNativeSqliteDatabase(writer.db), "task-live-wal");
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

  it.each([false, true])(
    "repairs current-schema index corruption with explicit FULL or recorded failure (%s)",
    (recordedFailure) => {
      const stateDir = createTempStateDir();
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      createUnsafeIndexDrift(databasePath);

      if (recordedFailure) {
        expect(() => openOpenClawStateDatabase(options)).toThrow(
          /integrity_check failed.*missing from index unsafe_index_records_value/iu,
        );
        const checkpointCallback = vi.fn();
        expect(() =>
          withOpenClawStateStartupMigrationCheckpointDatabase(checkpointCallback, options),
        ).toThrow(/integrity_check failed.*missing from index unsafe_index_records_value/iu);
        expect(checkpointCallback).not.toHaveBeenCalled();
      }
      expect(
        repairOpenClawStateDatabaseSchema({
          ...options,
          integrityCheck: recordedFailure ? undefined : "full",
        }),
      ).toEqual({
        changes: [
          expect.stringContaining("Saved pre-repair SQLite backup:"),
          expect.stringContaining(
            "Rebuilt corrupt shared-state SQLite indexes: unsafe_index_records_value",
          ),
        ],
        warnings: [],
      });
      expectRow(openOpenClawStateDatabase(options).db, "PRAGMA integrity_check").toEqual({
        integrity_check: "ok",
      });
    },
  );

  it("preserves orphan delivery payload before Doctor recovery from 2026.7.1-2", async () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeV2026_7_1_2StateDatabase(stateDir).databasePath;
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const corrupted = openNativeDatabase(databasePath);
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
      expectIntegrity(corrupted);
      expectRows(corrupted, "PRAGMA foreign_key_check").toHaveLength(18);
      expect(fs.statSync(`${databasePath}-wal`).size).toBeGreaterThan(0);
      const failure = /foreign_key_check failed.*task_delivery_state.*references task_runs/iu;
      expect(() => openOpenClawStateDatabase(options)).toThrow(failure);
      const checkpointCallback = vi.fn();
      expect(() =>
        withOpenClawStateStartupMigrationCheckpointDatabase(checkpointCallback, options),
      ).toThrow(failure);
      expect(checkpointCallback).not.toHaveBeenCalled();

      const result = await withStateMigrationBackupForTest(options, () =>
        repairOpenClawStateDatabaseSchema(options),
      );
      expect(result.warnings).toEqual([]);
      expect(result.changes).toContainEqual(
        expect.stringContaining("Preserved and recovered 18 orphan task delivery rows"),
      );
      const recoveryDirs = recoveryArtifacts(databasePath);
      expect(recoveryDirs).toHaveLength(1);
      const recoveryDir = path.join(path.dirname(databasePath), recoveryDirs[0]!);
      const backup = openNativeDatabase(path.join(recoveryDir, "database.sqlite"), {
        readOnly: true,
      });
      try {
        expectIntegrity(backup);
        expectRows(backup, "PRAGMA foreign_key_check").toHaveLength(18);
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
      expectRows(repaired.db, "PRAGMA foreign_key_check").toEqual([]);
      expectIntegrity(repaired.db);
      expectRows(repaired.db, "SELECT task_id FROM task_delivery_state").toContainEqual({
        task_id: "healthy-task",
      });
      expectRows(
        repaired.db,
        "SELECT 1 FROM task_delivery_state WHERE task_id LIKE 'missing-task-%'",
      ).toEqual([]);
      expect(
        (
          await withStateMigrationBackupForTest(options, () =>
            repairOpenClawStateDatabaseSchema(options),
          )
        ).warnings,
      ).toEqual([]);
      expect(recoveryArtifacts(databasePath)).toEqual(recoveryDirs);
    } finally {
      corrupted.close();
    }
  });

  it.each(["unrelated foreign key", "trigger"])(
    "refuses orphan delivery recovery with %s without changing data",
    (variant) => {
      const stateDir = createTempStateDir();
      const databasePath = materializeCurrentStateDatabase(stateDir);
      withDatabase(databasePath, (seed) => {
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
        expectRecord(seed, "task_delivery_state WHERE task_id = 'orphan'", {
          requester_origin_json: "preserve me",
        });
        expectRows(seed, "PRAGMA foreign_key_check").toEqual(before);
        expect(recoveryArtifacts(databasePath)).toEqual([]);
      });
    },
  );

  it("rolls back orphan delivery recovery after CASCADE and retains the original backup", () => {
    const { stateDir, databasePath } = createStateFixture();
    const seed = openNativeDatabase(databasePath);

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
      expectRecord(seed, "task_delivery_state WHERE task_id = 'orphan'", {
        requester_origin_json: "preserve me",
      });
      expectRows(seed, "PRAGMA foreign_key_check").toHaveLength(1);

      expectRecords(seed, "delivery_dependent", [{ task_id: "orphan" }]);

      const artifacts = recoveryArtifacts(databasePath);
      expect(artifacts).toHaveLength(1);
      withReadOnlyDatabase(
        path.join(path.dirname(databasePath), artifacts[0]!, "database.sqlite"),
        (backup) => {
          expectRecord(backup, "task_delivery_state WHERE task_id = 'orphan'", {
            requester_origin_json: "preserve me",
          });
          expectIntegrity(backup);
        },
      );
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

  it("adds and backfills Claw package update timestamps in existing state databases", async () => {
    const stateDir = createTempStateDir();
    const legacyDb = openMaterializedCurrentStateDatabase(stateDir);
    insertRow(legacyDb, "claw_package_refs", {
      agent_id: "incident",
      package_kind: "plugin",
      package_source: "clawhub",
      package_ref: "@owner/audit",
      package_version: "2.0.1",
      package_integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schema_version: "openclaw.clawPackageRef.v1",
      claw_name: "incident-claw",
      package_status: "complete",
      relationship: "referenced",
      origin: "claw-introduced",
      independent_owner: 0,
      installed_at_ms: 1234,
      updated_at_ms: 5678,
    });
    legacyDb.exec("ALTER TABLE claw_package_refs DROP COLUMN updated_at_ms");
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    await withStateMigrationBackupForTest({ env: { OPENCLAW_STATE_DIR: stateDir } }, () =>
      openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    );
    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expectRecord(reopened.db, "claw_package_refs", {
      installed_at_ms: 1234,
      updated_at_ms: 1234,
    });
  });

  it("backfills durable approval transport references in databases created by PR 1", async () => {
    const { stateDir, databasePath } = createStateFixture();
    const approvalId = "approval/from-pr1";
    const expectedRef = buildApprovalResolutionRef({ approvalId, approvalKind: "exec" });
    const legacyDb = openNativeDatabase(databasePath);
    insertRow(legacyDb, "operator_approvals", {
      cursor_id: 1,
      approval_id: approvalId,
      resolution_ref: expectedRef,
      kind: "exec",
      status: "pending",
      presentation_json: "{}",
      requested_by_device_token_auth: 0,
      reviewer_device_ids_json: "[]",
      audience_session_keys_json: "[]",
      runtime_epoch: "pr1-runtime",
      created_at_ms: 1,
      expires_at_ms: 1000,
      updated_at_ms: 1,
    });
    legacyDb.exec(`
      DROP INDEX idx_operator_approvals_resolution_ref;
      ALTER TABLE operator_approvals DROP COLUMN resolution_ref;
    `);
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    await withStateMigrationBackupForTest({ env: { OPENCLAW_STATE_DIR: stateDir } }, () =>
      openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    );
    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    expectRecord(
      reopened.db,
      "operator_approvals WHERE approval_id = ?",
      { resolution_ref: expectedRef },
      approvalId,
    );
    const indexes = reopened.db.prepare("PRAGMA index_list(operator_approvals)").all() as Array<{
      name?: unknown;
      unique?: unknown;
    }>;
    expect(indexes).toContainEqual(
      expect.objectContaining({ name: "idx_operator_approvals_resolution_ref", unique: 1 }),
    );
  });

  it("migrates operator approvals to accept system-agent records", async () => {
    const { options, databasePath } = createStateFixture((legacyDb) => {
      legacyDb.exec("DROP TABLE operator_approvals");
      legacyDb.exec(
        OLDER_OPERATOR_APPROVAL_SCHEMA_SQL.replace(
          "'exec', 'plugin', 'system-agent'",
          "'exec', 'plugin'",
        ),
      );
    });

    expectMigrations(options, databasePath).contains("operator-approvals-system-agent");
    await expectRepair(options, [
      "Migrated shared state operator approvals → OpenClaw system changes",
    ]);

    const reopened = openOpenClawStateDatabase(options);
    const migratedSql = reopened.db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approvals'")
      .get() as { sql: string };
    expect(migratedSql.sql).toContain("'system-agent'");
  });

  it("does not recursively recommend doctor when operator approval repair refuses a shape", () => {
    const { options } = createStateFixture((customizedDb) => {
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
    });

    const result = repairOpenClawStateDatabaseSchema(options);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("automatic repair refused the unrecognized schema shape"),
    ]);
    expect(result.warnings[0]).not.toContain("run openclaw doctor --fix");
  });

  it("migrates captured historical queue tables before creating newer indexes", async () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeV2026_7_1_2StateDatabase(stateDir).databasePath;
    const db = openNativeDatabase(databasePath);
    db.exec(`
      DROP TABLE sandbox_registry_entries;
      DROP TABLE delivery_queue_entries;
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
    const insertQueueRow = db.prepare(
      `INSERT INTO delivery_queue_entries (
          queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    function seedQueueRow(
      queue: string,
      id: string,
      status: "pending" | "failed",
      metadata: Record<string, unknown> | string,
      enqueuedAt: number,
      updatedAt = enqueuedAt,
      failedAt: number | null = null,
    ) {
      const entry =
        typeof metadata === "string" ? metadata : JSON.stringify({ id, enqueuedAt, ...metadata });
      insertQueueRow.run(queue, id, status, entry, enqueuedAt, updatedAt, failedAt);
    }
    const seedPending = (id: string, metadata: Record<string, unknown>, at: number) =>
      seedQueueRow("outbound", id, "pending", metadata, at);
    const seedFailure = (
      id: string,
      metadata: Record<string, unknown> | string,
      queue = "outbound",
      times: [number, number, number] = [60, 61, 62],
    ) => seedQueueRow(queue, id, "failed", metadata, ...times);
    seedPending(
      "delivery-1",
      {
        retryCount: 3,
        lastAttemptAt: 20,
        lastError: "no listener",
        kind: "message",
        sessionKey: "agent:main:main",
        route: { channel: "telegram", to: "chat-1", accountId: "acct-1" },
      },
      10,
    );
    seedPending(
      "delivery-invalid-integers",
      {
        retryCount: 1.5,
        lastAttemptAt: Number.MAX_SAFE_INTEGER + 1,
        platformSendStartedAt: 2.5,
      },
      11,
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
    const pendingEntry = (
      queueName: string,
      id: string,
      metadata: Record<string, unknown> = {},
    ) => ({
      queueName,
      id,
      payloads: [{ text: "private payload" }],
      ...metadata,
      recoveryState: metadata.recoveryState,
    });
    const pendingEntries = [
      pendingEntry("outbound", "pending-failure-retention", { failureRetention: "permanent" }),
      pendingEntry("outbound", "upgrade-bounded:v1:pending-completion-retention", {
        completionRetention: pendingBoundedRetention,
      }),
      pendingEntry("outbound", "pending-required-claim", { requiresProducerClaim: true }),
      pendingEntry("outbound", "pending-producer-claim", {
        producerClaimId: "claim-before-upgrade",
      }),
      pendingEntry("outbound-prepared-v1", "pending-ambiguous-platform-send", {
        platformSendAttemptId: "attempt-before-upgrade",
        recoveryState: "unknown_after_send",
      }),
      pendingEntry("session", "pending-session-available-at", { availableAt: 30 }),
      pendingEntry("outbound-preparing-v1", "pending-stable-preparation"),
      pendingEntry("outbound-prepared-v1", "pending-delivery-completion", {
        deliveryCompletion: { kind: "conversation", operationId: "op-before-upgrade" },
      }),
    ];
    for (const { queueName, ...entry } of pendingEntries) {
      seedQueueRow(queueName, entry.id, "pending", { retryCount: 0, ...entry }, 20);
    }
    seedFailure(
      "rich-failure",
      {
        retryCount: 2,
        channel: "private-channel",
        to: "private-target",
        accountId: "private-account",
        lastError: "raw provider error",
        payloads: [{ text: "private payload", mediaUrl: "/private/media" }],
      },
      "outbound",
      [30, 31, 32],
    );
    seedFailure("malformed-failure", "{corrupt private bytes", "session", [40, -1, -1]);
    seedFailure("minimal-failure", { failedAt: 52, retryCount: 1 }, "session", [50, 51, 52]);
    seedFailure(
      "ambiguous-beta-failure",
      {
        retryCount: 2,
        platformSendAttemptId: "beta-attempt",
        payloads: [{ text: "private ambiguous payload" }],
      },
      "outbound-prepared-v1",
      [53, 54, 55],
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
      seedFailure(id, { retryCount, ...metadata });
    }
    seedFailure("claimed-session-failure", { retryCount: 1, availableAt: 70 }, "session");
    const unsafeTimestampRetention = {
      idPrefix: "unsafe-timestamp:",
      maxAgeMs: 86_400_000,
      maxEntries: 1,
    };
    seedFailure("unsafe-timestamp:bounded", {
      retryCount: 1,
      completionRetention: unsafeTimestampRetention,
    });
    const backfillCapRetention = {
      idPrefix: "backfill-cap:",
      maxAgeMs: 86_400_000,
      maxEntries: 1,
    };
    for (const [id, terminalAt] of [
      ["backfill-cap:old", 70],
      ["backfill-cap:new", 71],
    ] as const) {
      seedFailure(id, { retryCount: 0, completionRetention: backfillCapRetention }, "outbound", [
        terminalAt,
        terminalAt,
        terminalAt,
      ]);
    }
    db.exec(
      "UPDATE delivery_queue_entries SET retry_count = 9223372036854775807 WHERE id = 'unsafe-retry'",
    );
    db.exec(
      "UPDATE delivery_queue_entries SET updated_at = 9223372036854775807, failed_at = 9223372036854775807 WHERE id = 'unsafe-timestamp:bounded'",
    );
    db.close();

    expect(
      await withStateMigrationBackupForTest(options, () =>
        repairOpenClawStateDatabaseSchema(options),
      ),
    ).toMatchObject({ warnings: [] });
    const database = openOpenClawStateDatabase(options);

    expect(() =>
      database.db.prepare("SELECT session_key FROM sandbox_registry_entries LIMIT 1").all(),
    ).not.toThrow();
    expect(() =>
      database.db.prepare("SELECT session_key FROM delivery_queue_entries LIMIT 1").all(),
    ).not.toThrow();
    expectRecord(
      database.db,
      "delivery_queue_entries WHERE id = ?",
      {
        account_id: "acct-1",
        channel: "telegram",
        entry_kind: "message",
        last_attempt_at: 20,
        last_error: "no listener",
        retry_count: 3,
        session_key: "agent:main:main",
        target: "chat-1",
      },
      "delivery-1",
    );
    expectRecord(database.db, "delivery_queue_entries WHERE id = 'delivery-invalid-integers'", {
      retry_count: 0,
      last_attempt_at: null,
      platform_send_started_at: null,
    });
    const transientClaimIds = new Set(["pending-required-claim", "pending-producer-claim"]);
    for (const { queueName, recoveryState: _legacyRecoveryState, ...pending } of pendingEntries) {
      const entry = loadDeliveryQueueEntry(queueName, pending.id, stateDir);
      expect(entry).not.toBeNull();
      if (!transientClaimIds.has(pending.id)) {
        expect(entry).toMatchObject({
          ...pending,
          ...(queueName === "outbound" ? {} : { retainOnFailure: true }),
        });
      }
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
    expectCurrentStateVersion(requireNativeSqliteDatabase(database.db));

    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    expectRows(reopened.db, failureRowsSql).toEqual(failureRows);
    expect(getDeliveryQueueEntryStatus("outbound", "unsafe-timestamp:bounded", stateDir)).toBe(
      "failed",
    );
    expect(
      (await countFailedDeliveryQueueEntries(stateDir)).some(
        ({ queueName, count }) => queueName === "outbound" && count > 0,
      ),
    ).toBe(true);
  });

  it("latches newer global schema failures before integrity scans", () => {
    const { options, databasePath } = createStateFixture();
    createUnsafeIndexDrift(databasePath);
    const db = openNativeDatabase(databasePath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    db.close();

    const firstFailure = captureFailure(() => openOpenClawStateDatabase(options));
    expect(firstFailure).toMatchObject({
      name: "SqliteSchemaVersionError",
      message: expect.stringContaining("https://docs.openclaw.ai/reference/database-schemas"),
    });

    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      fs.rmSync(candidate, { force: true });
    }
    const secondFailure = captureFailure(() => openOpenClawStateDatabase(options));
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

    expect(result).toMatchObject({
      sameHandle: false,
      firstFileExists: true,
      secondFileExists: true,
      firstRows: [{ event_key: "first" }],
      secondRows: [{ event_key: "second" }],
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
