// OpenClaw agent database tests cover agent-scoped DB storage and migrations.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, assert, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import {
  beginAgentDeletionJournal,
  claimCompletedAgentDeletionJournal,
  removeAgentDeletionJournal,
  updateAgentDeletionJournalDatabasePaths,
  updateAgentDeletionJournalCleanupPaths,
} from "../test-utils/agent-deletion-journal.js";
import { VERSION } from "../version.js";
import { runWithAgentCreationClaim } from "./agent-creation-claim.js";
import { completeAgentDeletionJournalInDatabase } from "./agent-deletion-journal.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import { disposeOpenClawAgentDatabaseByPath } from "./openclaw-agent-db-disposal.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  migrateOpenClawAgentDatabaseForMaintenance,
} from "./openclaw-agent-db-maintenance.js";
import { withOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabases,
} from "./openclaw-agent-db-registry.js";
import { invalidateOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import {
  clearOpenClawAgentDatabaseOpenFailure,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  ensureOpenClawAgentDatabaseSchema,
  inspectOpenClawAgentDatabaseOwner,
  isOpenClawAgentDatabaseOpen,
  listOpenClawRegisteredAgentDatabases,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase as openOpenClawAgentDatabaseRuntime,
  readOpenClawAgentDatabaseRegistryToken,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  settleOpenClawAgentDatabaseWorkerClose,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isSameOpenClawAgentDatabasePath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import {
  removeCanonicalValidationFromHistoricalAgentFixture,
  seedSchema19SessionKeyRepairFixture,
} from "./openclaw-agent-db.test-support.js";
import { materializeV21WorkerAgentDatabase } from "./openclaw-agent-schema-v21.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  createCacheExpiryIndexPhysicalDrift,
  createCanonicalAgentIndexDrift,
  createTranscriptIdempotencyIndexDrift,
  createUnsafeIndexDrift,
} from "./sqlite-index-drift.test-support.js";
import {
  collectSqliteSchemaShape,
  createSqliteSchemaShapeFromSql,
  normalizeSqliteSchemaShapeSql,
} from "./sqlite-schema-shape.test-support.js";

const agentDbTempDirs: string[] = [];
let sharedStateDatabaseTemplatePath: string | undefined;
let currentWorkerAgentDatabaseTemplatePath: string | undefined;
let v13WorkerAgentDatabaseTemplatePath: string | undefined;

function createTempStateDir(): string {
  return makeTempDir(agentDbTempDirs, "openclaw-agent-db-");
}

function ensureSharedStateDatabaseTemplate(): string {
  if (sharedStateDatabaseTemplatePath) {
    return sharedStateDatabaseTemplatePath;
  }
  const stateDir = makeTempDir(agentDbTempDirs, "openclaw-agent-db-shared-state-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawStateDatabase({ env });
  sharedStateDatabaseTemplatePath = database.path;
  closeOpenClawStateDatabaseForTest();
  return sharedStateDatabaseTemplatePath;
}

function materializeSharedStateDatabase(env: NodeJS.ProcessEnv | undefined): void {
  const stateDatabasePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(stateDatabasePath)) {
    // Agent schema tests own the per-agent database. Seed the shared registry
    // from one real closed database instead of rebuilding its full schema per case.
    fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
    fs.copyFileSync(ensureSharedStateDatabaseTemplate(), stateDatabasePath);
  }
}

function openOpenClawAgentDatabase(
  options: Parameters<typeof openOpenClawAgentDatabaseRuntime>[0],
) {
  materializeSharedStateDatabase(options.env);
  return openOpenClawAgentDatabaseRuntime(options);
}

function ensureCurrentWorkerAgentDatabaseTemplate(): string {
  if (currentWorkerAgentDatabaseTemplatePath) {
    return currentWorkerAgentDatabaseTemplatePath;
  }
  const stateDir = makeTempDir(agentDbTempDirs, "openclaw-agent-db-current-worker-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const template = openOpenClawAgentDatabase({ agentId: "worker-1", env });
  const templatePath = template.path;
  template.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  const walPath = `${templatePath}-wal`;
  if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    throw new Error("current worker agent database template retained WAL content");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    fs.rmSync(`${templatePath}${suffix}`, { force: true });
  }

  const { DatabaseSync } = requireNodeSqlite();
  const verified = new DatabaseSync(templatePath, { readOnly: true });
  try {
    const integrity = verified.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: unknown }
      | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new Error("current worker agent database template failed integrity check");
    }
    if (verified.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("current worker agent database template failed foreign key check");
    }
    if (readSqliteNumberPragma(verified, "user_version") !== OPENCLAW_AGENT_SCHEMA_VERSION) {
      throw new Error("current worker agent database template has the wrong schema version");
    }
    const owner = verified
      .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
      .get();
    if (!owner || (owner as { agent_id?: unknown }).agent_id !== "worker-1") {
      throw new Error("current worker agent database template has the wrong owner");
    }
  } finally {
    verified.close();
  }
  currentWorkerAgentDatabaseTemplatePath = templatePath;
  return templatePath;
}

function materializeCurrentWorkerAgentDatabase(stateDir: string): string {
  const options = {
    agentId: "worker-1",
    env: { OPENCLAW_STATE_DIR: stateDir },
  } as const;
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.copyFileSync(
    ensureCurrentWorkerAgentDatabaseTemplate(),
    databasePath,
    fs.constants.COPYFILE_EXCL,
  );
  return databasePath;
}

function ensureV13WorkerAgentDatabaseTemplate(): string {
  if (v13WorkerAgentDatabaseTemplatePath) {
    return v13WorkerAgentDatabaseTemplatePath;
  }
  // Legacy migration cases mutate independent clones; keep one closed, verified v13
  // baseline so the test-only reverse migration is not repeated for every case.
  const stateDir = createTempStateDir();
  const databasePath = resolveOpenClawAgentSqlitePath({
    agentId: "worker-1",
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  materializeV21WorkerAgentDatabase(stateDir);
  downgradeV21AgentDatabaseToV13(databasePath);

  const { DatabaseSync } = requireNodeSqlite();
  const checkpoint = new DatabaseSync(databasePath);
  try {
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    checkpoint.close();
  }
  const walPath = `${databasePath}-wal`;
  if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    throw new Error("v13 worker agent database template retained WAL content");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }

  const verified = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(verified.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(verified.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(readSqliteNumberPragma(verified, "user_version")).toBe(13);
    expect(
      verified
        .prepare(
          "SELECT role, agent_id, schema_version FROM schema_meta WHERE meta_key = 'primary'",
        )
        .get(),
    ).toEqual({ role: "agent", agent_id: "worker-1", schema_version: 13 });
    expect(
      verified
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('sessions', 'session_entries', 'session_routes') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "session_entries" }, { name: "session_routes" }, { name: "sessions" }]);
    expect(
      verified
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('session_nodes', 'session_pending_inputs', 'session_input_completions')",
        )
        .all(),
    ).toEqual([]);
  } finally {
    verified.close();
  }
  v13WorkerAgentDatabaseTemplatePath = databasePath;
  return databasePath;
}

function materializeV13WorkerAgentDatabase(stateDir: string): string {
  const options = {
    agentId: "worker-1",
    env: { OPENCLAW_STATE_DIR: stateDir },
  } as const;
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.copyFileSync(ensureV13WorkerAgentDatabaseTemplate(), databasePath, fs.constants.COPYFILE_EXCL);
  return databasePath;
}

async function migrateAndOpenLegacyAgentDatabaseForTest(
  options: Parameters<typeof openOpenClawAgentDatabase>[0],
) {
  // Prepare the unrelated registry before the real maintenance lease's acquisition budget.
  materializeSharedStateDatabase(options.env);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(pathname);
  try {
    await withAgentDatabaseMaintenanceLease({ env: options?.env }, async () =>
      ensureOpenClawAgentDatabaseSchema(database, options),
    );
  } finally {
    database.close();
  }
  return openOpenClawAgentDatabase(options);
}

const tempVolumeIsCaseInsensitive = (() => {
  const probeDir = fs.realpathSync(createTempStateDir());
  const probePath = path.join(probeDir, "CaseProbe");
  fs.writeFileSync(probePath, "probe");
  try {
    const probe = fs.lstatSync(probePath, { bigint: true });
    const alias = fs.lstatSync(path.join(probeDir, "caseProbe"), { bigint: true });
    return probe.dev === alias.dev && probe.ino === alias.ino;
  } catch {
    return false;
  }
})();

const tempVolumeIsNormalizationInsensitive = (() => {
  const probeDir = fs.realpathSync(createTempStateDir());
  const probePath = path.join(probeDir, "CaféProbe");
  fs.writeFileSync(probePath, "probe");
  try {
    const probe = fs.lstatSync(probePath, { bigint: true });
    const alias = fs.lstatSync(path.join(probeDir, "CaféProbe"), { bigint: true });
    return probe.dev === alias.dev && probe.ino === alias.ino;
  } catch {
    return false;
  }
})();

function downgradeV21AgentDatabaseToV13(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    removeCanonicalValidationFromHistoricalAgentFixture(database);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = OFF;
      DROP TABLE session_participants;
      DROP TABLE session_pending_inputs;
      DROP TABLE session_input_completions;
      DROP INDEX IF EXISTS idx_agent_session_windows_updated_at;
      DROP INDEX IF EXISTS idx_agent_session_windows_created_at;
      DROP INDEX IF EXISTS idx_agent_session_windows_conversation;
      ALTER TABLE session_windows RENAME TO sessions;
      CREATE TABLE sessions_legacy (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_scope TEXT NOT NULL DEFAULT 'conversation' CHECK (session_scope IN ('conversation', 'shared-main', 'group', 'channel')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        transcript_updated_at INTEGER DEFAULT NULL,
        transcript_observed_at INTEGER DEFAULT NULL,
        session_entry_provenance INTEGER NOT NULL DEFAULT 0 CHECK (session_entry_provenance IN (0, 1)),
        acp_owned INTEGER NOT NULL DEFAULT 0 CHECK (acp_owned IN (0, 1)),
        plugin_owner_id TEXT,
        hook_external_content_source TEXT CHECK (hook_external_content_source IS NULL OR hook_external_content_source IN ('gmail', 'webhook')),
        started_at INTEGER,
        ended_at INTEGER,
        status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout')),
        chat_type TEXT CHECK (chat_type IS NULL OR chat_type IN ('direct', 'group', 'channel')),
        channel TEXT,
        account_id TEXT,
        primary_conversation_id TEXT,
        model_provider TEXT,
        model TEXT,
        agent_harness_id TEXT,
        parent_session_key TEXT,
        spawned_by TEXT,
        display_name TEXT,
        FOREIGN KEY (primary_conversation_id) REFERENCES conversations(conversation_id) ON DELETE SET NULL
      ) STRICT;
      INSERT INTO sessions_legacy (
        session_id, session_key, session_scope, created_at, updated_at,
        transcript_updated_at, transcript_observed_at, session_entry_provenance,
        acp_owned, plugin_owner_id, hook_external_content_source, started_at,
        ended_at, status, chat_type, channel, account_id, primary_conversation_id,
        model_provider, model, agent_harness_id, parent_session_key, spawned_by,
        display_name
      )
      SELECT
        session_id, session_key, session_scope, created_at, updated_at,
        transcript_updated_at, transcript_observed_at, session_entry_provenance,
        acp_owned, plugin_owner_id, hook_external_content_source, started_at,
        ended_at, status, chat_type, channel, account_id, primary_conversation_id,
        model_provider, model, agent_harness_id, parent_session_key, spawned_by,
        display_name
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_legacy RENAME TO sessions;
      CREATE INDEX idx_agent_sessions_updated_at ON sessions(updated_at DESC, session_id);
      CREATE INDEX idx_agent_sessions_created_at ON sessions(created_at DESC, session_id);
      CREATE INDEX idx_agent_sessions_conversation
        ON sessions(primary_conversation_id, updated_at DESC, session_id)
        WHERE primary_conversation_id IS NOT NULL;
      CREATE TABLE session_routes (
        session_key TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_agent_session_routes_session_id ON session_routes(session_id);
      CREATE TABLE session_entries (
        session_key TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout')),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_agent_session_entries_updated_at
        ON session_entries(updated_at DESC, session_key);
      CREATE INDEX idx_agent_session_entries_session_updated
        ON session_entries(session_id, updated_at DESC, session_key);
      CREATE INDEX idx_agent_session_entries_status
        ON session_entries(status, session_key) WHERE status IS NOT NULL;
      CREATE TABLE session_members_v13 (
        session_key TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (session_key, identity_id),
        FOREIGN KEY (session_key) REFERENCES session_entries(session_key) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO session_members_v13 SELECT * FROM session_members;
      DROP TABLE session_members;
      ALTER TABLE session_members_v13 RENAME TO session_members;
      CREATE INDEX idx_agent_session_members_identity
        ON session_members(identity_id, session_key);
      ALTER TABLE transcript_rewrite_watermarks RENAME TO session_transcript_generations;
      CREATE TABLE board_tabs_v13 (
        session_key TEXT NOT NULL,
        tab_id TEXT NOT NULL,
        title TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        chat_dock TEXT NOT NULL DEFAULT 'right' CHECK (chat_dock IN ('left', 'right', 'bottom', 'hidden')),
        created_by TEXT NOT NULL CHECK (created_by IN ('user', 'agent')),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        PRIMARY KEY (session_key, tab_id)
      ) STRICT;
      INSERT INTO board_tabs_v13 SELECT * FROM board_tabs;
      DROP TABLE board_tabs;
      ALTER TABLE board_tabs_v13 RENAME TO board_tabs;
      DROP TABLE heartbeat_outcomes;
      CREATE TABLE heartbeat_outcomes (
        session_key TEXT NOT NULL PRIMARY KEY,
        run_session_key TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('progress', 'done', 'blocked', 'needs_attention')),
        summary TEXT NOT NULL,
        response_reason TEXT,
        priority TEXT CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high')),
        next_check TEXT,
        task_names_json TEXT,
        wake_source TEXT,
        wake_reason TEXT,
        occurred_at INTEGER NOT NULL,
        context_run_id TEXT,
        context_claimed_at INTEGER,
        updated_at INTEGER NOT NULL
      ) STRICT;
      DROP TABLE session_nodes;
      PRAGMA user_version = 13;
      UPDATE schema_meta SET schema_version = 13 WHERE meta_key = 'primary';
    `);
  } finally {
    database.close();
  }
}

function seedVersion1MemoryAgentDatabase(databasePath: string): void {
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
      INSERT INTO schema_meta VALUES ('primary', 'agent', 1, 'worker-1', NULL, 1, 1);
      CREATE TABLE memory_index_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT INTO memory_index_state VALUES (1, 7);
      CREATE TABLE memory_index_sources (
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (path, source)
      );
      INSERT INTO memory_index_sources (rowid, path, source, hash, mtime, size)
      VALUES
        (41, 'shared.md', 'memory', 'memory-hash', 10, 20),
        (84, 'shared.md', 'sessions', 'session-hash', 30, 40);
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO memory_index_chunks VALUES (
        'sentinel', 'shared.md', 'memory', 1, 1, 'chunk-hash', 'model', 'body', '[]', 1
      );
      CREATE TRIGGER memory_index_sources_revision_after_insert
      AFTER INSERT ON memory_index_sources
      BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;
      CREATE TRIGGER memory_index_sources_revision_after_update
      AFTER UPDATE ON memory_index_sources
      BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;
      CREATE TRIGGER memory_index_sources_revision_after_delete
      AFTER DELETE ON memory_index_sources
      BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;
    `);
    db.exec(`
      CREATE VIRTUAL TABLE memory_index_paths_fts USING fts5(path, source UNINDEXED);
      INSERT INTO memory_index_paths_fts (path, source)
      VALUES ('shared.md', 'memory'), ('shared.md', 'sessions');
      CREATE TRIGGER memory_index_paths_fts_after_insert
      AFTER INSERT ON memory_index_sources
      BEGIN
        INSERT INTO memory_index_paths_fts (path, source) VALUES (NEW.path, NEW.source);
      END;
      CREATE TRIGGER memory_index_paths_fts_after_update
      AFTER UPDATE OF path, source ON memory_index_sources
      BEGIN
        DELETE FROM memory_index_paths_fts
        WHERE path = OLD.path AND source = OLD.source;
        INSERT INTO memory_index_paths_fts (path, source) VALUES (NEW.path, NEW.source);
      END;
      CREATE TRIGGER memory_index_paths_fts_after_delete
      AFTER DELETE ON memory_index_sources
      BEGIN
        DELETE FROM memory_index_paths_fts
        WHERE path = OLD.path AND source = OLD.source;
      END;
    `);
  } finally {
    db.close();
  }
}

type AgentSchemaOpenerResult = { agentId: string; ok: boolean; error?: string };

function launchAgentSchemaOpener(params: {
  agentId: string;
  databasePath: string;
  stateDir: string;
}) {
  const agentModuleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.agentDatabase);
  const stateModuleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase);
  const sqliteModuleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.nodeSqlite);
  const child = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(agentModuleUrl).slice(0, -1),
      "--input-type=module",
      "-e",
      `
        import { openNodeSqliteDatabase } from ${JSON.stringify(sqliteModuleUrl.href)};
        import {
          ensureOpenClawAgentDatabaseSchema,
        } from ${JSON.stringify(agentModuleUrl.href)};
        import {
          closeOpenClawStateDatabaseForTest,
        } from ${JSON.stringify(stateModuleUrl.href)};

        const db = openNodeSqliteDatabase(process.env.OPENCLAW_AGENT_DB_RACE_PATH);
        db.exec("PRAGMA busy_timeout = 5000;");
        const observedDb = new Proxy(db, {
          get(target, property) {
            if (property === "exec") {
              return (sql) => {
                if (sql.trimStart().startsWith("BEGIN IMMEDIATE")) {
                  console.log("begin-attempt");
                }
                return target.exec(sql);
              };
            }
            if (property === "prepare") {
              return (sql) => target.prepare(sql);
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        console.log("ready");
        process.stdin.once("data", () => {
          let result;
          try {
            ensureOpenClawAgentDatabaseSchema(observedDb, {
              agentId: process.env.OPENCLAW_AGENT_DB_RACE_AGENT,
              env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_AGENT_DB_RACE_STATE_DIR },
              path: process.env.OPENCLAW_AGENT_DB_RACE_PATH,
              register: true,
            });
            result = { agentId: process.env.OPENCLAW_AGENT_DB_RACE_AGENT, ok: true };
          } catch (error) {
            result = {
              agentId: process.env.OPENCLAW_AGENT_DB_RACE_AGENT,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          } finally {
            closeOpenClawStateDatabaseForTest();
            db.close();
          }
          console.log(JSON.stringify(result));
        });
      `,
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_AGENT_DB_RACE_AGENT: params.agentId,
        OPENCLAW_AGENT_DB_RACE_PATH: params.databasePath,
        OPENCLAW_AGENT_DB_RACE_STATE_DIR: params.stateDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let readyResolved = false;
  let beginResolved = false;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveBegin: (() => void) | undefined;
  let rejectBegin: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const beginAttempt = new Promise<void>((resolve, reject) => {
    resolveBegin = resolve;
    rejectBegin = reject;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    if (!readyResolved && lines.includes("ready")) {
      readyResolved = true;
      resolveReady?.();
    }
    if (!beginResolved && lines.includes("begin-attempt")) {
      beginResolved = true;
      resolveBegin?.();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<AgentSchemaOpenerResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      const earlyExit = new Error(`agent opener exited before synchronization: ${stderr}`);
      if (!readyResolved) {
        rejectReady?.(earlyExit);
      }
      if (!beginResolved) {
        rejectBegin?.(earlyExit);
      }
      if (code !== 0) {
        reject(new Error(`agent opener exited ${String(code)}: ${stderr}`));
        return;
      }
      const resultLine = stdout
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith("{"));
      if (!resultLine) {
        reject(new Error(`agent opener returned no result: ${stdout} ${stderr}`));
        return;
      }
      resolve(JSON.parse(resultLine) as AgentSchemaOpenerResult);
    });
  });
  return { beginAttempt, child, ready, result };
}

beforeAll(() => {
  ensureCurrentWorkerAgentDatabaseTemplate();
  ensureV13WorkerAgentDatabaseTemplate();
});

afterAll(() => {
  cleanupTempDirs(agentDbTempDirs);
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("openclaw agent database", () => {
  it("keeps incognito state writable without SQLite extension support", () => {
    const options = { agentId: "worker-1", env: { OPENCLAW_STATE_DIR: createTempStateDir() } };
    const capability = vi
      .spyOn(nodeSqlite, "supportsNodeSqliteExtensionLoading")
      .mockReturnValue(false);
    try {
      const { db } = openOpenClawAgentDatabase({
        ...options,
        path: resolveIncognitoOpenClawAgentSqlitePath(options),
      });
      db.prepare("UPDATE schema_meta SET updated_at = ? WHERE meta_key = 'primary'").run(123);
      expect(
        db.prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ updated_at: 123 });
      expect(() => db.enableLoadExtension(true)).toThrow();
    } finally {
      capability.mockRestore();
    }
  });

  it("uses the canonical state schema for deletion journal reads and updates", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    materializeSharedStateDatabase(env);

    const entry = {
      agentId: "deleted",
      agentDir: path.join(stateDir, "agents", "deleted", "agent"),
      workspaceDir: path.join(stateDir, "workspace-deleted"),
      sessionsDir: path.join(stateDir, "sessions-deleted"),
    };
    const deletion = beginAgentDeletionJournal(
      { ...entry, operationId: "deletion", deleteFiles: true },
      { env },
    );
    const databasePaths = [path.join(entry.agentDir, "openclaw-agent.sqlite")];
    const cleanupPaths = [
      {
        path: entry.agentDir,
        canonicalPath: entry.agentDir,
        parentPath: path.dirname(entry.agentDir),
        kind: "target" as const,
        sourcePaths: [entry.agentDir],
        dev: null,
        ino: null,
        coversDescendants: true,
        done: false,
      },
    ];
    updateAgentDeletionJournalDatabasePaths(deletion.agentId, deletion.operationId, databasePaths, {
      env,
    });
    updateAgentDeletionJournalCleanupPaths(deletion.agentId, deletion.operationId, cleanupPaths, {
      env,
    });

    const recovery = beginAgentDeletionJournal(
      { ...entry, operationId: "recovery", deleteFiles: true },
      { env },
    );
    expect(recovery.databasePaths).toEqual(databasePaths);
    expect(recovery.cleanupPaths).toEqual(cleanupPaths);
    removeAgentDeletionJournal(recovery.agentId, recovery.operationId, { env });
  });

  it("fences registration and lease claims beneath another agent's pending deletion", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentDir = path.join(stateDir, "agents", "deleted", "agent");
    const linkedAgentDir = path.join(stateDir, "linked-deleted-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.symlinkSync(agentDir, linkedAgentDir, "dir");
    const databasePath = path.join(agentDir, "nested", "survivor.sqlite");
    const relocatedDatabasePath = path.join(stateDir, "relocated", "deleted.sqlite");
    const sidecarClaimPath = path.join(stateDir, "sidecar", "shared.sqlite");
    const registeredSidecarPath = `${sidecarClaimPath}-wal`;
    registerOpenClawAgentDatabase({
      agentId: "deleted",
      path: relocatedDatabasePath,
      env,
    });
    registerOpenClawAgentDatabase({ agentId: "deleted", path: registeredSidecarPath, env });
    const deletion = beginAgentDeletionJournal(
      {
        operationId: "deletion",
        deleteFiles: true,
        agentId: "deleted",
        agentDir: linkedAgentDir,
        workspaceDir: path.join(stateDir, "workspace-deleted"),
        sessionsDir: path.join(stateDir, "sessions-deleted"),
      },
      { env },
    );

    unregisterOpenClawAgentDatabase({ agentId: "deleted", path: relocatedDatabasePath, env });
    unregisterOpenClawAgentDatabase({ agentId: "deleted", path: registeredSidecarPath, env });

    try {
      for (const fencedPath of [databasePath, relocatedDatabasePath, sidecarClaimPath]) {
        expect(() =>
          registerOpenClawAgentDatabase({ agentId: "survivor", path: fencedPath, env }),
        ).toThrow("deletion owns");
        expect(() =>
          claimOpenClawAgentDatabaseLease({ agentId: "survivor", path: fencedPath, env }),
        ).toThrow("deletion owns");
      }
    } finally {
      removeAgentDeletionJournal(deletion.agentId, deletion.operationId, { env });
    }

    expect(() =>
      registerOpenClawAgentDatabase({ agentId: "survivor", path: databasePath, env }),
    ).not.toThrow();
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "survivor",
      path: databasePath,
      env,
    });
    releaseOpenClawAgentDatabaseLease(leaseId, { env });
    unregisterOpenClawAgentDatabase({ agentId: "survivor", path: databasePath, env });
  });

  it("blocks deletion on a foreign lease beneath its workspace until release", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const workspaceDir = path.join(stateDir, "workspace-deleted");
    const foreignDatabasePath = path.join(workspaceDir, "nested", "survivor.sqlite");
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "survivor",
      path: foreignDatabasePath,
      env,
    });
    const deletion = beginAgentDeletionJournal(
      {
        operationId: "deletion",
        deleteFiles: true,
        agentId: "deleted",
        agentDir: path.join(stateDir, "agents", "deleted", "agent"),
        workspaceDir,
        sessionsDir: path.join(stateDir, "sessions-deleted"),
      },
      { env },
    );

    expect(() => assertNoOpenClawAgentDatabaseLeases("deleted", { env })).toThrow("deletion owns");
    releaseOpenClawAgentDatabaseLease(leaseId, { env });
    expect(() => assertNoOpenClawAgentDatabaseLeases("deleted", { env })).not.toThrow();
    removeAgentDeletionJournal(deletion.agentId, deletion.operationId, { env });
  });

  it("opens the agent and its shared registry under the default HOME state owner", () => {
    const home = createTempStateDir();
    const env = { HOME: home, NODE_ENV: "test" };
    const options = { agentId: "main", env };
    const stateDir = path.join(home, ".openclaw");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");

    // Fail before opening if path resolution escapes the test-owned home.
    expect(resolveOpenClawAgentSqlitePath(options)).toBe(agentPath);
    const agent = openOpenClawAgentDatabaseRuntime(options);
    const shared = openOpenClawStateDatabase({ env });

    expect(agent.path).toBe(agentPath);
    expect(shared.path).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([
      expect.objectContaining({ agentId: "main", path: agentPath }),
    ]);
  });

  it("distinguishes absent, unowned and unsupported read-only databases", () => {
    const stateDir = createTempStateDir();
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    const databasePath = resolveOpenClawAgentSqlitePath(options);

    expect(withOpenClawAgentDatabaseReadOnly(() => "unused", options)).toEqual({
      found: false,
      reason: "database-missing",
    });
    expect(fs.existsSync(databasePath)).toBe(false);

    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const empty = new DatabaseSync(databasePath);
    empty.close();
    expect(withOpenClawAgentDatabaseReadOnly(() => "unused", options)).toEqual({
      found: false,
      reason: "schema-missing",
    });

    fs.copyFileSync(databasePath, `${databasePath}.replacement`);
    fs.renameSync(`${databasePath}.replacement`, databasePath);
    const unsupported = new DatabaseSync(databasePath);
    try {
      unsupported.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
    } finally {
      unsupported.close();
    }
    expect(() => withOpenClawAgentDatabaseReadOnly(() => "unused", options)).toThrow(
      `newer schema version ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`,
    );
  });

  it("opens extension-capable reads separately from the owner without enabling writes", () => {
    const stateDir = createTempStateDir();
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    const owner = openOpenClawAgentDatabase(options);

    const result = withOpenClawAgentDatabaseReadOnly(
      ({ db }) => {
        expect(db).not.toBe(owner.db);
        expect(() => db.enableLoadExtension(true)).not.toThrow();
        expect(() => db.prepare("DELETE FROM auth_profile_store").run()).toThrow(/readonly/iu);
        return db.prepare("SELECT agent_id FROM schema_meta WHERE meta_key = 'primary'").get();
      },
      options,
      { allowExtension: true },
    );

    expect(result).toEqual({ found: true, value: { agent_id: "worker-1" } });
  });

  it("rotates the registry token on pathname switches and committed writes", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const otherEnv = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const databasePath = path.join(
      stateDir,
      "agents",
      "worker-1",
      "agent",
      "openclaw-agent.sqlite",
    );

    const firstToken = readOpenClawAgentDatabaseRegistryToken({ env });
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
    expect(readOpenClawAgentDatabaseRegistryToken({ env })).toBe(firstToken);
    expect(readOpenClawAgentDatabaseRegistryToken({ env: otherEnv })).not.toBe(firstToken);
    const returnedToken = readOpenClawAgentDatabaseRegistryToken({ env });
    expect(returnedToken).not.toBe(firstToken);

    registerOpenClawAgentDatabase({ agentId: "worker-1", path: databasePath, env });
    const registeredToken = readOpenClawAgentDatabaseRegistryToken({ env });
    expect(registeredToken).not.toBe(returnedToken);
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([
      expect.objectContaining({ agentId: "worker-1", path: databasePath }),
    ]);
    expect(readOpenClawAgentDatabaseRegistryToken({ env })).toBe(registeredToken);

    unregisterOpenClawAgentDatabase({ agentId: "worker-1", path: databasePath, env });
    expect(readOpenClawAgentDatabaseRegistryToken({ env })).not.toBe(registeredToken);
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
  });

  it("stores state-owned registrations relative while preserving external paths", () => {
    const stateDir = createTempStateDir();
    const externalStateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const inRootPath = path.join(stateDir, "agents", "worker-1", "agent", "openclaw-agent.sqlite");
    const externalPath = path.join(externalStateDir, "external.sqlite");

    registerOpenClawAgentDatabase({ agentId: "worker-1", path: inRootPath, env });
    registerOpenClawAgentDatabase({ agentId: "external", path: externalPath, env });

    const stateDatabase = openOpenClawStateDatabase({ env });
    expect(
      stateDatabase.db
        .prepare("SELECT agent_id, path FROM agent_databases ORDER BY agent_id")
        .all(),
    ).toEqual([
      { agent_id: "external", path: externalPath },
      {
        agent_id: "worker-1",
        path: path.join("agents", "worker-1", "agent", "openclaw-agent.sqlite"),
      },
    ]);
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([
      expect.objectContaining({ agentId: "external", path: externalPath }),
      expect.objectContaining({ agentId: "worker-1", path: inRootPath }),
    ]);

    stateDatabase.db
      .prepare(
        `INSERT INTO agent_databases (
           agent_id, path, schema_version, last_seen_at, size_bytes
         ) VALUES (?, ?, ?, 0, NULL)`,
      )
      .run("worker-1", inRootPath, OPENCLAW_AGENT_SCHEMA_VERSION);
    unregisterOpenClawAgentDatabase({ agentId: "worker-1", path: inRootPath, env });
    expect(
      stateDatabase.db
        .prepare("SELECT path FROM agent_databases WHERE agent_id = ?")
        .all("worker-1"),
    ).toEqual([]);

    unregisterOpenClawAgentDatabase({ agentId: "external", path: externalPath, env });
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
  });

  it("keeps incompatible schema versions maintenance-only", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agents", "legacy", "agent", "openclaw-agent.sqlite");
    registerOpenClawAgentDatabase({
      agentId: "legacy",
      path: databasePath,
      env,
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
    });

    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([
      expect.objectContaining({
        agentId: "legacy",
        path: databasePath,
        schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
      }),
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "fails closed when the missing registry has a dangling parent symlink",
    () => {
      const stateDir = createTempStateDir();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      fs.symlinkSync(path.join(stateDir, "missing-state"), path.join(stateDir, "state"), "dir");

      expect(() => listOpenClawRegisteredAgentDatabases({ env })).toThrow("is unavailable");
    },
  );

  it("migrates v13 session entries, routes, and generations into nodes and windows", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeV13WorkerAgentDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      INSERT INTO sessions (session_id, session_key, created_at, updated_at)
      VALUES
        ('window-old', 'agent:worker-1:rich', 10, 20),
        ('window-current', 'agent:worker-1:rich', 30, 40),
        ('window-created-by', 'agent:worker-1:created-by', 50, 60),
        ('window-transcript-only', 'agent:worker-1:transcript-only', 70, 80);
      INSERT INTO session_routes (session_key, session_id, updated_at)
      VALUES
        ('agent:worker-1:rich', 'window-current', 40),
        ('agent:worker-1:created-by', 'window-created-by', 60),
        ('agent:worker-1:transcript-only', 'window-transcript-only', 80);
      INSERT INTO session_entries (session_key, session_id, entry_json, updated_at, status)
      VALUES (
        'agent:worker-1:rich',
        'window-current',
        '{"sessionId":"window-current","updatedAt":40,"status":"done","createdAt":11,"createdVia":"spawn","createdActor":{"type":"agent","id":"agent:worker-1:parent"},"spawnedBy":"agent:worker-1:parent","forkSource":{"sessionKey":"agent:worker-1:source","sessionId":"source-window","entryId":"source-entry"},"label":"Rich label","displayName":"Rich display","category":"work","icon":"hammer","pinnedAt":12,"archivedAt":13,"lastReadAt":14,"lastInteractionAt":15,"lastActivityAt":16,"previousSessionId":"window-old"}',
        40,
        'done'
      ), (
        'agent:worker-1:created-by',
        'window-created-by',
        '{"sessionId":"window-created-by","updatedAt":60,"createdBy":{"id":"legacy-human","label":"Legacy"}}',
        60,
        NULL
      ), (
        'agent:worker-1:newer-alias',
        'window-current',
        '{"sessionId":"window-current","updatedAt":100,"previousSessionId":"wrong-window"}',
        100,
        NULL
      );
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES
        ('window-old', 0, '{"type":"session","id":"window-old"}', 10),
        ('window-current', 0, '{"type":"session","id":"window-current"}', 30),
        ('window-transcript-only', 0, '{"type":"session","id":"window-transcript-only"}', 70);
      INSERT INTO session_transcript_generations (session_id, generation, updated_at)
      VALUES ('window-current', 'rewrite-token', 40);
      INSERT INTO session_transcript_index_state (
        session_id, indexed_seq, leaf_event_id, needs_rebuild,
        active_event_count, active_message_count, updated_at
      ) VALUES ('window-current', 0, NULL, 0, 1, 0, 40);
      INSERT INTO heartbeat_outcomes (
        session_key, run_session_key, outcome, summary, occurred_at, updated_at
      ) VALUES (
        'agent:worker-1:rich', 'agent:worker-1:rich', 'done', 'complete', 40, 40
      );
      INSERT INTO session_members (session_key, identity_id, added_by, added_at)
      VALUES ('agent:worker-1:rich', 'member-1', 'owner-1', 40);
      INSERT INTO board_tabs (
        session_key, tab_id, title, position, chat_dock, created_by, revision
      ) VALUES ('agent:worker-1:rich', 'main', 'Main', 0, 'right', 'user', 1);
      INSERT INTO board_widgets (
        session_key, name, tab_id, content_kind, html, sha256, view_generation,
        revision, size_w, size_h, position, created_by, created_at, updated_at
      ) VALUES (
        'agent:worker-1:rich', 'summary', 'main', 'html', X'3C703E6F6B3C2F703E',
        'hash', 'view-1', 1, 4, 4, 0, 'user', 40, 40
      );
      PRAGMA user_version = 13;
      UPDATE schema_meta SET schema_version = 13 WHERE meta_key = 'primary';
    `);
    legacy.close();

    const migrated = await migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "worker-1", env });
    expect(
      migrated.db
        .prepare(
          `SELECT
             current_session_id, created_at, created_via, created_actor_type,
             created_actor_id, parent_session_key, spawned_by,
             fork_source_session_key, fork_source_session_id, fork_source_entry_id,
             label, display_name, category, icon, pinned_at, archived_at,
             last_read_at, last_interaction_at, last_activity_at, status
           FROM session_nodes WHERE session_key = 'agent:worker-1:rich'`,
        )
        .get(),
    ).toEqual({
      current_session_id: "window-current",
      created_at: 11,
      created_via: "spawn",
      created_actor_type: "agent",
      created_actor_id: "agent:worker-1:parent",
      parent_session_key: "agent:worker-1:parent",
      spawned_by: "agent:worker-1:parent",
      fork_source_session_key: "agent:worker-1:source",
      fork_source_session_id: "source-window",
      fork_source_entry_id: "source-entry",
      label: "Rich label",
      display_name: "Rich display",
      category: "work",
      icon: null,
      pinned_at: 12,
      archived_at: 13,
      last_read_at: 14,
      last_interaction_at: 15,
      last_activity_at: 16,
      status: "done",
    });
    expect(
      migrated.db
        .prepare(
          "SELECT created_actor_type, created_actor_id FROM session_nodes WHERE session_key = ?",
        )
        .get("agent:worker-1:created-by"),
    ).toEqual({ created_actor_type: "human", created_actor_id: "legacy-human" });
    expect(
      migrated.db
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get("agent:worker-1:transcript-only"),
    ).toEqual({ entry_json: "{}" });
    expect(
      migrated.db
        .prepare(
          "SELECT session_id, session_key, previous_session_id, reason FROM session_windows ORDER BY session_id",
        )
        .all(),
    ).toEqual([
      {
        session_id: "window-created-by",
        session_key: "agent:worker-1:created-by",
        previous_session_id: null,
        reason: null,
      },
      {
        session_id: "window-current",
        session_key: "agent:worker-1:rich",
        previous_session_id: "window-old",
        reason: null,
      },
      {
        session_id: "window-old",
        session_key: "agent:worker-1:rich",
        previous_session_id: null,
        reason: null,
      },
      {
        session_id: "window-transcript-only",
        session_key: "agent:worker-1:transcript-only",
        previous_session_id: null,
        reason: null,
      },
    ]);
    expect(
      migrated.db
        .prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
        .get("window-current"),
    ).toEqual({ generation: "rewrite-token" });
    expect(
      migrated.db
        .prepare("SELECT identity_id, added_by FROM session_members WHERE session_key = ?")
        .get("agent:worker-1:rich"),
    ).toEqual({ identity_id: "member-1", added_by: "owner-1" });
    expect(
      migrated.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('session_entries', 'session_routes', 'session_transcript_generations')",
        )
        .all(),
    ).toEqual([]);
    expect(migrated.db.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);

    migrated.db
      .prepare("DELETE FROM session_nodes WHERE session_key = ?")
      .run("agent:worker-1:rich");
    for (const table of [
      "session_windows",
      "transcript_events",
      "transcript_rewrite_watermarks",
      "session_transcript_index_state",
      "session_members",
      "heartbeat_outcomes",
      "board_tabs",
      "board_widgets",
    ]) {
      expect(migrated.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({
        count: table === "session_windows" ? 2 : table === "transcript_events" ? 1 : 0,
      });
    }
  });

  it("retires tenant-free lease storage when upgrading version 16", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeV21WorkerAgentDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    removeCanonicalValidationFromHistoricalAgentFixture(legacy);
    legacy.exec(`
      CREATE TABLE state_leases (
        scope TEXT NOT NULL,
        lease_key TEXT NOT NULL,
        owner TEXT NOT NULL,
        expires_at INTEGER,
        heartbeat_at INTEGER,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, lease_key)
      ) STRICT;
      CREATE INDEX idx_agent_state_leases_expiry
        ON state_leases(expires_at, scope, lease_key)
        WHERE expires_at IS NOT NULL;
      CREATE INDEX idx_agent_state_leases_owner
        ON state_leases(owner, updated_at DESC);
      INSERT INTO state_leases (
        scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at
      ) VALUES ('retired', 'orphan', 'nobody', NULL, NULL, NULL, 1, 1);
      DROP TABLE session_participants;
      PRAGMA user_version = 16;
      UPDATE schema_meta SET schema_version = 16 WHERE meta_key = 'primary';
    `);
    legacy.close();

    const migrated = await migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "worker-1", env });
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
    expect(
      migrated.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('state_leases', 'idx_agent_state_leases_expiry', 'idx_agent_state_leases_owner')",
        )
        .all(),
    ).toEqual([]);
  });

  it.each([
    {
      table: "trajectory_runtime_events",
      schema: `CREATE TABLE trajectory_runtime_events (
        event_id INTEGER NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO trajectory_runtime_events VALUES
        (1, 'legacy-session', 'run-1', 1, '{"type":"runtime"}', 20);`,
    },
  ])("refuses pre-July $table without discarding its rows", async ({ table, schema }) => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeV13WorkerAgentDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      INSERT INTO sessions (session_id, session_key, created_at, updated_at)
      VALUES ('legacy-session', 'agent:worker-1:legacy-session', 10, 20);
      DROP TABLE ${table};
      ${schema}
      PRAGMA user_version = 9;
      UPDATE schema_meta SET schema_version = 9 WHERE meta_key = 'primary';
    `);
    const originalRows = legacy.prepare(`SELECT * FROM ${table}`).all();
    const originalSchema = legacy
      .prepare("SELECT sql FROM sqlite_schema WHERE name = ?")
      .get(table);
    legacy.close();

    await expect(
      migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "worker-1", env }),
    ).rejects.toThrow("Upgrades from pre-July-2026 state are no longer migrated");

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(preserved.prepare(`SELECT * FROM ${table}`).all()).toEqual(originalRows);
      expect(preserved.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(table)).toEqual(
        originalSchema,
      );
      expect(readSqliteNumberPragma(preserved, "user_version")).toBe(9);
      expect(
        preserved
          .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: 9 });
    } finally {
      preserved.close();
    }
  });

  it.each([{ version: 1, searchCache: "none" }])(
    "refuses unreleased version $version session tables with $searchCache cache without changing the database",
    ({ version, searchCache }) => {
      const stateDir = createTempStateDir();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "worker-1", env });
      seedVersion1MemoryAgentDatabase(databasePath);
      const { DatabaseSync } = requireNodeSqlite();
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO sessions VALUES ('retained-session', 'agent:worker-1:main', 1, 2);
        PRAGMA user_version = ${version};
        UPDATE schema_meta SET schema_version = ${version} WHERE meta_key = 'primary';
      `);
        if (searchCache === "files") {
          database.exec("CREATE TABLE session_transcript_files (session_key TEXT, mtime INTEGER);");
        } else if (searchCache === "fts") {
          database.exec(
            "CREATE VIRTUAL TABLE session_transcript_fts USING fts5(text, session_key UNINDEXED);",
          );
        }
      } finally {
        database.close();
      }
      const before = fs.readFileSync(databasePath);
      const candidate = new DatabaseSync(databasePath);
      try {
        expect(() =>
          ensureOpenClawAgentDatabaseSchema(candidate, { agentId: "worker-1", env }),
        ).toThrow(`contains an unreleased session schema (version ${version})`);
        expect(candidate.prepare("SELECT * FROM sessions").all()).toEqual([
          {
            session_id: "retained-session",
            session_key: "agent:worker-1:main",
            created_at: 1,
            updated_at: 2,
          },
        ]);
        expect(readSqliteNumberPragma(candidate, "user_version")).toBe(version);
      } finally {
        candidate.close();
      }
      expect(fs.readFileSync(databasePath)).toEqual(before);
      expect(fs.existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
    },
  );

  it("migrates version 8 tables to STRICT without losing agent state", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeV21WorkerAgentDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy
      .prepare(
        "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("last-good", '{"profile":"primary"}', 10);
    legacy.exec(`
      ALTER TABLE auth_profile_state RENAME TO auth_profile_state_strict;
      CREATE TABLE auth_profile_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO auth_profile_state SELECT * FROM auth_profile_state_strict;
      DROP TABLE auth_profile_state_strict;
      DROP TRIGGER memory_index_sources_revision_after_insert;
      DROP TRIGGER memory_index_sources_revision_after_update;
      DROP TRIGGER memory_index_sources_revision_after_delete;
      ALTER TABLE memory_index_sources RENAME TO memory_index_sources_strict;
      CREATE TABLE memory_index_sources (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        UNIQUE (path, source)
      );
      INSERT INTO memory_index_sources SELECT * FROM memory_index_sources_strict;
      DROP TABLE memory_index_sources_strict;
      INSERT INTO memory_index_sources (path, source, hash, mtime, size)
      VALUES ('MEMORY.md', 'memory', 'legacy-hash', 10.75, 20);
      DROP TABLE session_transcript_active_events;
      ALTER TABLE session_transcript_index_state DROP COLUMN active_event_count;
      ALTER TABLE session_transcript_index_state DROP COLUMN active_message_count;
      DROP TABLE session_participants;
      PRAGMA user_version = 8;
      UPDATE schema_meta SET schema_version = 8 WHERE meta_key = 'primary';
    `);
    legacy.close();

    const migrated = await migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "worker-1", env });
    expect(
      migrated.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'auth_profile_state'")
        .get(),
    ).toEqual({ strict: 1 });
    expect(migrated.db.prepare("SELECT * FROM auth_profile_state").get()).toEqual({
      state_key: "last-good",
      state_json: '{"profile":"primary"}',
      updated_at: 10,
    });
    expect(
      migrated.db
        .prepare("SELECT mtime, typeof(mtime) AS storage_type FROM memory_index_sources")
        .get(),
    ).toEqual({ mtime: 10.75, storage_type: "real" });
    expect(
      migrated.db
        .prepare(
          "SELECT strict FROM pragma_table_list WHERE name = 'session_transcript_active_events'",
        )
        .get(),
    ).toEqual({ strict: 1 });
    expect(
      migrated.db
        .prepare("PRAGMA table_info(session_transcript_index_state)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toEqual(expect.arrayContaining(["active_event_count", "active_message_count"]));
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
    expect(migrated.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("retains a failed-open handle and lease when initialization cleanup also fails", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
    const { DatabaseSync } = requireNodeSqlite();
    const closeDatabase: unknown = Object.getOwnPropertyDescriptor(
      DatabaseSync.prototype,
      "close",
    )?.value;
    if (typeof closeDatabase !== "function") {
      throw new Error("Missing original SQLite close implementation");
    }
    let failedClose = false;
    const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (
      this: DatabaseSync,
    ) {
      // Fail the agent handle's cleanup, not a shared-state coordinator close.
      if (!failedClose && this.location() === database.path) {
        failedClose = true;
        throw new Error("initialization close failed");
      }
      return Reflect.apply(closeDatabase, this, []);
    });

    expect(() =>
      openOpenClawAgentDatabase({ agentId: "worker-2", env, path: database.path }),
    ).toThrow("initialization close failed");
    close.mockRestore();
    expect(inspectOpenClawAgentDatabaseOwner(database.path)).toEqual({
      status: "owned",
      agentId: "worker-1",
    });
    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-2", { env })).toThrow(
      "database is still open",
    );
    expect(() =>
      openOpenClawAgentDatabase({ agentId: "worker-2", env, path: database.path }),
    ).toThrow("initialization close failed");

    expect(
      withOpenClawAgentDatabaseReadOnly(
        ({ db }) => db.prepare("SELECT agent_id FROM schema_meta WHERE meta_key = 'primary'").get(),
        { agentId: "worker-1", env, path: database.path },
      ),
    ).toEqual({ found: true, value: { agent_id: "worker-1" } });
    expect(() =>
      withOpenClawAgentDatabaseReadOnly(() => "unused", {
        agentId: "worker-2",
        env,
        path: database.path,
      }),
    ).toThrow("belongs to agent worker-1; requested agent worker-2");

    expect(await disposeOpenClawAgentDatabaseByPath(database.path, { env })).toBe(true);
    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-2", { env })).not.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "reuses successful identities only within one path matcher",
    () => {
      const stateDir = fs.realpathSync(createTempStateDir());
      const realDir = path.join(stateDir, "cached-real");
      const aliasDir = path.join(stateDir, "cached-alias");
      const otherDir = path.join(stateDir, "cached-other");
      fs.mkdirSync(realDir, { recursive: true });
      fs.mkdirSync(otherDir);
      fs.symlinkSync(realDir, aliasDir, "dir");
      const realPath = path.join(realDir, "worker.sqlite");
      const aliasPath = path.join(aliasDir, "worker.sqlite");
      fs.writeFileSync(realPath, "live");

      const realpathNative = vi.spyOn(fs.realpathSync, "native");
      try {
        const matchesPath = createOpenClawAgentDatabasePathMatcher();
        expect(matchesPath(realPath, aliasPath)).toBe(true);
        expect(matchesPath(aliasPath, realPath)).toBe(true);
        const resolvedLocators = realpathNative.mock.calls.flatMap(([pathname]) =>
          pathname === realPath || pathname === aliasPath ? [pathname] : [],
        );
        expect(resolvedLocators.toSorted()).toEqual([aliasPath, realPath].toSorted());
      } finally {
        realpathNative.mockRestore();
      }

      fs.unlinkSync(aliasDir);
      fs.symlinkSync(otherDir, aliasDir, "dir");
      expect(createOpenClawAgentDatabasePathMatcher()(realPath, aliasPath)).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps an existing alias identity consistent when realpath retargets it",
    () => {
      const stateDir = fs.realpathSync(createTempStateDir());
      const firstDir = path.join(stateDir, "identity-first");
      const secondDir = path.join(stateDir, "identity-second");
      const aliasDir = path.join(stateDir, "identity-alias");
      fs.mkdirSync(firstDir);
      fs.mkdirSync(secondDir);
      fs.symlinkSync(firstDir, aliasDir, "dir");
      const firstPath = path.join(firstDir, "worker.sqlite");
      const secondPath = path.join(secondDir, "worker.sqlite");
      const aliasPath = path.join(aliasDir, "worker.sqlite");
      fs.writeFileSync(firstPath, "first");
      fs.writeFileSync(secondPath, "second");

      const originalRealpathNative = fs.realpathSync.native;
      let retargeted = false;
      const realpathNative = vi.spyOn(fs.realpathSync, "native").mockImplementation((pathname) => {
        if (!retargeted && path.resolve(String(pathname)) === aliasPath) {
          fs.unlinkSync(aliasDir);
          fs.symlinkSync(secondDir, aliasDir, "dir");
          retargeted = true;
        }
        return originalRealpathNative(pathname);
      });
      try {
        const matchesPath = createOpenClawAgentDatabasePathMatcher();
        expect(matchesPath(aliasPath, firstPath)).toBe(false);
        expect(matchesPath(aliasPath, secondPath)).toBe(true);
        expect(retargeted).toBe(true);
      } finally {
        realpathNative.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a missing-leaf identity consistent when its parent retargets",
    () => {
      const stateDir = fs.realpathSync(createTempStateDir());
      const firstParent = path.join(stateDir, "missing-first");
      const movedFirstParent = path.join(stateDir, "missing-first-moved");
      const secondParent = path.join(stateDir, "missing-second");
      fs.mkdirSync(firstParent);
      fs.mkdirSync(secondParent);
      const racedPath = path.join(firstParent, "future.sqlite");
      const movedFirstPath = path.join(movedFirstParent, "future.sqlite");
      const secondPath = path.join(secondParent, "future.sqlite");

      const originalLstatSync = fs.lstatSync;
      let retargeted = false;
      const lstatSync = vi.spyOn(fs, "lstatSync").mockImplementation((pathname, options) => {
        if (!retargeted && path.resolve(String(pathname)) === racedPath) {
          fs.renameSync(firstParent, movedFirstParent);
          fs.symlinkSync(secondParent, firstParent, "dir");
          retargeted = true;
        }
        return originalLstatSync(pathname, options as never);
      });
      try {
        const matchesPath = createOpenClawAgentDatabasePathMatcher();
        expect(matchesPath(racedPath, movedFirstPath)).toBe(false);
        expect(matchesPath(racedPath, secondPath)).toBe(true);
        expect(retargeted).toBe(true);
      } finally {
        lstatSync.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "resolves registered owners through symlinked database paths",
    () => {
      const stateDir = fs.realpathSync(createTempStateDir());
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const realDir = path.join(stateDir, "real-databases");
      const aliasDir = path.join(stateDir, "alias-databases");
      fs.mkdirSync(realDir, { recursive: true });
      fs.symlinkSync(realDir, aliasDir, "dir");
      const realPath = path.join(realDir, "worker.sqlite");
      const aliasPath = path.join(aliasDir, "worker.sqlite");
      expect(fs.existsSync(realPath)).toBe(false);
      expect(isSameOpenClawAgentDatabasePath(realPath, aliasPath)).toBe(true);
      const futureRealPath = path.join(realDir, "future-worker.sqlite");
      const danglingAliasPath = path.join(stateDir, "future-worker-alias.sqlite");
      fs.symlinkSync(futureRealPath, danglingAliasPath);
      expect(isSameOpenClawAgentDatabasePath(futureRealPath, danglingAliasPath)).toBe(true);
      const deepDir = path.join(realDir, "deep");
      const deepAliasDir = path.join(stateDir, "deep-alias");
      fs.mkdirSync(deepDir);
      fs.symlinkSync(deepDir, deepAliasDir, "dir");
      const relativeAliasPath = path.join(deepAliasDir, "relative-worker.sqlite");
      const relativeRealPath = path.join(realDir, "relative-worker.sqlite");
      fs.symlinkSync("../relative-worker.sqlite", relativeAliasPath);
      expect(isSameOpenClawAgentDatabasePath(relativeRealPath, relativeAliasPath)).toBe(true);
      const redirectedDir = path.join(stateDir, "redirected-databases");
      const redirectedNestedDir = path.join(redirectedDir, "nested");
      const redirectLink = path.join(stateDir, "redirect-link");
      fs.mkdirSync(redirectedNestedDir, { recursive: true });
      fs.symlinkSync(redirectedNestedDir, redirectLink, "dir");
      const redirectedRealPath = path.join(redirectedDir, "redirected-worker.sqlite");
      const redirectedAliasPath = path.join(stateDir, "redirected-worker-alias.sqlite");
      fs.symlinkSync("redirect-link/../redirected-worker.sqlite", redirectedAliasPath);
      expect(isSameOpenClawAgentDatabasePath(redirectedRealPath, redirectedAliasPath)).toBe(true);
      expect(
        isSameOpenClawAgentDatabasePath(
          path.join(stateDir, "redirected-worker.sqlite"),
          redirectedAliasPath,
        ),
      ).toBe(false);
      const livePath = path.join(stateDir, "live-worker.sqlite");
      fs.writeFileSync(livePath, "live");
      const danglingTraversalAlias = path.join(stateDir, "dangling-traversal.sqlite");
      fs.symlinkSync("missing/../live-worker.sqlite", danglingTraversalAlias);
      expect(isSameOpenClawAgentDatabasePath(danglingTraversalAlias, livePath)).toBe(false);
      const rawMissingTraversalPath = `${stateDir}${path.sep}missing${path.sep}..${path.sep}live-worker.sqlite`;
      expect(isSameOpenClawAgentDatabasePath(rawMissingTraversalPath, livePath)).toBe(false);
      const symlinkParentTarget = path.join(stateDir, "other", "nested");
      fs.mkdirSync(symlinkParentTarget, { recursive: true });
      const symlinkParent = path.join(stateDir, "parent-link");
      fs.symlinkSync(symlinkParentTarget, symlinkParent, "dir");
      const rawSymlinkParentTraversal = `${symlinkParent}${path.sep}..${path.sep}parent-owned.sqlite`;
      expect(
        isSameOpenClawAgentDatabasePath(
          rawSymlinkParentTraversal,
          path.join(stateDir, "other", "parent-owned.sqlite"),
        ),
      ).toBe(true);
      expect(
        isSameOpenClawAgentDatabasePath(
          rawSymlinkParentTraversal,
          path.join(stateDir, "parent-owned.sqlite"),
        ),
      ).toBe(false);
      const loopPath = path.join(stateDir, "database-loop.sqlite");
      fs.symlinkSync(loopPath, loopPath);
      expect(() => isSameOpenClawAgentDatabasePath(loopPath, realPath)).toThrow(
        expect.objectContaining({ code: "ELOOP" }),
      );
      const expandingLoopPath = path.join(stateDir, "expanding-database-loop.sqlite");
      fs.symlinkSync("expanding-database-loop.sqlite/child", expandingLoopPath);
      expect(() => isSameOpenClawAgentDatabasePath(expandingLoopPath, realPath)).toThrow(
        expect.objectContaining({ code: "ELOOP" }),
      );
      const repeatedLinkDir = path.join(stateDir, "repeated-link-dir");
      fs.mkdirSync(repeatedLinkDir);
      fs.symlinkSync(".", path.join(repeatedLinkDir, "self"), "dir");
      expect(
        isSameOpenClawAgentDatabasePath(
          path.join(repeatedLinkDir, "repeated.sqlite"),
          path.join(repeatedLinkDir, "self", "self", "repeated.sqlite"),
        ),
      ).toBe(true);
      const rewrittenLinkDir = path.join(stateDir, "rewritten-link-dir");
      fs.mkdirSync(path.join(rewrittenLinkDir, "K"), { recursive: true });
      fs.symlinkSync(".", path.join(rewrittenLinkDir, "L"), "dir");
      fs.symlinkSync("L/K", path.join(rewrittenLinkDir, "J"));
      expect(
        isSameOpenClawAgentDatabasePath(
          path.join(rewrittenLinkDir, "K", "db.sqlite"),
          path.join(rewrittenLinkDir, "L", "J", "db.sqlite"),
        ),
      ).toBe(true);
      const database = openOpenClawAgentDatabase({ agentId: "worker", env, path: realPath });
      unregisterOpenClawAgentDatabase({ agentId: "worker", env, path: database.path });
      registerOpenClawAgentDatabase({ agentId: "worker", env, path: aliasPath });
    },
  );

  it.each([
    { kind: "unrelated Unicode spellings", left: "猫.sqlite", right: "犬.sqlite" },
    {
      kind: "JavaScript case-fold expansion",
      left: "İ.sqlite",
      right: "i\u0307.sqlite",
    },
  ] as const)("respects $kind when comparing missing paths", ({ left, right }) => {
    const stateDir = fs.realpathSync(createTempStateDir());
    expect(
      isSameOpenClawAgentDatabasePath(path.join(stateDir, left), path.join(stateDir, right)),
    ).toBe(false);
  });

  it.runIf(tempVolumeIsCaseInsensitive)(
    "matches nested missing aliases using exact component case semantics",
    () => {
      const stateDir = fs.realpathSync(createTempStateDir());
      expect(
        isSameOpenClawAgentDatabasePath(
          path.join(stateDir, "Future", "Agent", "worker.sqlite"),
          path.join(stateDir, "future", "agent", "worker.sqlite"),
        ),
      ).toBe(true);
    },
  );

  it.runIf(tempVolumeIsNormalizationInsensitive)(
    "matches missing database leaf aliases using normalization-insensitive volume semantics",
    () => {
      const stateDir = fs.realpathSync(createTempStateDir());
      expect(
        isSameOpenClawAgentDatabasePath(
          path.join(stateDir, "café.sqlite"),
          path.join(stateDir, "café.sqlite"),
        ),
      ).toBe(true);
    },
  );

  it.runIf(process.platform === "win32")(
    "matches drive-relative and absolute database paths without collapsing the suffix",
    () => {
      const cwd = process.cwd();
      const drive = path.parse(cwd).root.slice(0, 2);
      const absolutePath = path.join(cwd, "future-drive-relative.sqlite");
      const driveRelativePath = `${drive}future-drive-relative.sqlite`;

      expect(isSameOpenClawAgentDatabasePath(driveRelativePath, absolutePath)).toBe(true);
    },
  );

  it("keys explicit relative paths by resolved database pathname", () => {
    const agentModuleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.agentDatabase);
    const stateModuleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase);
    const output = execFileSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(agentModuleUrl).slice(0, -1),
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          import os from "node:os";
          import path from "node:path";
          import {
            closeOpenClawAgentDatabasesForTest,
            listOpenClawRegisteredAgentDatabases,
            openOpenClawAgentDatabase,
          } from ${JSON.stringify(agentModuleUrl.href)};
          import {
            closeOpenClawStateDatabaseForTest,
          } from ${JSON.stringify(stateModuleUrl.href)};

          const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-db-state-"));
          const env = { OPENCLAW_STATE_DIR: stateDir };
          const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-db-relative-"));
          const firstDir = path.join(root, "first");
          const secondDir = path.join(root, "second");
          fs.mkdirSync(firstDir);
          fs.mkdirSync(secondDir);
          const previousCwd = process.cwd();
          try {
            process.chdir(firstDir);
            const first = openOpenClawAgentDatabase({
              agentId: "worker-1",
              env,
              path: "agent.sqlite",
            });

            process.chdir(secondDir);
            const second = openOpenClawAgentDatabase({
              agentId: "worker-1",
              env,
              path: "agent.sqlite",
            });

            console.log(JSON.stringify({
              sameHandle: first === second,
              firstFileExists: fs.existsSync(path.join(firstDir, "agent.sqlite")),
              secondFileExists: fs.existsSync(path.join(secondDir, "agent.sqlite")),
              registeredPaths: listOpenClawRegisteredAgentDatabases({ env })
                .filter((entry) => entry.agentId === "worker-1")
                .map((entry) => entry.path),
              expectedPaths: [first.path, second.path].toSorted(),
            }));
          } finally {
            process.chdir(previousCwd);
            closeOpenClawAgentDatabasesForTest();
            closeOpenClawStateDatabaseForTest();
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(stateDir, { recursive: true, force: true });
          }
        `,
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output) as {
      expectedPaths: string[];
      firstFileExists: boolean;
      registeredPaths: string[];
      sameHandle: boolean;
      secondFileExists: boolean;
    };

    expect(result.sameHandle).toBe(false);
    expect(result.firstFileExists).toBe(true);
    expect(result.secondFileExists).toBe(true);
    expect(result.registeredPaths).toEqual(result.expectedPaths);
  });

  it("rejects sharing one explicit database path across agent ids", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "relocated", "shared.sqlite");

    openOpenClawAgentDatabase({
      agentId: "worker-1",
      env,
      path: databasePath,
    });

    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-2",
        env,
        path: databasePath,
      }),
    ).toThrow(/already open for agent worker-1/);

    closeOpenClawAgentDatabasesForTest();
    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-2",
        env,
        path: databasePath,
      }),
    ).toThrow(/belongs to agent worker-1/);
  });

  it("closes only the cached database at the exact resolved path", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const firstPath = path.join(stateDir, "relocated", "first.sqlite");
    const secondPath = path.join(stateDir, "relocated", "second.sqlite");
    const first = openOpenClawAgentDatabase({ agentId: "worker-1", env, path: firstPath });
    const second = openOpenClawAgentDatabase({ agentId: "worker-2", env, path: secondPath });

    expect(closeOpenClawAgentDatabaseByPath(path.join(stateDir, "missing.sqlite"))).toBe(false);
    expect(closeOpenClawAgentDatabaseByPath(firstPath, "worker-2")).toBe(false);
    expect(first.db.isOpen).toBe(true);
    expect(second.db.isOpen).toBe(true);

    expect(
      closeOpenClawAgentDatabaseByPath(
        path.join(stateDir, "relocated", "nested", "..", "first.sqlite"),
        "worker-1",
      ),
    ).toBe(true);
    expect(first.db.isOpen).toBe(false);
    expect(second.db.isOpen).toBe(true);
    expect(closeOpenClawAgentDatabaseByPath(firstPath)).toBe(false);

    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env, path: firstPath });
    expect(reopened).not.toBe(first);
    expect(reopened.db.isOpen).toBe(true);
    expect(second.db.isOpen).toBe(true);
  });

  it("retains its durable lease when closing the handle fails", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const close = vi.spyOn(database.walMaintenance, "close").mockImplementationOnce(() => {
      throw new Error("wal close failed");
    });

    expect(() => closeOpenClawAgentDatabaseByPath(database.path)).toThrow("wal close failed");
    expect(database.db.isOpen).toBe(true);
    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).toThrow(
      "database is still open",
    );

    close.mockRestore();
    expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).not.toThrow();
  });

  it("settles a Worker lease after a recoverable handle-close failure", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    vi.spyOn(database.walMaintenance, "close").mockImplementationOnce(() => {
      throw new Error("wal close failed");
    });

    const settled = settleOpenClawAgentDatabaseWorkerClose(database.path);

    expect(settled).toMatchObject({ settled: true });
    expect(settled.errors.map((error) => error.message)).toEqual(["wal close failed"]);
    expect(database.db.isOpen).toBe(false);
    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).not.toThrow();
  });

  it("keeps the deleted id fenced until its completed tombstone is claimed", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentDir = path.join(stateDir, "agents", "worker-1", "agent");
    const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
    const deletion = beginAgentDeletionJournal(
      {
        operationId: "deletion",
        deleteFiles: true,
        agentId: "worker-1",
        agentDir,
        workspaceDir: path.join(stateDir, "workspace-worker-1"),
        sessionsDir: path.join(stateDir, "sessions-worker-1"),
      },
      { env },
    );
    runOpenClawStateWriteTransaction(
      (sharedStateDatabase) =>
        completeAgentDeletionJournalInDatabase(
          sharedStateDatabase,
          deletion.agentId,
          deletion.operationId,
        ),
      { env },
    );

    expect(() =>
      registerOpenClawAgentDatabase({ agentId: "worker-1", path: databasePath, env }),
    ).toThrow("agent worker-1 is deleted");
    expect(() =>
      registerOpenClawAgentDatabase({ agentId: "worker-2", path: databasePath, env }),
    ).not.toThrow();
    unregisterOpenClawAgentDatabase({ agentId: "worker-2", path: databasePath, env });

    expect(claimCompletedAgentDeletionJournal("worker-1", deletion.operationId, { env })).toBe(
      true,
    );
    expect(() =>
      registerOpenClawAgentDatabase({ agentId: "worker-1", path: databasePath, env }),
    ).not.toThrow();
    unregisterOpenClawAgentDatabase({ agentId: "worker-1", path: databasePath, env });
  });

  it("lets only the creating identity lease over its own completed tombstone", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentDir = path.join(stateDir, "agents", "worker-1", "agent");
    const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
    const deletion = beginAgentDeletionJournal(
      {
        operationId: "deletion",
        deleteFiles: true,
        agentId: "worker-1",
        agentDir,
        workspaceDir: path.join(stateDir, "workspace-worker-1"),
        sessionsDir: path.join(stateDir, "sessions-worker-1"),
      },
      { env },
    );
    const claimAsWorker = () =>
      claimOpenClawAgentDatabaseLease({ agentId: "worker-1", path: databasePath, env });

    // Creation never bypasses a deletion whose cleanup is still pending.
    await runWithAgentCreationClaim({ agentId: "worker-1", env }, async () => {
      expect(claimAsWorker).toThrow("agent worker-1 is deleted");
    });
    runOpenClawStateWriteTransaction(
      (sharedStateDatabase) =>
        completeAgentDeletionJournalInDatabase(
          sharedStateDatabase,
          deletion.agentId,
          deletion.operationId,
        ),
      { env },
    );

    // A completed tombstone still fences everything outside the creation lifecycle.
    expect(claimAsWorker).toThrow("agent worker-1 is deleted");
    await runWithAgentCreationClaim({ agentId: "other", env }, async () => {
      expect(claimAsWorker).toThrow("agent worker-1 is deleted");
    });
    const foreignStateEnv = { OPENCLAW_STATE_DIR: createTempStateDir() };
    await runWithAgentCreationClaim({ agentId: "worker-1", env: foreignStateEnv }, async () => {
      expect(claimAsWorker).toThrow("agent worker-1 is deleted");
    });

    await runWithAgentCreationClaim({ agentId: "worker-1", env }, async () => {
      const leaseId = claimAsWorker();
      releaseOpenClawAgentDatabaseLease(leaseId, { env });
      registerOpenClawAgentDatabase({ agentId: "worker-1", path: databasePath, env });
      unregisterOpenClawAgentDatabase({ agentId: "worker-1", path: databasePath, env });
    });
    expect(claimCompletedAgentDeletionJournal("worker-1", deletion.operationId, { env })).toBe(
      true,
    );
  });

  it("keeps creation-claimed handles private and closes them when the claim settles", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentDir = path.join(stateDir, "agents", "worker-1", "agent");
    const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
    const deletion = beginAgentDeletionJournal(
      {
        operationId: "deletion",
        deleteFiles: true,
        agentId: "worker-1",
        agentDir,
        workspaceDir: path.join(stateDir, "workspace-worker-1"),
        sessionsDir: path.join(stateDir, "sessions-worker-1"),
      },
      { env },
    );
    runOpenClawStateWriteTransaction(
      (sharedStateDatabase) =>
        completeAgentDeletionJournalInDatabase(
          sharedStateDatabase,
          deletion.agentId,
          deletion.operationId,
        ),
      { env },
    );
    const options = { agentId: "worker-1", path: databasePath, env };
    const writeMarker = (marker: string) =>
      runOpenClawAgentWriteTransaction((database) => {
        database.db
          .prepare(
            "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'memory', ?, 1, 1)",
          )
          .run(`${marker}.md`, marker);
      }, options);
    const claimAsWorker = () => claimOpenClawAgentDatabaseLease(options);
    // Ordinary writers run outside the creation scope even while it is live.
    const outsideCreation = AsyncLocalStorage.snapshot();
    const aliasStateEnv = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const aliasDir = path.join(aliasStateEnv.OPENCLAW_STATE_DIR, "agent-alias");
    const openAliasOutside = () =>
      outsideCreation(() =>
        openOpenClawAgentDatabase({
          agentId: "worker-1",
          path: path.join(aliasDir, "openclaw-agent.sqlite"),
          env: aliasStateEnv,
        }),
      );
    const settled = createDeferred();
    let retainedClaim: Promise<string> | undefined;

    await runWithAgentCreationClaim({ agentId: "worker-1", env }, async () => {
      writeMarker("inside");
      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(true);
      expect(() => outsideCreation(() => writeMarker("outside"))).toThrow(
        "active agent creation claim",
      );
      fs.symlinkSync(agentDir, aliasDir, "junction");
      expect(openAliasOutside).toThrow("active agent creation claim");
      // A continuation retained past settlement keeps this store but no authority.
      retainedClaim = settled.promise.then(claimAsWorker);
    });

    expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
    expect(claimAsWorker).toThrow("agent worker-1 is deleted");
    expect(() => writeMarker("after")).toThrow("agent worker-1 is deleted");
    settled.resolve();
    await expect(retainedClaim).rejects.toThrow("agent worker-1 is deleted");

    // Coalesced callers must keep their own authority after a shared async open.
    await runWithAgentCreationClaim({ agentId: "worker-1", env }, async () => {
      const admitted = withOpenClawAgentDatabaseAsync(options, () => "inside");
      const outside = outsideCreation(() =>
        withOpenClawAgentDatabaseAsync(options, () => "outside"),
      );
      await Promise.all([
        expect(admitted).resolves.toBe("inside"),
        expect(outside).rejects.toThrow("active agent creation claim"),
      ]);
    });
    expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);

    // Retiring a claim during a real integrity read must precede index repair, not only exposure.
    invalidateOpenClawAgentDatabaseValidation(databasePath);
    revokeSqliteDatabaseAdmissionsForPath(databasePath);
    const editor = nodeSqlite.openNodeSqliteDatabase(databasePath);
    try {
      editor.exec("DROP INDEX idx_agent_cache_expiry");
    } finally {
      editor.close();
    }
    const checked = createDeferred();
    const resume = createDeferred();
    const releaseReceipt = createDeferred();
    const closeStarted = createDeferred();
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    const checkSpy = vi
      .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
      .mockImplementation(async (...args) => {
        await check(...args);
        const signal = args[2];
        if (!signal) {
          throw new Error("Native admission did not supply its cancellation signal");
        }
        const onAbort = () => closeStarted.resolve();
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
        checked.resolve();
        try {
          await resume.promise;
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      });
    let rejected: Promise<unknown> | undefined;
    let operationCalled = false;
    const retiring = runWithAgentCreationClaim({ agentId: "worker-1", env }, async () => {
      rejected = expect(
        withOpenClawAgentDatabaseAsync(options, () => {
          operationCalled = true;
        }),
      ).rejects.toThrow();
      await releaseReceipt.promise;
    });
    try {
      await checked.promise;
      expect(openAliasOutside).toThrow("active agent creation claim");
      releaseReceipt.resolve();
      await closeStarted.promise;
      expect(openAliasOutside).toThrow("active agent creation claim");
      expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).toThrow(
        "database is still open",
      );
    } finally {
      releaseReceipt.resolve();
      resume.resolve();
      try {
        await retiring;
        await rejected;
      } finally {
        checkSpy.mockRestore();
      }
    }
    const reader = nodeSqlite.openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(
        reader.prepare("SELECT name FROM sqlite_schema WHERE name='idx_agent_cache_expiry'").get(),
      ).toBeUndefined();
    } finally {
      reader.close();
    }
    expect(operationCalled).toBe(false);
    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).not.toThrow();

    // A fresh claim can repair the index and write, then still close if its body fails.
    await expect(
      runWithAgentCreationClaim({ agentId: "worker-1", env }, async () => {
        writeMarker("failed");
        throw new Error("creation failed");
      }),
    ).rejects.toThrow("creation failed");
    expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
    expect(() => writeMarker("after-failure")).toThrow("agent worker-1 is deleted");

    expect(claimCompletedAgentDeletionJournal("worker-1", deletion.operationId, { env })).toBe(
      true,
    );
    writeMarker("published");
    expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(true);
  });

  it("serializes database leases with the durable deletion fence", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agents", "worker-1", "openclaw-agent.sqlite");
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "worker-1",
      path: databasePath,
      env,
    });
    const deletion = beginAgentDeletionJournal(
      {
        operationId: "deletion",
        deleteFiles: true,
        agentId: "worker-1",
        agentDir: path.dirname(databasePath),
        workspaceDir: path.join(stateDir, "workspace-worker-1"),
        sessionsDir: path.join(stateDir, "sessions-worker-1"),
      },
      { env },
    );
    try {
      expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).toThrow(
        "database is still open",
      );
      expect(() =>
        claimOpenClawAgentDatabaseLease({ agentId: "worker-1", path: databasePath, env }),
      ).toThrow("agent worker-1 is deleted");
      releaseOpenClawAgentDatabaseLease(leaseId, { env });
      expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).not.toThrow();
    } finally {
      releaseOpenClawAgentDatabaseLease(leaseId, { env });
      removeAgentDeletionJournal(deletion.agentId, deletion.operationId, { env });
    }
  });

  it("closes cached agent databases and fences new writers during maintenance", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    let assertRetainedOwnership: (() => void) | undefined;

    await withAgentDatabaseMaintenanceLease({ env }, async (maintenance) => {
      assertRetainedOwnership = () => maintenance.assertOwned();
      expect(database.db.isOpen).toBe(false);
      expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
        "Agent database maintenance is in progress",
      );
      expect(() =>
        claimOpenClawAgentDatabaseLease({
          agentId: "worker-2",
          path: path.join(stateDir, "worker-2.sqlite"),
          env,
        }),
      ).toThrow("Agent database maintenance is in progress");
      expect(() =>
        runOpenClawStateWriteTransaction(({ db }) => maintenance.assertOwnedInTransaction(db), {
          env,
        }),
      ).not.toThrow();
    });

    expect(assertRetainedOwnership).toBeDefined();
    expect(() => assertRetainedOwnership?.()).toThrow("Agent database maintenance scope is closed");
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("refuses maintenance while another owner still holds an agent database lease", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "worker-1",
      path: path.join(stateDir, "worker-1.sqlite"),
      env,
    });
    const repair = vi.fn(async () => undefined);

    try {
      await expect(withAgentDatabaseMaintenanceLease({ env }, repair)).rejects.toThrow(
        "stop that process and rerun openclaw doctor --fix",
      );
      expect(repair).not.toHaveBeenCalled();
      expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).toThrow(
        "database is still open",
      );
    } finally {
      releaseOpenClawAgentDatabaseLease(leaseId, { env });
    }

    await expect(withAgentDatabaseMaintenanceLease({ env }, repair)).resolves.toBeUndefined();
    expect(repair).toHaveBeenCalledOnce();
  });

  it("removes dead agent database owners before beginning fenced maintenance", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "worker-1",
      path: path.join(stateDir, "worker-1.sqlite"),
      env,
    });
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        db
          .prepare("UPDATE agent_database_leases SET owner_pid = -1 WHERE lease_id = ?")
          .run(leaseId),
      { env },
    );

    await withAgentDatabaseMaintenanceLease({ env }, async () => {
      expect(
        openOpenClawStateDatabase({ env })
          .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
          .get(leaseId),
      ).toBeUndefined();
    });
  });

  it("serializes concurrent ownership claims for one unowned database", async () => {
    const stateDir = createTempStateDir();
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const databasePath = path.join(stateDir, "relocated", "shared.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const lockDb = new DatabaseSync(databasePath);
    lockDb.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
    const openers = [
      launchAgentSchemaOpener({ agentId: "worker-a", databasePath, stateDir }),
      launchAgentSchemaOpener({ agentId: "worker-b", databasePath, stateDir }),
    ];
    const completions = Promise.allSettled(
      openers.flatMap(({ ready, beginAttempt, result }) => [ready, beginAttempt, result]),
    );
    try {
      await Promise.all(openers.map((opener) => opener.ready));
      for (const opener of openers) {
        opener.child.stdin.end("go\n");
      }
      await Promise.race(openers.map((opener) => opener.beginAttempt));
      lockDb.exec("COMMIT;");
      lockDb.close();

      const results = await Promise.all(openers.map((opener) => opener.result));
      const winner = results.find((result) => result.ok);
      const loser = results.find((result) => !result.ok);
      expect(winner).toBeDefined();
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(loser?.error).toContain(`belongs to agent ${winner?.agentId}`);
      expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual({
        status: "owned",
        agentId: winner?.agentId,
      });
      expect(
        listOpenClawRegisteredAgentDatabases({ env: { OPENCLAW_STATE_DIR: stateDir } }),
      ).toEqual([
        expect.objectContaining({
          agentId: winner?.agentId,
          path: databasePath,
          schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        }),
      ]);
    } finally {
      if (lockDb.isOpen) {
        lockDb.close();
      }
      for (const opener of openers) {
        if (opener.child.exitCode === null) {
          opener.child.kill();
        }
      }
      await completions;
    }
  });

  it("rechecks schema version after waiting for a concurrent writer", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const state = openOpenClawStateDatabase({ env });
    const databasePath = path.join(stateDir, "relocated", "future.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const lockDb = new DatabaseSync(databasePath);
    lockDb.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
    const opener = launchAgentSchemaOpener({
      agentId: "worker-a",
      databasePath,
      stateDir,
    });
    const futureVersion = OPENCLAW_AGENT_SCHEMA_VERSION + 1;
    try {
      await opener.ready;
      opener.child.stdin.end("go\n");
      await opener.beginAttempt;
      lockDb.exec(`PRAGMA user_version = ${futureVersion}; COMMIT;`);
      lockDb.close();

      await expect(opener.result).resolves.toMatchObject({
        agentId: "worker-a",
        ok: false,
        error: expect.stringContaining(`newer schema version ${futureVersion}`),
      });
      {
        using db = new DatabaseSync(databasePath, { readOnly: true });
        expect(readSqliteNumberPragma(db, "user_version")).toBe(futureVersion);
        expect(
          db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
            .get(),
        ).toBeUndefined();
      }
      expect(state.db.prepare("SELECT * FROM agent_deletion_journal").all()).toEqual([]);
      expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
    } finally {
      if (lockDb.isOpen) {
        try {
          lockDb.exec("ROLLBACK;");
        } catch {}
        lockDb.close();
      }
      if (opener.child.exitCode === null) {
        opener.child.kill();
      }
    }
  });

  it("does not chmod shared parent directories for explicit database paths", () => {
    const parentDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: parentDir };
    fs.chmodSync(parentDir, 0o755);
    const databasePath = path.join(parentDir, "worker-1.sqlite");

    openOpenClawAgentDatabase({
      agentId: "worker-1",
      env,
      path: databasePath,
    });

    expect(fs.statSync(parentDir).mode & 0o777).toBe(0o755);
  });

  it("repairs every missing or drifted canonical agent-state named index", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeCurrentWorkerAgentDatabase(stateDir);
    const canonicalShape = normalizeSqliteSchemaShapeSql(
      createSqliteSchemaShapeFromSql(new URL("./openclaw-agent-schema.sql", import.meta.url)),
    );

    createCanonicalAgentIndexDrift(databasePath);

    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(normalizeSqliteSchemaShapeSql(collectSqliteSchemaShape(reopened.db))).toEqual(
      canonicalShape,
    );
    expect(readSqliteNumberPragma(reopened.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      reopened.db
        .prepare(
          "SELECT seq, run_id, event_json, created_at FROM trajectory_runtime_events ORDER BY seq",
        )
        .all(),
    ).toEqual([
      { seq: 0, run_id: null, event_json: '{"type":"unassigned"}', created_at: 1 },
      { seq: 1, run_id: "run-1", event_json: '{"type":"named"}', created_at: 2 },
    ]);
  });

  it("repairs schema-19 additive session-key surfaces before upgrading schema validation", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeV21WorkerAgentDatabase(stateDir);
    const expectedShape = createSqliteSchemaShapeFromSql(
      new URL("./openclaw-agent-schema.sql", import.meta.url),
    );

    const { DatabaseSync } = requireNodeSqlite();
    const shippedSchema = new DatabaseSync(databasePath);
    // Agent migration retains this optional historical index until memory initialization.
    const historicalChunks = collectSqliteSchemaShape(shippedSchema).memory_index_chunks;
    const expectedChunks = expectedShape.memory_index_chunks;
    assert(historicalChunks && expectedChunks, "Both fixtures must contain memory chunks");
    const historicalPathIndex = historicalChunks.indexes.filter(
      (index) => index.name === "idx_memory_index_chunks_path",
    );
    expect(historicalPathIndex).toHaveLength(1);
    expectedChunks.indexes.push(...historicalPathIndex);
    expectedChunks.indexes.sort((left, right) => left.name.localeCompare(right.name));
    try {
      seedSchema19SessionKeyRepairFixture(shippedSchema);
      expect(readSqliteNumberPragma(shippedSchema, "user_version")).toBe(19);
    } finally {
      shippedSchema.close();
    }

    const repaired = await migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "worker-1", env });
    expect(normalizeSqliteSchemaShapeSql(collectSqliteSchemaShape(repaired.db))).toEqual(
      normalizeSqliteSchemaShapeSql(expectedShape),
    );
    expect(
      repaired.db
        .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
        .get("agent:worker-1:session-1"),
    ).toEqual({ entry_valid: 1 });
    expect(
      repaired.db.prepare("SELECT main_key FROM session_key_contract WHERE id = 1").get(),
    ).toEqual({ main_key: "main" });
    expect(
      repaired.db
        .prepare(
          "SELECT name FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'",
        )
        .get(),
    ).toEqual({ name: "route_context_json" });
  });

  it("installs schema-19 session additions before maintenance index repair", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeV21WorkerAgentDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const drifted = new DatabaseSync(databasePath);
    try {
      removeCanonicalValidationFromHistoricalAgentFixture(drifted);
      drifted
        .prepare(
          `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          "agent:worker-1:maintenance",
          "maintenance-session",
          JSON.stringify({ sessionId: "maintenance-session", updatedAt: 1000 }),
          1000,
        );
      drifted.exec(`
        DROP TABLE session_transcript_cold_archives;
        PRAGMA user_version = 19;
        UPDATE schema_meta SET schema_version = 19 WHERE meta_key = 'primary';
        DROP TRIGGER session_nodes_entry_valid_after_insert;
        DROP TRIGGER session_nodes_entry_valid_after_entry_update;
        DROP TRIGGER session_nodes_entry_valid_after_identity_update;
        DROP INDEX idx_agent_session_nodes_entry_valid_pending;
        DROP INDEX idx_agent_session_nodes_entry_not_valid;
        DROP TABLE session_key_contract;
        ALTER TABLE session_nodes DROP COLUMN entry_valid;
      `);
    } finally {
      drifted.close();
    }

    materializeSharedStateDatabase(env);
    await withAgentDatabaseMaintenanceLease({ env }, (maintenance) =>
      migrateOpenClawAgentDatabaseForMaintenance(
        { agentId: "worker-1", pathname: databasePath },
        maintenance,
      ),
    );

    const repaired = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        repaired
          .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
          .get("agent:worker-1:maintenance"),
      ).toEqual({ entry_valid: 1 });
      expect(
        repaired.prepare("SELECT main_key FROM session_key_contract WHERE id = 1").get(),
      ).toEqual({ main_key: "main" });
      expect(() =>
        assertOpenClawAgentDatabaseForMaintenance(repaired, {
          agentId: "worker-1",
          pathname: databasePath,
        }),
      ).not.toThrow();
    } finally {
      repaired.close();
    }
  });

  it.each([OPENCLAW_AGENT_SCHEMA_VERSION])(
    "rejects a missing stable table at version %s instead of recreating it empty",
    async (version) => {
      const stateDir = createTempStateDir();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const current = version === OPENCLAW_AGENT_SCHEMA_VERSION;
      const databasePath = current
        ? materializeCurrentWorkerAgentDatabase(stateDir)
        : materializeV21WorkerAgentDatabase(stateDir);

      const { DatabaseSync } = requireNodeSqlite();
      const drifted = new DatabaseSync(databasePath);
      if (!current) {
        removeCanonicalValidationFromHistoricalAgentFixture(drifted);
        drifted.exec(`
        DROP TABLE session_participants;
        PRAGMA user_version = ${version};
        UPDATE schema_meta SET schema_version = ${version} WHERE meta_key = 'primary';
      `);
      }
      drifted.exec("DROP TABLE auth_profile_store;");
      drifted.close();

      await expect(
        migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "worker-1", env }),
      ).rejects.toThrow(/missing table auth_profile_store/iu);
      if (current) {
        await expect(
          withAgentDatabaseMaintenanceLease({ env }, (maintenance) =>
            migrateOpenClawAgentDatabaseForMaintenance(
              { agentId: "worker-1", pathname: databasePath },
              maintenance,
            ),
          ),
        ).rejects.toThrow(/missing table auth_profile_store/iu);
      }

      const after = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          after
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'auth_profile_store'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        after.close();
      }
    },
  );

  it("adds post-v14 suggestion tables during the v15 migration", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeV21WorkerAgentDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    removeCanonicalValidationFromHistoricalAgentFixture(legacy);
    legacy.exec(`
      DROP TABLE session_suggestions;
      DROP TABLE session_participants;
      PRAGMA user_version = 14;
      UPDATE schema_meta SET schema_version = 14 WHERE meta_key = 'primary';
    `);
    legacy.close();

    const migrated = await migrateAndOpenLegacyAgentDatabaseForTest({ agentId: "worker-1", env });
    expect(
      migrated.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_suggestions'",
        )
        .get(),
    ).toEqual({ name: "session_suggestions" });
  });

  it("rejects an inline unique constraint hidden behind a SQLite autoindex", async () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeCurrentWorkerAgentDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const drifted = new DatabaseSync(databasePath);
    drifted.exec(`
      DROP TABLE cache_entries;
      CREATE TABLE cache_entries (
        scope TEXT NOT NULL UNIQUE,
        key TEXT NOT NULL,
        value_json TEXT,
        blob BLOB,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      ) STRICT;
      CREATE INDEX idx_agent_cache_expiry
        ON cache_entries(key);
      CREATE INDEX idx_agent_cache_updated
        ON cache_entries(scope, updated_at DESC, key);
    `);
    drifted.close();

    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      /unexpected unique index on cache_entries/iu,
    );
    await expect(
      withAgentDatabaseMaintenanceLease({ env }, (maintenance) =>
        migrateOpenClawAgentDatabaseForMaintenance(
          { agentId: "worker-1", pathname: databasePath },
          maintenance,
        ),
      ),
    ).rejects.toThrow(/unexpected unique index on cache_entries/iu);
    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        after
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_cache_expiry'",
          )
          .get(),
      ).toEqual({
        sql: "CREATE INDEX idx_agent_cache_expiry\n        ON cache_entries(key)",
      });
    } finally {
      after.close();
    }
  });

  it("rejects same-name transcript index drift when duplicate rows block repair", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeCurrentWorkerAgentDatabase(stateDir);
    createTranscriptIdempotencyIndexDrift(databasePath, { duplicateRows: true });

    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      /canonical index idx_agent_transcript_message_idempotency failed.*UNIQUE constraint failed/iu,
    );

    const { DatabaseSync } = requireNodeSqlite();
    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        after
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_message_idempotency'",
          )
          .get(),
      ).toEqual({
        sql: expect.stringContaining("ON transcript_event_identities(session_id, event_id)"),
      });
      expect(
        after
          .prepare(
            "SELECT COUNT(*) AS count FROM transcript_event_identities WHERE message_idempotency_key = 'message-1'",
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(
        after
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'openclaw_probe_%'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      after.close();
    }
  });

  it("repairs null schema metadata on the current-schema path without rewriting it again", () => {
    const stateDir = createTempStateDir();
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    } as const;
    const databasePath = openOpenClawAgentDatabase(options).path;
    closeOpenClawAgentDatabasesForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const corrupt = new DatabaseSync(databasePath);
    corrupt
      .prepare(
        "UPDATE schema_meta SET app_version = NULL, updated_at = 1 WHERE meta_key = 'primary'",
      )
      .run();
    corrupt.close();

    openOpenClawAgentDatabase(options);
    closeOpenClawAgentDatabasesForTest();

    const afterRepair = new DatabaseSync(databasePath, { readOnly: true });
    const repaired = afterRepair
      .prepare("SELECT app_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get() as { app_version: string; updated_at: number };
    afterRepair.close();
    expect(repaired.app_version).toBe(VERSION);
    expect(repaired.updated_at).toBeGreaterThan(1);

    openOpenClawAgentDatabase(options);
    closeOpenClawAgentDatabasesForTest();

    const afterReopen = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        afterReopen
          .prepare("SELECT app_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual(repaired);
    } finally {
      afterReopen.close();
    }
  });

  it("adds the active transcript projection when upgrading v9 databases", async () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeV13WorkerAgentDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      DROP TABLE session_transcript_active_events;
      ALTER TABLE session_transcript_index_state DROP COLUMN active_event_count;
      ALTER TABLE session_transcript_index_state DROP COLUMN active_message_count;
      DELETE FROM schema_meta;
      INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', 'agent', 9, 'worker-1', NULL, 1, 1);
      INSERT INTO sessions
        (session_id, session_key, created_at, updated_at)
      VALUES ('session-1', 'agent:worker-1:main', 10, 20);
      INSERT INTO transcript_events
        (session_id, seq, event_json, created_at)
      VALUES
        ('session-1', 0, '{"type":"session","id":"session-1"}', 10),
        ('session-1', 1, '{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":"hello"}}', 20);
      INSERT INTO session_transcript_index_state
        (session_id, indexed_seq, leaf_event_id, needs_rebuild, updated_at)
      VALUES ('session-1', 1, 'm1', 0, 20);
      PRAGMA user_version = 9;
    `);
    db.close();

    const database = await migrateAndOpenLegacyAgentDatabaseForTest({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = database.db
      .prepare("PRAGMA table_info(session_transcript_index_state)")
      .all() as Array<{ name?: unknown }>;

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["active_event_count", "active_message_count"]),
    );
    expect(
      database.db
        .prepare(
          "SELECT indexed_seq, needs_rebuild, active_event_count, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get("session-1"),
    ).toEqual({
      active_event_count: 0,
      active_message_count: 0,
      indexed_seq: 1,
      needs_rebuild: 1,
    });
    expect(
      database.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_transcript_active_events'",
        )
        .get(),
    ).toEqual({ name: "session_transcript_active_events" });
    expect(
      database.db
        .prepare(
          "SELECT length(generation) AS generation_length FROM transcript_rewrite_watermarks WHERE session_id = ?",
        )
        .get("session-1"),
    ).toEqual({ generation_length: 32 });
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  });

  it.each([{ owner: "   ", expected: { status: "unreadable" } }])(
    "inspects database ownership for $owner",
    ({ owner, expected }) => {
      const stateDir = createTempStateDir();
      const database = openOpenClawAgentDatabase({
        agentId: "worker-1",
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      const databasePath = database.path;
      if (owner === "worker-1") {
        expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual(expected);
      }
      closeOpenClawAgentDatabasesForTest();
      if (owner !== "worker-1") {
        fs.copyFileSync(databasePath, `${databasePath}.replacement`);
        fs.renameSync(`${databasePath}.replacement`, databasePath);
        const { DatabaseSync } = requireNodeSqlite();
        using raw = new DatabaseSync(databasePath);
        raw.prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'").run(owner);
      }

      expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual(expected);
    },
  );

  it.each(["agent"] as const)(
    "revalidates default and relocated replacements after %s unregister",
    (scope) => {
      const stateDir = createTempStateDir();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
      try {
        const databasePaths = [
          openOpenClawAgentDatabase({ agentId: "worker-1", env }).path,
          openOpenClawAgentDatabase({
            agentId: "worker-1",
            env,
            path: path.join(stateDir, "relocated.sqlite"),
          }).path,
        ];
        const unrelatedPath = openOpenClawAgentDatabase({ agentId: "worker-2", env }).path;
        for (const databasePath of [...databasePaths, unrelatedPath]) {
          expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
        }
        if (scope === "agent") {
          unregisterOpenClawAgentDatabases({ agentId: "worker-1", env });
        } else {
          for (const databasePath of databasePaths) {
            unregisterOpenClawAgentDatabase({ agentId: "worker-1", path: databasePath, env });
          }
        }
        expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([
          expect.objectContaining({ agentId: "worker-2", path: unrelatedPath }),
        ]);
        nowSpy.mockReturnValue(2_000);
        for (const databasePath of databasePaths) {
          fs.copyFileSync(ensureCurrentWorkerAgentDatabaseTemplate(), databasePath);
          const reopened = openOpenClawAgentDatabase({
            agentId: "worker-1",
            env,
            path: databasePath,
          });
          expect(readSqliteNumberPragma(reopened.db, "user_version")).toBe(
            OPENCLAW_AGENT_SCHEMA_VERSION,
          );
        }
        openOpenClawAgentDatabase({ agentId: "worker-2", env });
        expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual(
          expect.arrayContaining([
            ...databasePaths.map((databasePath) =>
              expect.objectContaining({
                agentId: "worker-1",
                path: databasePath,
                lastSeenAt: 2_000,
              }),
            ),
            expect.objectContaining({
              agentId: "worker-2",
              path: unrelatedPath,
              lastSeenAt: 1_000,
            }),
          ]),
        );
      } finally {
        nowSpy.mockRestore();
      }
    },
  );

  it("initializes an empty replacement after physical close without a registry mutation", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = database.path;
    expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
    fs.rmSync(databasePath);

    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env, path: databasePath });

    expect(readSqliteNumberPragma(reopened.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("auth_profile_store"),
    ).toEqual({ name: "auth_profile_store" });
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([
      expect.objectContaining({ agentId: "worker-1", path: databasePath }),
    ]);
  });

  it("reopens a validated current-schema database promptly while a WAL writer is active", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);

    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(databasePath);
    let reopened: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
    try {
      writer.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
      const startedAt = performance.now();
      reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
      const elapsedMs = performance.now() - startedAt;

      expect(reopened.db.isOpen).toBe(true);
      expect(elapsedMs).toBeLessThan(1_000);
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
      if (reopened) {
        closeOpenClawAgentDatabaseByPath(reopened.path);
      }
    }
  });

  it.each([
    {
      replacement: "non-agent schema role",
      role: "global",
      agentId: null,
      expectedError: /schema role global; expected agent/iu,
    },
    {
      replacement: "different agent id",
      role: "agent",
      agentId: "worker-2",
      expectedError: /belongs to agent worker-2; requested agent worker-1/iu,
    },
  ])(
    "rejects a validated reopen after $replacement replacement before write-capable checks",
    async ({ role, agentId, expectedError }) => {
      const stateDir = createTempStateDir();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
      expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
      fs.copyFileSync(databasePath, `${databasePath}.replacement`);
      fs.renameSync(`${databasePath}.replacement`, databasePath);
      createCacheExpiryIndexPhysicalDrift(databasePath);

      const { DatabaseSync } = requireNodeSqlite();
      const writer = new DatabaseSync(databasePath);
      try {
        writer
          .prepare("UPDATE schema_meta SET role = ?, agent_id = ? WHERE meta_key = 'primary'")
          .run(role, agentId);
        writer.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");

        const startedAt = performance.now();
        let failure: unknown;
        try {
          openOpenClawAgentDatabase({ agentId: "worker-1", env });
        } catch (error) {
          failure = error;
        }
        const elapsedMs = performance.now() - startedAt;

        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) {
          throw new Error("validated owner replacement reopen unexpectedly succeeded");
        }
        expect(failure.message).toMatch(expectedError);
        expect(elapsedMs).toBeLessThan(1_000);
      } finally {
        writer.exec("ROLLBACK;");
        writer.close();
      }

      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
      expect(
        openOpenClawStateDatabase({ env })
          .db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?")
          .get(databasePath),
      ).toBeUndefined();

      const restored = new DatabaseSync(databasePath);
      try {
        expect(restored.prepare("PRAGMA integrity_check('cache_entries')").all()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              integrity_check: expect.stringMatching(/idx_agent_cache_expiry/),
            }),
          ]),
        );
        restored
          .prepare(
            "UPDATE schema_meta SET role = 'agent', agent_id = 'worker-1' WHERE meta_key = 'primary'",
          )
          .run();
      } finally {
        restored.close();
      }
      fs.copyFileSync(databasePath, `${databasePath}.replacement`);
      fs.renameSync(`${databasePath}.replacement`, databasePath);

      nowSpy.mockReturnValue(2_000);
      try {
        expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
          /integrity_check failed.*idx_agent_cache_expiry.*openclaw doctor --fix/,
        );
        const repair = await migrateLegacyMediaPersistence({
          env,
          configuredAgentDatabaseTargets: [{ agentId: "worker-1", path: databasePath }],
        });
        expect(repair.warnings).toEqual([]);
        openOpenClawAgentDatabase({ agentId: "worker-1", env });
        expect(
          listOpenClawRegisteredAgentDatabases({ env }).find(
            (entry) => entry.agentId === "worker-1" && entry.path === databasePath,
          ),
        ).toMatchObject({ lastSeenAt: 2_000 });
      } finally {
        nowSpy.mockRestore();
      }
    },
  );

  it.each([
    {
      kind: "malformed ownership metadata",
      schema: "CREATE TABLE schema_meta (meta_key TEXT);",
      expectedError: /schema_meta is missing required columns/,
    },
  ])(
    "preserves the refusal for a populated v0 database with $kind",
    ({ schema, expectedError }) => {
      const stateDir = createTempStateDir();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const databasePath = path.join(stateDir, "populated-v0.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      const populated = new DatabaseSync(databasePath);
      try {
        populated.exec(schema);
      } finally {
        populated.close();
      }

      expect(() =>
        withOpenClawAgentDatabaseReadOnly(() => "unused", {
          agentId: "worker-1",
          env,
          path: databasePath,
        }),
      ).toThrow(expectedError);
      expect(() =>
        openOpenClawAgentDatabase({ agentId: "worker-1", env, path: databasePath }),
      ).toThrow(expectedError);
    },
  );

  it("latches newer per-agent schema failures on a validated physical reopen", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
    closeOpenClawStateDatabaseForTest();
    fs.copyFileSync(databasePath, `${databasePath}.replacement`);
    fs.renameSync(`${databasePath}.replacement`, databasePath);
    createUnsafeIndexDrift(databasePath);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
    db.close();

    let firstFailure: unknown;
    try {
      openOpenClawAgentDatabase({ agentId: "worker-1", env });
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toMatchObject({
      name: "SqliteSchemaVersionError",
      message: expect.stringContaining("https://docs.openclaw.ai/reference/database-schemas"),
    });
    expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?")
        .get(databasePath),
    ).toBeUndefined();
    const stillDrifted = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        stillDrifted
          .prepare("SELECT sql FROM sqlite_schema WHERE name = 'unsafe_index_records_value'")
          .get(),
      ).toEqual({
        sql: "CREATE INDEX unsafe_index_records_value ON unsafe_index_records(alternate_value)",
      });
    } finally {
      stillDrifted.close();
    }

    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      fs.rmSync(candidate, { force: true });
    }
    let secondFailure: unknown;
    try {
      openOpenClawAgentDatabase({ agentId: "worker-1", env });
    } catch (error) {
      secondFailure = error;
    }
    expect(secondFailure).toBe(firstFailure);

    clearOpenClawAgentDatabaseOpenFailure(databasePath);
    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(readSqliteNumberPragma(reopened.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      reopened.db
        .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ role: "agent", agent_id: "worker-1" });
    expect(
      listOpenClawRegisteredAgentDatabases({ env }).find(
        (entry) => entry.agentId === "worker-1" && entry.path === databasePath,
      ),
    ).toBeDefined();
  });

  it("closes cached handles on normal process exit so no stale WAL remains", () => {
    const stateDir = createTempStateDir();
    const agentModuleUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.agentDatabase);
    const output = execFileSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(agentModuleUrl).slice(0, -1),
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          import { openOpenClawAgentDatabase } from ${JSON.stringify(agentModuleUrl.href)};

          const database = openOpenClawAgentDatabase({
            agentId: "worker-1",
            env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_AGENT_DB_EXIT_TEST_DIR },
          });
          const walPath = database.path + "-wal";
          console.log(JSON.stringify({
            agentDatabasePath: database.path,
            agentWalBytesBeforeExit: fs.existsSync(walPath) ? fs.statSync(walPath).size : 0,
          }));
        `,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_AGENT_DB_EXIT_TEST_DIR: stateDir },
      },
    );
    const result = JSON.parse(output) as {
      agentDatabasePath: string;
      agentWalBytesBeforeExit: number;
    };
    if (result.agentWalBytesBeforeExit === 0) {
      // Rollback-journal filesystems (NFS/SMB tmp dirs) never produce a WAL.
      return;
    }
    // The child never closes explicitly; only the exit hook can retire the WAL.
    const walPath = `${result.agentDatabasePath}-wal`;
    const walBytesAfterExit = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    expect(walBytesAfterExit).toBe(0);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
