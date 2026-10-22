import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterAll, afterEach, assert, beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { SqlConnection } from "../infra/sql-connection.js";
import { revokeSqliteDatabaseAdmissionsForPath as revokeAdmissions } from "../infra/sqlite-database-admission.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { readSqliteNumberPragma as readPragma } from "../infra/sqlite-pragma.test-support.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import {
  beginAgentDeletionJournal,
  claimCompletedAgentDeletionJournal as claimDeletion,
  removeAgentDeletionJournal as removeDeletion,
  updateAgentDeletionJournalDatabasePaths,
  updateAgentDeletionJournalCleanupPaths,
} from "../test-utils/agent-deletion-journal.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { VERSION } from "../version.js";
import { runWithAgentCreationClaim as withCreation } from "./agent-creation-claim.js";
import { completeAgentDeletionJournalInDatabase } from "./agent-deletion-journal.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import { disposeOpenClawAgentDatabaseByPath } from "./openclaw-agent-db-disposal.js";
import {
  assertNoOpenClawAgentDatabaseLeases as assertNoAgentLeases,
  claimOpenClawAgentDatabaseLease as claimAgentLease,
  releaseOpenClawAgentDatabaseLease as releaseAgentLease,
} from "./openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease as withMaintenance } from "./openclaw-agent-db-maintenance-lease.js";
import {
  assertOpenClawAgentDatabaseForMaintenance as assertMaintenanceDb,
  migrateOpenClawAgentDatabaseForMaintenance as migrateMaintenanceDb,
} from "./openclaw-agent-db-maintenance.js";
import { withOpenClawAgentDatabaseReadOnly as readAgentDb } from "./openclaw-agent-db-readonly.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabases as unregisterAgent,
} from "./openclaw-agent-db-registry.js";
import { invalidateOpenClawAgentDatabaseValidation as invalidateValidation } from "./openclaw-agent-db-validation-cache.js";
import {
  clearOpenClawAgentDatabaseOpenFailure as clearOpenFailure,
  closeOpenClawAgentDatabaseByPath as closeAgentDb,
  closeOpenClawAgentDatabasesForTest as closeAgentDbs,
  ensureOpenClawAgentDatabaseSchema as ensureSchema,
  inspectOpenClawAgentDatabaseOwner as inspectOwner,
  isOpenClawAgentDatabaseOpen as isAgentDbOpen,
  listOpenClawRegisteredAgentDatabases as registeredAgentDbs,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase as openAgentDbRuntime,
  readOpenClawAgentDatabaseRegistryToken as registryToken,
  resolveOpenClawAgentSqlitePath as agentDbPath,
  runOpenClawAgentWriteTransaction as writeAgent,
  settleOpenClawAgentDatabaseWorkerClose as settleWorkerClose,
  withOpenClawAgentDatabaseAsync as withAgentDb,
} from "./openclaw-agent-db.js";
import {
  createOpenClawAgentDatabasePathMatcher as createPathMatcher,
  isSameOpenClawAgentDatabasePath as isSamePath,
} from "./openclaw-agent-db.paths.js";
import {
  fixtureVolumeHasFileAlias,
  removeCanonicalValidationFromHistoricalAgentFixture,
  seedSchema19SessionKeyRepairFixture,
} from "./openclaw-agent-db.test-support.js";
import {
  materializeV21WorkerAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_V21_SQL,
} from "./openclaw-agent-schema-v21.test-support.js";
import { createOpenClawDatabaseMaintenanceScope as createMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest as closeStateDb,
  openOpenClawStateDatabase as openState,
  runOpenClawStateWriteTransaction as writeState,
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

function createState() {
  const stateDir = createTempStateDir();
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const options = { agentId: "worker-1", env };
  return {
    stateDir,
    env,
    options,
    registerDb: (agentId: string, pathname: string) =>
      registerOpenClawAgentDatabase({ agentId, path: pathname, env }),
    unregisterDb: (agentId: string, pathname: string) =>
      unregisterOpenClawAgentDatabase({ agentId, path: pathname, env }),
    claimLease: (agentId: string, pathname: string) =>
      claimAgentLease({ agentId, path: pathname, env }),
    releaseLease: (leaseId: string) => releaseAgentLease(leaseId, { env }),
    openDb: (pathname?: string, agentId = options.agentId) =>
      openAgentDb({ ...options, agentId, ...(pathname === undefined ? {} : { path: pathname }) }),
  };
}

function beginDeletion(
  env: { OPENCLAW_STATE_DIR: string },
  overrides: Partial<Parameters<typeof beginAgentDeletionJournal>[0]> = {},
) {
  const agentId = overrides.agentId ?? "worker-1";
  return beginAgentDeletionJournal(
    {
      operationId: "deletion",
      deleteFiles: true,
      agentId,
      agentDir: path.join(env.OPENCLAW_STATE_DIR, "agents", agentId, "agent"),
      workspaceDir: path.join(env.OPENCLAW_STATE_DIR, `workspace-${agentId}`),
      sessionsDir: path.join(env.OPENCLAW_STATE_DIR, `sessions-${agentId}`),
      ...overrides,
    },
    { env },
  );
}

function completeDeletion(deletion: ReturnType<typeof beginDeletion>, env: NodeJS.ProcessEnv) {
  writeState(
    (db) => completeAgentDeletionJournalInDatabase(db, deletion.agentId, deletion.operationId),
    { env },
  );
}

function expectRow(db: SqlConnection, sql: string, expected: unknown, ...params: SQLInputValue[]) {
  expect(queryOne(db, sql, ...params)).toEqual(expected);
}

function expectRows(db: SqlConnection, sql: string, expected: unknown, ...params: SQLInputValue[]) {
  expect(queryAll(db, sql, ...params)).toEqual(expected);
}

function expectRecord(
  db: SqlConnection,
  from: string,
  expected: Record<string, unknown>,
  ...params: SQLInputValue[]
) {
  const columns = Object.keys(expected).join(", ");
  expectRow(db, `SELECT ${columns} FROM ${from}`, expected, ...params);
}

function queryOne(db: SqlConnection, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).get(...params);
}
function queryAll(db: SqlConnection, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).all(...params);
}
function execute(db: SqlConnection, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}

function openRawDatabase(pathname: string, readOnly = false) {
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(pathname, { readOnly });
}

function editDatabase(pathname: string, sql: string) {
  using db = openRawDatabase(pathname);
  db.exec(sql);
}

function replaceDatabase(pathname: string) {
  fs.copyFileSync(pathname, `${pathname}.replacement`);
  fs.renameSync(`${pathname}.replacement`, pathname);
}

function expectRegistered(
  env: NodeJS.ProcessEnv,
  entries: Array<Partial<ReturnType<typeof registeredAgentDbs>[number]>>,
) {
  expect(registeredAgentDbs({ env })).toEqual(
    entries.map((entry) => expect.objectContaining(entry)),
  );
}

function expectAgentClosed(env: NodeJS.ProcessEnv, pathname: string) {
  expect(isAgentDbOpen(pathname)).toBe(false);
  expect(
    queryOne(
      openState({ env }).db,
      "SELECT lease_id FROM agent_database_leases WHERE path = ?",
      pathname,
    ),
  ).toBeUndefined();
}

function createDatabaseFixture(seed = materializeCurrentWorkerAgentDatabase) {
  const fixture = createState();
  return { ...fixture, dbPath: seed(fixture.stateDir) };
}

function deletedFixture(completed = true) {
  const fixture = createState();
  const dbPath = agentDbPath(fixture.options);
  const deletion = beginDeletion(fixture.env);
  if (completed) {
    completeDeletion(deletion, fixture.env);
  }
  return { ...fixture, deletion, dbPath, agentDir: path.dirname(dbPath) };
}

function retireTemplateSidecars(pathname: string) {
  const walPath = `${pathname}-wal`;
  expect(fs.existsSync(walPath) ? fs.statSync(walPath).size : 0).toBe(0);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    fs.rmSync(`${pathname}${suffix}`, { force: true });
  }
}

function ensureSharedStateDatabaseTemplate(): string {
  if (sharedStateDatabaseTemplatePath) {
    return sharedStateDatabaseTemplatePath;
  }
  const stateDir = makeTempDir(agentDbTempDirs, "openclaw-agent-db-shared-state-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const database = openState({ env });
  sharedStateDatabaseTemplatePath = database.path;
  closeStateDb();
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

function openAgentDb(options: Parameters<typeof openAgentDbRuntime>[0]) {
  materializeSharedStateDatabase(options.env);
  return openAgentDbRuntime(options);
}

function ensureCurrentWorkerAgentDatabaseTemplate(): string {
  if (currentWorkerAgentDatabaseTemplatePath) {
    return currentWorkerAgentDatabaseTemplatePath;
  }
  const template = openAgentDb(createState().options);
  const templatePath = template.path;
  template.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  closeAgentDbs();
  closeStateDb();
  retireTemplateSidecars(templatePath);
  currentWorkerAgentDatabaseTemplatePath = templatePath;
  return templatePath;
}

function materializeCurrentWorkerAgentDatabase(stateDir: string): string {
  return cloneAgentTemplate(stateDir, ensureCurrentWorkerAgentDatabaseTemplate());
}

function ensureV13WorkerAgentDatabaseTemplate(): string {
  if (v13WorkerAgentDatabaseTemplatePath) {
    return v13WorkerAgentDatabaseTemplatePath;
  }
  // Legacy migration cases mutate independent clones; keep one closed, verified v13
  // baseline so the test-only reverse migration is not repeated for every case.
  const dbPath = materializeV21WorkerAgentDatabase(createTempStateDir());
  downgradeV21AgentDatabaseToV13(dbPath);
  editDatabase(dbPath, "PRAGMA wal_checkpoint(TRUNCATE);");
  retireTemplateSidecars(dbPath);
  v13WorkerAgentDatabaseTemplatePath = dbPath;
  return dbPath;
}

function materializeV13WorkerAgentDatabase(stateDir: string): string {
  return cloneAgentTemplate(stateDir, ensureV13WorkerAgentDatabaseTemplate());
}

function cloneAgentTemplate(stateDir: string, templatePath: string) {
  const dbPath = agentDbPath({ agentId: "worker-1", env: { OPENCLAW_STATE_DIR: stateDir } });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(templatePath, dbPath, fs.constants.COPYFILE_EXCL);
  return dbPath;
}

async function migrateAgentDb(options: Parameters<typeof openAgentDb>[0]) {
  // Prepare the unrelated registry before the real maintenance lease's acquisition budget.
  materializeSharedStateDatabase(options.env);
  const pathname = agentDbPath(options);
  {
    using database = openRawDatabase(pathname);
    await withMaintenance({ env: options?.env }, async () => ensureSchema(database, options));
  }
  return openAgentDb(options);
}

const tempVolumeIsCaseInsensitive = fixtureVolumeHasFileAlias(
  createTempStateDir(),
  "CaseProbe",
  "caseProbe",
);
const tempVolumeIsNormalizationInsensitive = fixtureVolumeHasFileAlias(
  createTempStateDir(),
  "CaféProbe",
  "CaféProbe",
);

function legacyTableDefinition(
  source: string,
  target: string,
  omittedColumns: string[] = [],
  parent?: string,
) {
  // Derive only from the frozen historical fixture, never the current runtime schema.
  const definition = OPENCLAW_AGENT_SCHEMA_V21_SQL.match(
    new RegExp(`^CREATE TABLE IF NOT EXISTS ${source} \\([\\s\\S]*?^\\) STRICT;`, "m"),
  )?.[0];
  if (!definition) {
    throw new Error(`Missing frozen table ${source}`);
  }
  const columns = definition
    .split("\n")
    .slice(1, -1)
    .filter(
      (line) =>
        !omittedColumns.some((column) => line.trimStart().startsWith(`${column} `)) &&
        (parent !== undefined || !line.includes("REFERENCES session_nodes(")),
    );
  return `CREATE TABLE ${target} (\n${columns
    .join("\n")
    .replace(/,\s*$/, "")
    .replace("REFERENCES session_nodes(", `REFERENCES ${parent}(`)}\n) STRICT;`;
}

function downgradeV21AgentDatabaseToV13(dbPath: string): void {
  using database = openRawDatabase(dbPath);
  removeCanonicalValidationFromHistoricalAgentFixture(database);
  const sessionColumns = `session_id, session_key, session_scope, created_at, updated_at,
    transcript_updated_at, transcript_observed_at, session_entry_provenance,
    acp_owned, plugin_owner_id, hook_external_content_source, started_at,
    ended_at, status, chat_type, channel, account_id, primary_conversation_id,
    model_provider, model, agent_harness_id, parent_session_key, spawned_by, display_name`;
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
      ${legacyTableDefinition("session_windows", "sessions_legacy", ["previous_session_id", "reason"])}
      INSERT INTO sessions_legacy (${sessionColumns}) SELECT ${sessionColumns} FROM sessions;
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
      ${legacyTableDefinition("session_members", "session_members_v13", [], "session_entries")}
      INSERT INTO session_members_v13 SELECT * FROM session_members;
      DROP TABLE session_members;
      ALTER TABLE session_members_v13 RENAME TO session_members;
      CREATE INDEX idx_agent_session_members_identity
        ON session_members(identity_id, session_key);
      ALTER TABLE transcript_rewrite_watermarks RENAME TO session_transcript_generations;
      ${legacyTableDefinition("board_tabs", "board_tabs_v13")}
      INSERT INTO board_tabs_v13 SELECT * FROM board_tabs;
      DROP TABLE board_tabs;
      ALTER TABLE board_tabs_v13 RENAME TO board_tabs;
      DROP TABLE heartbeat_outcomes;
      ${legacyTableDefinition("heartbeat_outcomes", "heartbeat_outcomes")}
      DROP TABLE session_nodes;
      PRAGMA user_version = 13;
      UPDATE schema_meta SET schema_version = 13 WHERE meta_key = 'primary';
    `);
}

function seedVersion1MemoryAgentDatabase(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  editDatabase(
    dbPath,
    `
      PRAGMA user_version = 1;
      ${legacyTableDefinition("schema_meta", "schema_meta").replace(") STRICT;", ");")}
      INSERT INTO schema_meta VALUES ('primary', 'agent', 1, 'worker-1', NULL, 1, 1);
      CREATE TABLE memory_index_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT INTO memory_index_state VALUES (1, 7);
    `,
  );
}

function runAgentScript(body: string, env: NodeJS.ProcessEnv) {
  const agentUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.agentDatabase);
  const stateUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase);
  const script = `
          import fs from "node:fs";
          import path from "node:path";
          import * as agent from ${JSON.stringify(agentUrl.href)};
          import * as state from ${JSON.stringify(stateUrl.href)};
          ${body}
        `;
  return execFileSync(
    process.execPath,
    [...resolveRuntimeWorkerArgv(agentUrl).slice(0, -1), "--input-type=module", "-e", script],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
}

type AgentSchemaOpenerResult = { agentId: string; ok: boolean; error?: string };

function launchAgentSchemaOpener(params: { agentId: string; dbPath: string; stateDir: string }) {
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
        OPENCLAW_AGENT_DB_RACE_PATH: params.dbPath,
        OPENCLAW_AGENT_DB_RACE_STATE_DIR: params.stateDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  const ready = createDeferred();
  const beginAttempt = createDeferred();
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    if (lines.includes("ready")) {
      ready.resolve();
    }
    if (lines.includes("begin-attempt")) {
      beginAttempt.resolve();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<AgentSchemaOpenerResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      const earlyExit = new Error(`agent opener exited before synchronization: ${stderr}`);
      ready.reject(earlyExit);
      beginAttempt.reject(earlyExit);
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
  return { beginAttempt: beginAttempt.promise, child, ready: ready.promise, result };
}

beforeAll(() => {
  ensureCurrentWorkerAgentDatabaseTemplate();
  ensureV13WorkerAgentDatabaseTemplate();
});

afterAll(() => cleanupTempDirs(agentDbTempDirs));

afterEach(() => {
  closeAgentDbs();
  closeStateDb();
});

it.each([
  { admission: "sync", integrityCheck: "quick" },
  { admission: "async", integrityCheck: "quick" },
  { admission: "sync", integrityCheck: "full" },
  { admission: "async", integrityCheck: "full" },
] as const)(
  "inherits maintenance integrity coverage for $admission admission ($integrityCheck)",
  async ({ admission, integrityCheck }) => {
    const { stateDir, env } = createState();
    materializeSharedStateDatabase(env);
    const dbPath = materializeCurrentWorkerAgentDatabase(stateDir);
    createCacheExpiryIndexPhysicalDrift(dbPath);
    const options = { agentId: "worker-1", env, path: dbPath };
    const maintenance = createMaintenanceScope({
      schemaMaintenance: true,
      sqliteIntegrityCheck: integrityCheck,
      assertOwnerCurrent: () => {},
      assertDatabaseAccess: () => {},
    });
    const child = maintenance.run(() => createMaintenanceScope());
    try {
      const opened = child.run(async () => {
        const readValue = (database: ReturnType<typeof openAgentDb>) =>
          queryOne(database.db, "SELECT value_json FROM cache_entries WHERE key = 'key-a'")
            ?.value_json;
        return admission === "async"
          ? await withAgentDb(options, readValue)
          : readValue(openAgentDb(options));
      });
      if (integrityCheck === "full") {
        await expect(opened).rejects.toThrow(/integrity_check.*idx_agent_cache_expiry/su);
      } else {
        await expect(opened).resolves.toBe("{}");
      }
    } finally {
      await child.close();
      await maintenance.close();
    }
    if (integrityCheck === "quick") {
      // Leaving Doctor must not promote its QUICK admission to runtime FULL proof.
      expect(() => openAgentDb(options)).toThrow(/integrity_check.*idx_agent_cache_expiry/su);
    }
  },
);

it("uses the canonical state schema for deletion journal reads and updates", () => {
  const { stateDir, env } = createState();
  materializeSharedStateDatabase(env);
  const entry = {
    agentId: "deleted",
    agentDir: path.join(stateDir, "agents", "deleted", "agent"),
    workspaceDir: path.join(stateDir, "workspace-deleted"),
    sessionsDir: path.join(stateDir, "sessions-deleted"),
  };
  const deletion = beginDeletion(env, entry);
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
  const recovery = beginDeletion(env, { ...entry, operationId: "recovery" });
  expect(recovery.databasePaths).toEqual(databasePaths);
  expect(recovery.cleanupPaths).toEqual(cleanupPaths);
  removeDeletion(recovery.agentId, recovery.operationId, { env });
});

it("fences registration and lease claims beneath another agent's pending deletion", () => {
  const { stateDir, env, registerDb, unregisterDb, claimLease, releaseLease } = createState();
  const agentDir = path.join(stateDir, "agents", "deleted", "agent");
  const linkedAgentDir = path.join(stateDir, "linked-deleted-agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.symlinkSync(agentDir, linkedAgentDir, "dir");
  const dbPath = path.join(agentDir, "nested", "survivor.sqlite");
  const relocatedDatabasePath = path.join(stateDir, "relocated", "deleted.sqlite");
  const sidecarClaimPath = path.join(stateDir, "sidecar", "shared.sqlite");
  const registeredSidecarPath = `${sidecarClaimPath}-wal`;
  registerDb("deleted", relocatedDatabasePath);
  registerDb("deleted", registeredSidecarPath);
  const deletion = beginDeletion(env, { agentId: "deleted", agentDir: linkedAgentDir });
  unregisterDb("deleted", relocatedDatabasePath);
  unregisterDb("deleted", registeredSidecarPath);
  try {
    for (const fencedPath of [dbPath, relocatedDatabasePath, sidecarClaimPath]) {
      expect(() => registerDb("survivor", fencedPath)).toThrow("deletion owns");
      expect(() => claimLease("survivor", fencedPath)).toThrow("deletion owns");
    }
  } finally {
    removeDeletion(deletion.agentId, deletion.operationId, { env });
  }
  expect(() => registerDb("survivor", dbPath)).not.toThrow();
  const leaseId = claimLease("survivor", dbPath);
  releaseLease(leaseId);
  unregisterDb("survivor", dbPath);
});

it("blocks deletion on a foreign lease beneath its workspace until release", () => {
  const { stateDir, env, claimLease, releaseLease } = createState();
  const workspaceDir = path.join(stateDir, "workspace-deleted");
  const foreignDatabasePath = path.join(workspaceDir, "nested", "survivor.sqlite");
  const leaseId = claimLease("survivor", foreignDatabasePath);
  const deletion = beginDeletion(env, { agentId: "deleted", workspaceDir });
  expect(() => assertNoAgentLeases("deleted", { env })).toThrow("deletion owns");
  releaseLease(leaseId);
  expect(() => assertNoAgentLeases("deleted", { env })).not.toThrow();
  removeDeletion(deletion.agentId, deletion.operationId, { env });
});

it("opens the agent and its shared registry under the default HOME state owner", () => {
  const home = createTempStateDir();
  const env = { HOME: home, NODE_ENV: "test" };
  const options = { agentId: "main", env };
  const stateDir = path.join(home, ".openclaw");
  const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  // Fail before opening if path resolution escapes the test-owned home.
  expect(agentDbPath(options)).toBe(agentPath);
  const agent = openAgentDbRuntime(options);
  const shared = openState({ env });
  expect(agent.path).toBe(agentPath);
  expect(shared.path).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
  expectRegistered(env, [{ agentId: "main", path: agentPath }]);
});

it("distinguishes absent, unowned and unsupported read-only databases", () => {
  const { options } = createState();
  const dbPath = agentDbPath(options);
  expect(readAgentDb(() => "unused", options)).toEqual({
    found: false,
    reason: "database-missing",
  });
  expect(fs.existsSync(dbPath)).toBe(false);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const empty = openRawDatabase(dbPath);
  empty.close();
  expect(readAgentDb(() => "unused", options)).toEqual({
    found: false,
    reason: "schema-missing",
  });
  replaceDatabase(dbPath);
  editDatabase(dbPath, `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
  expect(() => readAgentDb(() => "unused", options)).toThrow(
    `newer schema version ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`,
  );
});

it("opens extension-capable reads separately from the owner without enabling writes", () => {
  const { options } = createState();
  const owner = openAgentDb(options);
  const result = readAgentDb(
    ({ db }) => {
      expect(db).not.toBe(owner.db);
      expect(() => requireNativeSqliteDatabase(db).enableLoadExtension(true)).not.toThrow();
      expect(() => execute(db, "DELETE FROM auth_profile_store")).toThrow(/readonly/iu);
      return queryOne(db, "SELECT agent_id FROM schema_meta WHERE meta_key = 'primary'");
    },
    options,
    { allowExtension: true },
  );
  expect(result).toEqual({ found: true, value: { agent_id: "worker-1" } });
});

it("rotates the registry token on pathname switches and committed writes", () => {
  const { stateDir, env, registerDb, unregisterDb } = createState();
  const otherEnv = { OPENCLAW_STATE_DIR: createTempStateDir() };
  const dbPath = path.join(stateDir, "agents", "worker-1", "agent", "openclaw-agent.sqlite");
  const firstToken = registryToken({ env });
  expectRegistered(env, []);
  expect(registryToken({ env })).toBe(firstToken);
  expect(registryToken({ env: otherEnv })).not.toBe(firstToken);
  const returnedToken = registryToken({ env });
  expect(returnedToken).not.toBe(firstToken);
  registerDb("worker-1", dbPath);
  const registeredToken = registryToken({ env });
  expect(registeredToken).not.toBe(returnedToken);
  expectRegistered(env, [{ agentId: "worker-1", path: dbPath }]);
  expect(registryToken({ env })).toBe(registeredToken);
  unregisterDb("worker-1", dbPath);
  expect(registryToken({ env })).not.toBe(registeredToken);
  expectRegistered(env, []);
});

it("stores state-owned registrations relative while preserving external paths", () => {
  const stateDir = createTempStateDir();
  const externalStateDir = createTempStateDir();
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const inRootPath = path.join(stateDir, "agents", "worker-1", "agent", "openclaw-agent.sqlite");
  const externalPath = path.join(externalStateDir, "external.sqlite");
  registerOpenClawAgentDatabase({ agentId: "worker-1", path: inRootPath, env });
  registerOpenClawAgentDatabase({ agentId: "external", path: externalPath, env });
  const stateDatabase = openState({ env });
  expectRows(stateDatabase.db, "SELECT agent_id, path FROM agent_databases ORDER BY agent_id", [
    { agent_id: "external", path: externalPath },
    {
      agent_id: "worker-1",
      path: path.join("agents", "worker-1", "agent", "openclaw-agent.sqlite"),
    },
  ]);
  expectRegistered(env, [
    { agentId: "external", path: externalPath },
    { agentId: "worker-1", path: inRootPath },
  ]);
  execute(
    stateDatabase.db,
    `INSERT INTO agent_databases (
         agent_id, path, schema_version, last_seen_at, size_bytes
       ) VALUES (?, ?, ?, 0, NULL)`,
    "worker-1",
    inRootPath,
    OPENCLAW_AGENT_SCHEMA_VERSION,
  );
  unregisterOpenClawAgentDatabase({ agentId: "worker-1", path: inRootPath, env });
  expectRows(
    stateDatabase.db,
    "SELECT path FROM agent_databases WHERE agent_id = ?",
    [],
    "worker-1",
  );
  unregisterOpenClawAgentDatabase({ agentId: "external", path: externalPath, env });
  expectRegistered(env, []);
});

it("keeps incompatible schema versions maintenance-only", () => {
  const { stateDir, env } = createState();
  const dbPath = path.join(stateDir, "agents", "legacy", "agent", "openclaw-agent.sqlite");
  registerOpenClawAgentDatabase({
    agentId: "legacy",
    path: dbPath,
    env,
    schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
  });
  expectRegistered(env, []);
  expect(
    registeredAgentDbs({
      env,
      includeIncompatibleSchemaVersions: true,
    }),
  ).toEqual([
    expect.objectContaining({
      agentId: "legacy",
      path: dbPath,
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
    }),
  ]);
});

it.skipIf(process.platform === "win32")(
  "fails closed when the missing registry has a dangling parent symlink",
  () => {
    const { stateDir, env } = createState();
    fs.symlinkSync(path.join(stateDir, "missing-state"), path.join(stateDir, "state"), "dir");
    expect(() => registeredAgentDbs({ env })).toThrow("is unavailable");
  },
);

it("migrates v13 session entries, routes, and generations into nodes and windows", async () => {
  const { options, dbPath } = createDatabaseFixture(materializeV13WorkerAgentDatabase);
  editDatabase(
    dbPath,
    `
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
  `,
  );
  const { db } = await migrateAgentDb(options);
  expectRecord(db, "session_nodes WHERE session_key = 'agent:worker-1:rich'", {
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
  expectRecord(
    db,
    "session_nodes WHERE session_key = ?",
    { created_actor_type: "human", created_actor_id: "legacy-human" },
    "agent:worker-1:created-by",
  );
  expectRecord(
    db,
    "session_nodes WHERE session_key = ?",
    { entry_json: "{}" },
    "agent:worker-1:transcript-only",
  );
  expectRows(
    db,
    "SELECT session_id, session_key, previous_session_id, reason FROM session_windows ORDER BY session_id",
    [
      ["created-by", "created-by", null],
      ["current", "rich", "window-old"],
      ["old", "rich", null],
      ["transcript-only", "transcript-only", null],
    ].map(([id, key, previous]) => ({
      session_id: `window-${id}`,
      session_key: `agent:worker-1:${key}`,
      previous_session_id: previous,
      reason: null,
    })),
  );
  expectRecord(
    db,
    "transcript_rewrite_watermarks WHERE session_id = ?",
    { generation: "rewrite-token" },
    "window-current",
  );
  expectRecord(
    db,
    "session_members WHERE session_key = ?",
    { identity_id: "member-1", added_by: "owner-1" },
    "agent:worker-1:rich",
  );
  expectRows(
    db,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('session_entries', 'session_routes', 'session_transcript_generations')",
    [],
  );
  expectRow(db, "PRAGMA integrity_check", {
    integrity_check: "ok",
  });
  expectRows(db, "PRAGMA foreign_key_check", []);
  expect(readPragma(db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  execute(db, "DELETE FROM session_nodes WHERE session_key = ?", "agent:worker-1:rich");
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
    expect(queryOne(db, `SELECT COUNT(*) AS count FROM ${table}`), table).toEqual({
      count: table === "session_windows" ? 2 : table === "transcript_events" ? 1 : 0,
    });
  }
});

it("retires tenant-free lease storage when upgrading version 16", async () => {
  const { options, dbPath } = createDatabaseFixture(materializeV21WorkerAgentDatabase);
  const legacy = openRawDatabase(dbPath);
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
  const { db } = await migrateAgentDb(options);
  expect(readPragma(db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  expectRecord(db, "schema_meta WHERE meta_key = 'primary'", {
    schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
  });
  expectRows(
    db,
    "SELECT name FROM sqlite_schema WHERE name IN ('state_leases', 'idx_agent_state_leases_expiry', 'idx_agent_state_leases_owner')",
    [],
  );
});

it("refuses pre-July trajectory_runtime_events without discarding its rows", async () => {
  const table = "trajectory_runtime_events";
  const schema = `CREATE TABLE trajectory_runtime_events (
      event_id INTEGER NOT NULL PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT,
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    INSERT INTO trajectory_runtime_events VALUES
      (1, 'legacy-session', 'run-1', 1, '{"type":"runtime"}', 20);`;
  const { options, dbPath } = createDatabaseFixture(materializeV13WorkerAgentDatabase);
  const legacy = openRawDatabase(dbPath);
  legacy.exec(`
    INSERT INTO sessions (session_id, session_key, created_at, updated_at)
    VALUES ('legacy-session', 'agent:worker-1:legacy-session', 10, 20);
    DROP TABLE ${table};
    ${schema}
    PRAGMA user_version = 9;
    UPDATE schema_meta SET schema_version = 9 WHERE meta_key = 'primary';
  `);
  const originalRows = queryAll(legacy, `SELECT * FROM ${table}`);
  const originalSchema = queryOne(legacy, "SELECT sql FROM sqlite_schema WHERE name = ?", table);
  legacy.close();
  await expect(migrateAgentDb(options)).rejects.toThrow(
    "Upgrades from pre-July-2026 state are no longer migrated",
  );
  using preserved = openRawDatabase(dbPath, true);
  expectRows(preserved, `SELECT * FROM ${table}`, originalRows);
  expectRow(preserved, "SELECT sql FROM sqlite_schema WHERE name = ?", originalSchema, table);
  expect(readPragma(preserved, "user_version")).toBe(9);
  expectRecord(preserved, "schema_meta WHERE meta_key = 'primary'", {
    schema_version: 9,
  });
});

it("refuses unreleased version 1 session tables with none cache without changing the database", () => {
  const { env, options } = createState();
  const dbPath = agentDbPath(options);
  seedVersion1MemoryAgentDatabase(dbPath);
  editDatabase(
    dbPath,
    `
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO sessions VALUES ('retained-session', 'agent:worker-1:main', 1, 2);
      PRAGMA user_version = 1;
      UPDATE schema_meta SET schema_version = 1 WHERE meta_key = 'primary';
    `,
  );
  const before = fs.readFileSync(dbPath);
  {
    using candidate = openRawDatabase(dbPath);
    expect(() => ensureSchema(candidate, options)).toThrow(
      "contains an unreleased session schema (version 1)",
    );
    expectRows(candidate, "SELECT * FROM sessions", [
      {
        session_id: "retained-session",
        session_key: "agent:worker-1:main",
        created_at: 1,
        updated_at: 2,
      },
    ]);
    expect(readPragma(candidate, "user_version")).toBe(1);
  }
  expect(fs.readFileSync(dbPath)).toEqual(before);
  expect(fs.existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
});

it("migrates version 8 tables to STRICT without losing agent state", async () => {
  const { options, dbPath } = createDatabaseFixture(materializeV21WorkerAgentDatabase);
  const legacy = openRawDatabase(dbPath);
  execute(
    legacy,
    "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
    "last-good",
    '{"profile":"primary"}',
    10,
  );
  legacy.exec(`
    ALTER TABLE auth_profile_state RENAME TO auth_profile_state_strict;
    ${legacyTableDefinition("auth_profile_state", "auth_profile_state").replace(") STRICT;", ");")}
    INSERT INTO auth_profile_state SELECT * FROM auth_profile_state_strict;
    DROP TABLE auth_profile_state_strict;
    DROP TRIGGER memory_index_sources_revision_after_insert;
    DROP TRIGGER memory_index_sources_revision_after_update;
    DROP TRIGGER memory_index_sources_revision_after_delete;
    ALTER TABLE memory_index_sources RENAME TO memory_index_sources_strict;
    ${legacyTableDefinition("memory_index_sources", "memory_index_sources").replace("mtime REAL", "mtime INTEGER").replace(") STRICT;", ");")}
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
  const { db } = await migrateAgentDb(options);
  expectRecord(db, "pragma_table_list WHERE name = 'auth_profile_state'", { strict: 1 });
  expectRow(db, "SELECT * FROM auth_profile_state", {
    state_key: "last-good",
    state_json: '{"profile":"primary"}',
    updated_at: 10,
  });
  expectRow(db, "SELECT mtime, typeof(mtime) AS storage_type FROM memory_index_sources", {
    mtime: 10.75,
    storage_type: "real",
  });
  expectRecord(db, "pragma_table_list WHERE name = 'session_transcript_active_events'", {
    strict: 1,
  });
  expect(
    queryAll(db, "PRAGMA table_info(session_transcript_index_state)").map(
      (column) => (column as { name: string }).name,
    ),
  ).toEqual(expect.arrayContaining(["active_event_count", "active_message_count"]));
  expect(readPragma(db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  expectRecord(db, "schema_meta WHERE meta_key = 'primary'", {
    schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
  });
  expectRow(db, "PRAGMA foreign_keys", { foreign_keys: 1 });
});

it("retains a failed-open handle and lease when initialization cleanup also fails", async () => {
  const { env, options, openDb } = createState();
  const database = openAgentDb(options);
  expect(closeAgentDb(database.path)).toBe(true);
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
  expect(() => openDb(database.path, "worker-2")).toThrow("initialization close failed");
  close.mockRestore();
  expect(inspectOwner(database.path)).toEqual({
    status: "owned",
    agentId: "worker-1",
  });
  expect(() => assertNoAgentLeases("worker-2", { env })).toThrow("database is still open");
  expect(() => openDb(database.path, "worker-2")).toThrow("initialization close failed");
  expect(
    readAgentDb(
      ({ db }) => queryOne(db, "SELECT agent_id FROM schema_meta WHERE meta_key = 'primary'"),
      { agentId: "worker-1", env, path: database.path },
    ),
  ).toEqual({ found: true, value: { agent_id: "worker-1" } });
  expect(() =>
    readAgentDb(() => "unused", {
      agentId: "worker-2",
      env,
      path: database.path,
    }),
  ).toThrow("belongs to agent worker-1; requested agent worker-2");
  expect(await disposeOpenClawAgentDatabaseByPath(database.path, { env })).toBe(true);
  expect(() => assertNoAgentLeases("worker-2", { env })).not.toThrow();
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
    {
      using realpathNative = vi.spyOn(fs.realpathSync, "native");
      const matchesPath = createPathMatcher();
      expect(matchesPath(realPath, aliasPath)).toBe(true);
      expect(matchesPath(aliasPath, realPath)).toBe(true);
      const resolvedLocators = realpathNative.mock.calls.flatMap(([pathname]) =>
        pathname === realPath || pathname === aliasPath ? [pathname] : [],
      );
      expect(resolvedLocators.toSorted()).toEqual([aliasPath, realPath].toSorted());
    }
    fs.unlinkSync(aliasDir);
    fs.symlinkSync(otherDir, aliasDir, "dir");
    expect(createPathMatcher()(realPath, aliasPath)).toBe(false);
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
    {
      using realpathNative = vi.spyOn(fs.realpathSync, "native");
      realpathNative.mockImplementation((pathname) => {
        if (!retargeted && path.resolve(String(pathname)) === aliasPath) {
          fs.unlinkSync(aliasDir);
          fs.symlinkSync(secondDir, aliasDir, "dir");
          retargeted = true;
        }
        return originalRealpathNative(pathname);
      });
      const matchesPath = createPathMatcher();
      expect(matchesPath(aliasPath, firstPath)).toBe(false);
      expect(matchesPath(aliasPath, secondPath)).toBe(true);
      expect(retargeted).toBe(true);
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
    {
      using lstatSync = vi.spyOn(fs, "lstatSync");
      lstatSync.mockImplementation((pathname, options) => {
        if (!retargeted && path.resolve(String(pathname)) === racedPath) {
          fs.renameSync(firstParent, movedFirstParent);
          fs.symlinkSync(secondParent, firstParent, "dir");
          retargeted = true;
        }
        return originalLstatSync(pathname, options as never);
      });
      const matchesPath = createPathMatcher();
      expect(matchesPath(racedPath, movedFirstPath)).toBe(false);
      expect(matchesPath(racedPath, secondPath)).toBe(true);
      expect(retargeted).toBe(true);
    }
  },
);

it.runIf(process.platform !== "win32")(
  "resolves registered owners through symlinked database paths",
  () => {
    const stateDir = fs.realpathSync(createTempStateDir());
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const at = (...parts: string[]) => path.join(stateDir, ...parts);
    for (const dir of ["real/deep", "redirect/nested", "other/nested", "repeat", "rewrite/K"]) {
      fs.mkdirSync(at(...dir.split("/")), { recursive: true });
    }
    const realPath = at("real", "worker.sqlite");
    const aliasPath = at("alias", "worker.sqlite");
    const links: Array<[string, string, ("dir" | undefined)?]> = [
      [at("real"), at("alias"), "dir"],
      [at("real", "future.sqlite"), at("future-alias.sqlite")],
      [at("real", "deep"), at("deep-alias"), "dir"],
      ["../relative.sqlite", at("deep-alias", "relative.sqlite")],
      [at("redirect", "nested"), at("redirect-link"), "dir"],
      ["redirect-link/../redirect.sqlite", at("redirect-alias.sqlite")],
      ["missing/../live.sqlite", at("dangling.sqlite")],
      [at("other", "nested"), at("parent-link"), "dir"],
      [at("loop.sqlite"), at("loop.sqlite")],
      ["expanding-loop.sqlite/child", at("expanding-loop.sqlite")],
      [".", at("repeat", "self"), "dir"],
      [".", at("rewrite", "L"), "dir"],
      ["L/K", at("rewrite", "J")],
    ];
    for (const [target, link, type] of links) {
      fs.symlinkSync(target, link, type);
    }
    fs.writeFileSync(at("live.sqlite"), "live");
    expect(fs.existsSync(realPath)).toBe(false);
    const rawMissing = `${stateDir}${path.sep}missing${path.sep}..${path.sep}live.sqlite`;
    const rawParent = `${at("parent-link")}${path.sep}..${path.sep}owned.sqlite`;
    const comparisons: Array<[string, string, boolean]> = [
      [realPath, aliasPath, true],
      [at("real", "future.sqlite"), at("future-alias.sqlite"), true],
      [at("real", "relative.sqlite"), at("deep-alias", "relative.sqlite"), true],
      [at("redirect", "redirect.sqlite"), at("redirect-alias.sqlite"), true],
      [at("redirect.sqlite"), at("redirect-alias.sqlite"), false],
      [at("dangling.sqlite"), at("live.sqlite"), false],
      [rawMissing, at("live.sqlite"), false],
      [rawParent, at("other", "owned.sqlite"), true],
      [rawParent, at("owned.sqlite"), false],
      [at("repeat", "repeated.sqlite"), at("repeat", "self", "self", "repeated.sqlite"), true],
      [at("rewrite", "K", "db.sqlite"), at("rewrite", "L", "J", "db.sqlite"), true],
    ];
    for (const [left, right, expected] of comparisons) {
      expect(isSamePath(left, right), `${left} -> ${right}`).toBe(expected);
    }
    for (const loop of ["loop.sqlite", "expanding-loop.sqlite"]) {
      expect(() => isSamePath(at(loop), realPath)).toThrow(
        expect.objectContaining({ code: "ELOOP" }),
      );
    }
    const database = openAgentDb({ agentId: "worker", env, path: realPath });
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
  expect(isSamePath(path.join(stateDir, left), path.join(stateDir, right))).toBe(false);
});

it.runIf(tempVolumeIsCaseInsensitive)(
  "matches nested missing aliases using exact component case semantics",
  () => {
    const stateDir = fs.realpathSync(createTempStateDir());
    expect(
      isSamePath(
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
    expect(isSamePath(path.join(stateDir, "café.sqlite"), path.join(stateDir, "café.sqlite"))).toBe(
      true,
    );
  },
);

it.runIf(process.platform === "win32")(
  "matches drive-relative and absolute database paths without collapsing the suffix",
  () => {
    const cwd = process.cwd();
    const drive = path.parse(cwd).root.slice(0, 2);
    const absolutePath = path.join(cwd, "future-drive-relative.sqlite");
    const driveRelativePath = `${drive}future-drive-relative.sqlite`;
    expect(isSamePath(driveRelativePath, absolutePath)).toBe(true);
  },
);

it("keys explicit relative paths by resolved database pathname", () => {
  const { env } = createState();
  const root = createTempStateDir();
  ["first", "second"].forEach((name) => fs.mkdirSync(path.join(root, name)));
  const output = runAgentScript(
    `
          const env = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
          const root = process.env.OPENCLAW_AGENT_TEST_ROOT;
          try {
            const [first, second] = ["first", "second"].map((name) => {
              process.chdir(path.join(root, name));
              return agent.openOpenClawAgentDatabase({ agentId: "worker-1", env, path: "agent.sqlite" });
            });
            console.log(JSON.stringify({
              sameHandle: first === second,
              firstFileExists: fs.existsSync(path.join(root, "first", "agent.sqlite")),
              secondFileExists: fs.existsSync(path.join(root, "second", "agent.sqlite")),
              registeredPaths: agent.listOpenClawRegisteredAgentDatabases({ env })
                .filter((entry) => entry.agentId === "worker-1").map((entry) => entry.path),
              expectedPaths: [first.path, second.path].toSorted(),
            }));
          } finally {
            agent.closeOpenClawAgentDatabasesForTest();
            state.closeOpenClawStateDatabaseForTest();
          }
        `,
    { ...env, OPENCLAW_AGENT_TEST_ROOT: root },
  );
  const result = JSON.parse(output) as {
    expectedPaths: string[];
    firstFileExists: boolean;
    registeredPaths: string[];
    sameHandle: boolean;
    secondFileExists: boolean;
  };
  expect(result).toMatchObject({
    sameHandle: false,
    firstFileExists: true,
    secondFileExists: true,
    registeredPaths: result.expectedPaths,
  });
});

it("rejects sharing one explicit database path across agent ids", () => {
  const { stateDir, openDb } = createState();
  const dbPath = path.join(stateDir, "relocated", "shared.sqlite");
  openDb(dbPath);
  expect(() => openDb(dbPath, "worker-2")).toThrow(/already open for agent worker-1/);
  closeAgentDbs();
  expect(() => openDb(dbPath, "worker-2")).toThrow(/belongs to agent worker-1/);
});

it("closes only the cached database at the exact resolved path", () => {
  const { stateDir, openDb } = createState();
  const firstPath = path.join(stateDir, "relocated", "first.sqlite");
  const secondPath = path.join(stateDir, "relocated", "second.sqlite");
  const first = openDb(firstPath);
  const second = openDb(secondPath, "worker-2");
  expect(closeAgentDb(path.join(stateDir, "missing.sqlite"))).toBe(false);
  expect(closeAgentDb(firstPath, "worker-2")).toBe(false);
  expect([first.db.isOpen, second.db.isOpen]).toEqual([true, true]);
  expect(
    closeAgentDb(path.join(stateDir, "relocated", "nested", "..", "first.sqlite"), "worker-1"),
  ).toBe(true);
  expect([first.db.isOpen, second.db.isOpen]).toEqual([false, true]);
  expect(closeAgentDb(firstPath)).toBe(false);
  const reopened = openDb(firstPath);
  expect(reopened).not.toBe(first);
  expect([reopened.db.isOpen, second.db.isOpen]).toEqual([true, true]);
});

it("retains its durable lease when closing the handle fails", () => {
  const { env, options } = createState();
  const database = openAgentDb(options);
  const close = vi.spyOn(database.walMaintenance, "close").mockImplementationOnce(() => {
    throw new Error("wal close failed");
  });
  expect(() => closeAgentDb(database.path)).toThrow("wal close failed");
  expect(database.db.isOpen).toBe(true);
  expect(() => assertNoAgentLeases("worker-1", { env })).toThrow("database is still open");
  close.mockRestore();
  expect(closeAgentDb(database.path)).toBe(true);
  expect(() => assertNoAgentLeases("worker-1", { env })).not.toThrow();
});

it("settles a Worker lease after a recoverable handle-close failure", () => {
  const { env, options } = createState();
  const database = openAgentDb(options);
  vi.spyOn(database.walMaintenance, "close").mockImplementationOnce(() => {
    throw new Error("wal close failed");
  });
  const settled = settleWorkerClose(database.path);
  expect(settled).toMatchObject({ settled: true });
  expect(settled.errors.map((error) => error.message)).toEqual(["wal close failed"]);
  expect(database.db.isOpen).toBe(false);
  expect(() => assertNoAgentLeases("worker-1", { env })).not.toThrow();
});

it("keeps the deleted id fenced until its completed tombstone is claimed", () => {
  const { env, dbPath, deletion, registerDb, unregisterDb } = deletedFixture();
  expect(() => registerDb("worker-1", dbPath)).toThrow("agent worker-1 is deleted");
  expect(() => registerDb("worker-2", dbPath)).not.toThrow();
  unregisterDb("worker-2", dbPath);
  expect(claimDeletion("worker-1", deletion.operationId, { env })).toBe(true);
  expect(() => registerDb("worker-1", dbPath)).not.toThrow();
  unregisterDb("worker-1", dbPath);
});

it("lets only the creating identity lease over its own completed tombstone", async () => {
  const { env, options, dbPath, deletion, claimLease, releaseLease, registerDb, unregisterDb } =
    deletedFixture(false);
  const claimAsWorker = () => claimLease("worker-1", dbPath);
  // Creation never bypasses a deletion whose cleanup is still pending.
  await withCreation(options, async () => {
    expect(claimAsWorker).toThrow("agent worker-1 is deleted");
  });
  completeDeletion(deletion, env);
  // A completed tombstone still fences everything outside the creation lifecycle.
  expect(claimAsWorker).toThrow("agent worker-1 is deleted");
  await withCreation({ agentId: "other", env }, async () => {
    expect(claimAsWorker).toThrow("agent worker-1 is deleted");
  });
  const foreignStateEnv = { OPENCLAW_STATE_DIR: createTempStateDir() };
  await withCreation({ agentId: "worker-1", env: foreignStateEnv }, async () => {
    expect(claimAsWorker).toThrow("agent worker-1 is deleted");
  });
  await withCreation(options, async () => {
    const leaseId = claimAsWorker();
    releaseLease(leaseId);
    registerDb("worker-1", dbPath);
    unregisterDb("worker-1", dbPath);
  });
  expect(claimDeletion("worker-1", deletion.operationId, { env })).toBe(true);
});

it("keeps creation-claimed handles private and closes them when the claim settles", async () => {
  const { agentDir, env, dbPath, deletion } = deletedFixture();
  const options = { agentId: "worker-1", path: dbPath, env };
  const writeMarker = (marker: string) =>
    writeAgent((database) => {
      execute(
        database.db,
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'memory', ?, 1, 1)",
        `${marker}.md`,
        marker,
      );
    }, options);
  const claimAsWorker = () => claimAgentLease(options);
  // Ordinary writers run outside the creation scope even while it is live.
  const outsideCreation = AsyncLocalStorage.snapshot();
  const aliasStateEnv = { OPENCLAW_STATE_DIR: createTempStateDir() };
  const aliasDir = path.join(aliasStateEnv.OPENCLAW_STATE_DIR, "agent-alias");
  const openAliasOutside = () =>
    outsideCreation(() =>
      openAgentDb({
        agentId: "worker-1",
        path: path.join(aliasDir, "openclaw-agent.sqlite"),
        env: aliasStateEnv,
      }),
    );
  const settled = createDeferred();
  let retainedClaim: Promise<string> | undefined;
  await withCreation({ agentId: "worker-1", env }, async () => {
    writeMarker("inside");
    expect(isAgentDbOpen(dbPath)).toBe(true);
    expect(() => outsideCreation(() => writeMarker("outside"))).toThrow(
      "active agent creation claim",
    );
    fs.symlinkSync(agentDir, aliasDir, "junction");
    expect(openAliasOutside).toThrow("active agent creation claim");
    // A continuation retained past settlement keeps this store but no authority.
    retainedClaim = settled.promise.then(claimAsWorker);
  });
  expect(isAgentDbOpen(dbPath)).toBe(false);
  expect(claimAsWorker).toThrow("agent worker-1 is deleted");
  expect(() => writeMarker("after")).toThrow("agent worker-1 is deleted");
  settled.resolve();
  await expect(retainedClaim).rejects.toThrow("agent worker-1 is deleted");
  // Coalesced callers must keep their own authority after a shared async open.
  await withCreation({ agentId: "worker-1", env }, async () => {
    const admitted = withAgentDb(options, () => "inside");
    const outside = outsideCreation(() => withAgentDb(options, () => "outside"));
    await Promise.all([
      expect(admitted).resolves.toBe("inside"),
      expect(outside).rejects.toThrow("active agent creation claim"),
    ]);
  });
  expect(isAgentDbOpen(dbPath)).toBe(false);
  // Retiring a claim during a real integrity read must precede index repair, not only exposure.
  invalidateValidation(dbPath);
  revokeAdmissions(dbPath);
  {
    using editor = nodeSqlite.openNodeSqliteDatabase(dbPath);
    editor.exec("DROP INDEX idx_agent_cache_expiry");
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
  const retiring = withCreation({ agentId: "worker-1", env }, async () => {
    rejected = expect(
      withAgentDb(options, () => {
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
    expect(() => assertNoAgentLeases("worker-1", { env })).toThrow("database is still open");
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
  {
    using reader = nodeSqlite.openNodeSqliteDatabase(dbPath, { readOnly: true });
    expect(
      queryOne(reader, "SELECT name FROM sqlite_schema WHERE name='idx_agent_cache_expiry'"),
    ).toBeUndefined();
  }
  expect(operationCalled).toBe(false);
  expect(() => assertNoAgentLeases("worker-1", { env })).not.toThrow();
  // A fresh claim can repair the index and write, then still close if its body fails.
  await expect(
    withCreation({ agentId: "worker-1", env }, async () => {
      writeMarker("failed");
      throw new Error("creation failed");
    }),
  ).rejects.toThrow("creation failed");
  expect(isAgentDbOpen(dbPath)).toBe(false);
  expect(() => writeMarker("after-failure")).toThrow("agent worker-1 is deleted");
  expect(claimDeletion("worker-1", deletion.operationId, { env })).toBe(true);
  writeMarker("published");
  expect(isAgentDbOpen(dbPath)).toBe(true);
});

it("serializes database leases with the durable deletion fence", () => {
  const { stateDir, env, claimLease, releaseLease } = createState();
  const dbPath = path.join(stateDir, "agents", "worker-1", "openclaw-agent.sqlite");
  const leaseId = claimLease("worker-1", dbPath);
  const deletion = beginDeletion(env, { agentDir: path.dirname(dbPath) });
  try {
    expect(() => assertNoAgentLeases("worker-1", { env })).toThrow("database is still open");
    expect(() => claimLease("worker-1", dbPath)).toThrow("agent worker-1 is deleted");
    releaseLease(leaseId);
    expect(() => assertNoAgentLeases("worker-1", { env })).not.toThrow();
  } finally {
    releaseLease(leaseId);
    removeDeletion(deletion.agentId, deletion.operationId, { env });
  }
});

it("closes cached agent databases and fences new writers during maintenance", async () => {
  const { stateDir, env, options, claimLease } = createState();
  const database = openAgentDb(options);
  let assertRetainedOwnership: (() => void) | undefined;
  await withMaintenance({ env }, async (maintenance) => {
    assertRetainedOwnership = () => maintenance.assertOwned();
    expect(database.db.isOpen).toBe(false);
    expect(() => openAgentDb(options)).toThrow("Agent database maintenance is in progress");
    expect(() => claimLease("worker-2", path.join(stateDir, "worker-2.sqlite"))).toThrow(
      "Agent database maintenance is in progress",
    );
    expect(() =>
      writeState(({ db }) => maintenance.assertOwnedInTransaction(db), {
        env,
      }),
    ).not.toThrow();
  });
  expect(assertRetainedOwnership).toBeDefined();
  expect(() => assertRetainedOwnership?.()).toThrow("Agent database maintenance scope is closed");
  expect(openAgentDb(options).db.isOpen).toBe(true);
});

it("refuses maintenance while another owner still holds an agent database lease", async () => {
  const { stateDir, env, claimLease, releaseLease } = createState();
  const leaseId = claimLease("worker-1", path.join(stateDir, "worker-1.sqlite"));
  const repair = vi.fn(async () => undefined);
  try {
    await expect(withMaintenance({ env }, repair)).rejects.toThrow(
      "stop the Gateway and other OpenClaw processes, or reboot, then rerun openclaw doctor --fix",
    );
    expect(repair).not.toHaveBeenCalled();
    expect(() => assertNoAgentLeases("worker-1", { env })).toThrow("database is still open");
  } finally {
    releaseLease(leaseId);
  }
  await expect(withMaintenance({ env }, repair)).resolves.toBeUndefined();
  expect(repair).toHaveBeenCalledOnce();
});

it("removes dead agent database owners before beginning fenced maintenance", async () => {
  const { stateDir, env, claimLease } = createState();
  const leaseId = claimLease("worker-1", path.join(stateDir, "worker-1.sqlite"));
  writeState(
    ({ db }) =>
      execute(db, "UPDATE agent_database_leases SET owner_pid = -1 WHERE lease_id = ?", leaseId),
    { env },
  );
  await withMaintenance({ env }, async () => {
    expect(
      queryOne(
        openState({ env }).db,
        "SELECT lease_id FROM agent_database_leases WHERE lease_id = ?",
        leaseId,
      ),
    ).toBeUndefined();
  });
});

it("preserves ownership when another initializer wins before the schema transaction", () => {
  const { stateDir, env } = createState();
  openState({ env });
  const dbPath = path.join(stateDir, "shared.sqlite");
  using pending = openRawDatabase(dbPath);
  using winner = openRawDatabase(dbPath);
  const exec = pending.exec.bind(pending);
  let preparingSchema = false;
  vi.spyOn(pending, "exec").mockImplementation((sql) => {
    if (sql.includes("PRAGMA foreign_keys = OFF")) {
      preparingSchema = true;
    }
    if (preparingSchema && sql.trimStart().startsWith("BEGIN IMMEDIATE")) {
      preparingSchema = false;
      // Commit a real competing initialization after preparation, before the writer lock.
      ensureSchema(winner, {
        agentId: "worker-b",
        env,
        path: dbPath,
        register: true,
      });
    }
    return exec(sql);
  });
  expect(() =>
    ensureSchema(pending, {
      agentId: "worker-a",
      env,
      path: dbPath,
      register: true,
    }),
  ).toThrow("belongs to agent worker-b");
  expect(inspectOwner(dbPath)).toEqual({
    status: "owned",
    agentId: "worker-b",
  });
  expectRegistered(env, [{ agentId: "worker-b", path: dbPath }]);
});

it("serializes concurrent ownership claims for one unowned database", async () => {
  const stateDir = createTempStateDir();
  openState({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const dbPath = path.join(stateDir, "relocated", "shared.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const lockDb = openRawDatabase(dbPath);
  lockDb.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
  const openers = [
    launchAgentSchemaOpener({ agentId: "worker-a", dbPath, stateDir }),
    launchAgentSchemaOpener({ agentId: "worker-b", dbPath, stateDir }),
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
    expect(inspectOwner(dbPath)).toEqual({
      status: "owned",
      agentId: winner?.agentId,
    });
    expectRegistered({ OPENCLAW_STATE_DIR: stateDir }, [
      {
        agentId: winner?.agentId,
        path: dbPath,
        schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      },
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
  const { stateDir, env } = createState();
  const state = openState({ env });
  const dbPath = path.join(stateDir, "relocated", "future.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const lockDb = openRawDatabase(dbPath);
  lockDb.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
  const opener = launchAgentSchemaOpener({
    agentId: "worker-a",
    dbPath,
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
      using db = openRawDatabase(dbPath, true);
      expect(readPragma(db, "user_version")).toBe(futureVersion);
      expect(
        queryOne(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'"),
      ).toBeUndefined();
    }
    expectRows(state.db, "SELECT * FROM agent_deletion_journal", []);
    expectRegistered(env, []);
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
  const dbPath = path.join(parentDir, "worker-1.sqlite");
  openAgentDb({
    agentId: "worker-1",
    env,
    path: dbPath,
  });
  expect(fs.statSync(parentDir).mode & 0o777).toBe(0o755);
});

it("repairs every missing or drifted canonical agent-state named index", () => {
  const { options, dbPath } = createDatabaseFixture();
  const canonicalShape = normalizeSqliteSchemaShapeSql(
    createSqliteSchemaShapeFromSql(new URL("./openclaw-agent-schema.sql", import.meta.url)),
  );
  createCanonicalAgentIndexDrift(dbPath);
  const reopened = openAgentDb(options);
  expect(
    normalizeSqliteSchemaShapeSql(
      collectSqliteSchemaShape(requireNativeSqliteDatabase(reopened.db)),
    ),
  ).toEqual(canonicalShape);
  expect(readPragma(reopened.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  expectRows(
    reopened.db,
    "SELECT seq, run_id, event_json, created_at FROM trajectory_runtime_events ORDER BY seq",
    [
      { seq: 0, run_id: null, event_json: '{"type":"unassigned"}', created_at: 1 },
      { seq: 1, run_id: "run-1", event_json: '{"type":"named"}', created_at: 2 },
    ],
  );
});

it("repairs schema-19 additive session-key surfaces before upgrading schema validation", async () => {
  const { options, dbPath } = createDatabaseFixture(materializeV21WorkerAgentDatabase);
  const expectedShape = createSqliteSchemaShapeFromSql(
    new URL("./openclaw-agent-schema.sql", import.meta.url),
  );
  const shippedSchema = openRawDatabase(dbPath);
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
    expect(readPragma(shippedSchema, "user_version")).toBe(19);
  } finally {
    shippedSchema.close();
  }
  const { db } = await migrateAgentDb(options);
  expect(
    normalizeSqliteSchemaShapeSql(collectSqliteSchemaShape(requireNativeSqliteDatabase(db))),
  ).toEqual(normalizeSqliteSchemaShapeSql(expectedShape));
  expectRecord(
    db,
    "session_nodes WHERE session_key = ?",
    { entry_valid: 1 },
    "agent:worker-1:session-1",
  );
  expectRecord(db, "session_key_contract WHERE id = 1", {
    main_key: "main",
  });
  expectRecord(db, "pragma_table_info('session_conversations') WHERE name = 'route_context_json'", {
    name: "route_context_json",
  });
});

it("installs schema-19 session additions before maintenance index repair", async () => {
  const { env, dbPath } = createDatabaseFixture(materializeV21WorkerAgentDatabase);
  {
    using drifted = openRawDatabase(dbPath);
    removeCanonicalValidationFromHistoricalAgentFixture(drifted);
    execute(
      drifted,
      `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
         VALUES (?, ?, ?, ?)`,
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
  }
  materializeSharedStateDatabase(env);
  await withMaintenance({ env }, (maintenance) =>
    migrateMaintenanceDb({ agentId: "worker-1", pathname: dbPath }, maintenance),
  );
  using repaired = openRawDatabase(dbPath, true);
  expectRecord(
    repaired,
    "session_nodes WHERE session_key = ?",
    { entry_valid: 1 },
    "agent:worker-1:maintenance",
  );
  expectRecord(repaired, "session_key_contract WHERE id = 1", {
    main_key: "main",
  });
  expect(() =>
    assertMaintenanceDb(repaired, {
      agentId: "worker-1",
      pathname: dbPath,
    }),
  ).not.toThrow();
});

it("rejects a missing stable table at the current version instead of recreating it empty", async () => {
  const { env, options, dbPath } = createDatabaseFixture();
  editDatabase(dbPath, "DROP TABLE auth_profile_store;");
  await expect(migrateAgentDb(options)).rejects.toThrow(/missing table auth_profile_store/iu);
  await expect(
    withMaintenance({ env }, (maintenance) =>
      migrateMaintenanceDb({ agentId: "worker-1", pathname: dbPath }, maintenance),
    ),
  ).rejects.toThrow(/missing table auth_profile_store/iu);
  using after = openRawDatabase(dbPath, true);
  expect(
    queryOne(
      after,
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'auth_profile_store'",
    ),
  ).toBeUndefined();
});

it("adds post-v14 suggestion tables during the v15 migration", async () => {
  const { options, dbPath } = createDatabaseFixture(materializeV21WorkerAgentDatabase);
  const legacy = openRawDatabase(dbPath);
  removeCanonicalValidationFromHistoricalAgentFixture(legacy);
  legacy.exec(`
    DROP TABLE session_suggestions;
    DROP TABLE session_participants;
    PRAGMA user_version = 14;
    UPDATE schema_meta SET schema_version = 14 WHERE meta_key = 'primary';
  `);
  legacy.close();
  const { db } = await migrateAgentDb(options);
  expectRecord(db, "sqlite_schema WHERE type = 'table' AND name = 'session_suggestions'", {
    name: "session_suggestions",
  });
});

it("rejects an inline unique constraint hidden behind a SQLite autoindex", async () => {
  const { env, options, dbPath } = createDatabaseFixture();
  editDatabase(
    dbPath,
    `
    DROP TABLE cache_entries;
    ${legacyTableDefinition("cache_entries", "cache_entries").replace("scope TEXT NOT NULL", "scope TEXT NOT NULL UNIQUE")}
    CREATE INDEX idx_agent_cache_expiry
      ON cache_entries(key);
    CREATE INDEX idx_agent_cache_updated
      ON cache_entries(scope, updated_at DESC, key);
  `,
  );
  expect(() => openAgentDb(options)).toThrow(/unexpected unique index on cache_entries/iu);
  await expect(
    withMaintenance({ env }, (maintenance) =>
      migrateMaintenanceDb({ agentId: "worker-1", pathname: dbPath }, maintenance),
    ),
  ).rejects.toThrow(/unexpected unique index on cache_entries/iu);
  using after = openRawDatabase(dbPath, true);
  expectRecord(after, "sqlite_schema WHERE type = 'index' AND name = 'idx_agent_cache_expiry'", {
    sql: "CREATE INDEX idx_agent_cache_expiry\n      ON cache_entries(key)",
  });
});

it("rejects same-name transcript index drift when duplicate rows block repair", () => {
  const { options, dbPath } = createDatabaseFixture();
  createTranscriptIdempotencyIndexDrift(dbPath, { duplicateRows: true });
  expect(() => openAgentDb(options)).toThrow(
    /canonical index idx_agent_transcript_message_idempotency failed.*UNIQUE constraint failed/iu,
  );
  using after = openRawDatabase(dbPath, true);
  expectRecord(
    after,
    "sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_message_idempotency'",
    {
      sql: expect.stringContaining("ON transcript_event_identities(session_id, event_id)"),
    },
  );
  expectRow(
    after,
    "SELECT COUNT(*) AS count FROM transcript_event_identities WHERE message_idempotency_key = 'message-1'",
    { count: 2 },
  );
  expectRows(
    after,
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'openclaw_probe_%'",
    [],
  );
});

it("repairs null schema metadata on the current-schema path without rewriting it again", () => {
  const { options } = createState();
  const dbPath = openAgentDb(options).path;
  closeAgentDbs();
  const corrupt = openRawDatabase(dbPath);
  execute(
    corrupt,
    "UPDATE schema_meta SET app_version = NULL, updated_at = 1 WHERE meta_key = 'primary'",
  );
  corrupt.close();
  revokeAdmissions(dbPath);
  openAgentDb(options);
  closeAgentDbs();
  const afterRepair = openRawDatabase(dbPath, true);
  const repaired = queryOne(
    afterRepair,
    "SELECT app_version, updated_at FROM schema_meta WHERE meta_key = 'primary'",
  ) as { app_version: string; updated_at: number };
  afterRepair.close();
  expect(repaired.app_version).toBe(VERSION);
  expect(repaired.updated_at).toBeGreaterThan(1);
  openAgentDb(options);
  closeAgentDbs();
  using afterReopen = openRawDatabase(dbPath, true);
  expectRow(
    afterReopen,
    "SELECT app_version, updated_at FROM schema_meta WHERE meta_key = 'primary'",
    repaired,
  );
});

it("adds the active transcript projection when upgrading v9 databases", async () => {
  const { options, dbPath } = createDatabaseFixture(materializeV13WorkerAgentDatabase);
  editDatabase(
    dbPath,
    `
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
  `,
  );
  const { db } = await migrateAgentDb(options);
  const columns = queryAll(db, "PRAGMA table_info(session_transcript_index_state)") as Array<{
    name?: unknown;
  }>;
  expect(columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(["active_event_count", "active_message_count"]),
  );
  expectRecord(
    db,
    "session_transcript_index_state WHERE session_id = ?",
    {
      active_event_count: 0,
      active_message_count: 0,
      indexed_seq: 1,
      needs_rebuild: 1,
    },
    "session-1",
  );
  expectRecord(
    db,
    "sqlite_master WHERE type = 'table' AND name = 'session_transcript_active_events'",
    { name: "session_transcript_active_events" },
  );
  expectRow(
    db,
    "SELECT length(generation) AS generation_length FROM transcript_rewrite_watermarks WHERE session_id = ?",
    { generation_length: 32 },
    "session-1",
  );
  expect(readPragma(db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
});

it("inspects database ownership for    ", () => {
  const stateDir = createTempStateDir();
  const database = openAgentDb({
    agentId: "worker-1",
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
  const dbPath = database.path;
  closeAgentDbs();
  {
    replaceDatabase(dbPath);
    using raw = openRawDatabase(dbPath);
    execute(raw, "UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'", "   ");
  }
  expect(inspectOwner(dbPath)).toEqual({ status: "unreadable" });
});

it("revalidates default and relocated replacements after agent unregister", () => {
  const { stateDir, env, options, openDb } = createState();
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const databasePaths = [
      openAgentDb(options).path,
      openDb(path.join(stateDir, "relocated.sqlite")).path,
    ];
    const unrelatedPath = openDb(undefined, "worker-2").path;
    for (const dbPath of [...databasePaths, unrelatedPath]) {
      expect(closeAgentDb(dbPath)).toBe(true);
    }
    unregisterAgent(options);
    expectRegistered(env, [{ agentId: "worker-2", path: unrelatedPath }]);
    nowSpy.mockReturnValue(2_000);
    for (const dbPath of databasePaths) {
      fs.copyFileSync(ensureCurrentWorkerAgentDatabaseTemplate(), dbPath);
      const reopened = openDb(dbPath);
      expect(readPragma(reopened.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    }
    openDb(undefined, "worker-2");
    expect(registeredAgentDbs({ env })).toEqual(
      expect.arrayContaining([
        ...databasePaths.map((dbPath) =>
          expect.objectContaining({
            agentId: "worker-1",
            path: dbPath,
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
});

it("initializes an empty replacement after physical close without a registry mutation", () => {
  const { env, options, openDb } = createState();
  const database = openAgentDb(options);
  const dbPath = database.path;
  expect(closeAgentDb(dbPath)).toBe(true);
  fs.rmSync(dbPath);
  const reopened = openDb(dbPath);
  expect(readPragma(reopened.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  expectRecord(
    reopened.db,
    "sqlite_schema WHERE type = 'table' AND name = ?",
    { name: "auth_profile_store" },
    "auth_profile_store",
  );
  expectRegistered(env, [{ agentId: "worker-1", path: dbPath }]);
});

it("reopens a validated current-schema database promptly while a WAL writer is active", () => {
  const { options } = createState();
  const dbPath = openAgentDb(options).path;
  expect(closeAgentDb(dbPath)).toBe(true);
  const writer = openRawDatabase(dbPath);
  let reopened: ReturnType<typeof openAgentDb> | undefined;
  try {
    writer.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
    const startedAt = performance.now();
    reopened = openAgentDb(options);
    const elapsedMs = performance.now() - startedAt;
    expect(reopened.db.isOpen).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);
  } finally {
    writer.exec("ROLLBACK;");
    writer.close();
    if (reopened) {
      closeAgentDb(reopened.path);
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
    const { env, options } = createState();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const dbPath = openAgentDb(options).path;
    expect(closeAgentDb(dbPath)).toBe(true);
    replaceDatabase(dbPath);
    createCacheExpiryIndexPhysicalDrift(dbPath);
    const writer = openRawDatabase(dbPath);
    try {
      execute(
        writer,
        "UPDATE schema_meta SET role = ?, agent_id = ? WHERE meta_key = 'primary'",
        role,
        agentId,
      );
      writer.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
      const startedAt = performance.now();
      let failure: unknown;
      try {
        openAgentDb(options);
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
    expectAgentClosed(env, dbPath);
    {
      using restored = openRawDatabase(dbPath);
      expectRows(
        restored,
        "PRAGMA integrity_check('cache_entries')",
        expect.arrayContaining([
          expect.objectContaining({
            integrity_check: expect.stringMatching(/idx_agent_cache_expiry/),
          }),
        ]),
      );
      execute(
        restored,
        "UPDATE schema_meta SET role = 'agent', agent_id = 'worker-1' WHERE meta_key = 'primary'",
      );
    }
    replaceDatabase(dbPath);
    nowSpy.mockReturnValue(2_000);
    try {
      expect(() => openAgentDb(options)).toThrow(
        /integrity_check failed.*idx_agent_cache_expiry.*openclaw doctor --fix/,
      );
      const repair = await migrateLegacyMediaPersistence({
        env,
        configuredAgentDatabaseTargets: [{ agentId: "worker-1", path: dbPath }],
      });
      expect(repair.warnings).toEqual([]);
      openAgentDb(options);
      expect(
        registeredAgentDbs({ env }).find(
          (entry) => entry.agentId === "worker-1" && entry.path === dbPath,
        ),
      ).toMatchObject({ lastSeenAt: 2_000 });
    } finally {
      nowSpy.mockRestore();
    }
  },
);

it("preserves the refusal for a populated v0 database with malformed ownership metadata", () => {
  const { stateDir, env, openDb } = createState();
  const dbPath = path.join(stateDir, "populated-v0.sqlite");
  editDatabase(dbPath, "CREATE TABLE schema_meta (meta_key TEXT);");
  expect(() =>
    readAgentDb(() => "unused", {
      agentId: "worker-1",
      env,
      path: dbPath,
    }),
  ).toThrow(/schema_meta is missing required columns/);
  expect(() => openDb(dbPath)).toThrow(/schema_meta is missing required columns/);
});

it("latches newer per-agent schema failures on a validated physical reopen", () => {
  const { env, options } = createState();
  const dbPath = openAgentDb(options).path;
  expect(closeAgentDb(dbPath)).toBe(true);
  closeStateDb();
  replaceDatabase(dbPath);
  createUnsafeIndexDrift(dbPath);
  editDatabase(dbPath, `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
  let firstFailure: unknown;
  try {
    openAgentDb(options);
  } catch (error) {
    firstFailure = error;
  }
  expect(firstFailure).toMatchObject({
    name: "SqliteSchemaVersionError",
    message: expect.stringContaining("https://docs.openclaw.ai/reference/database-schemas"),
  });
  expectAgentClosed(env, dbPath);
  {
    using stillDrifted = openRawDatabase(dbPath, true);
    expectRecord(stillDrifted, "sqlite_schema WHERE name = 'unsafe_index_records_value'", {
      sql: "CREATE INDEX unsafe_index_records_value ON unsafe_index_records(alternate_value)",
    });
  }
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    fs.rmSync(candidate, { force: true });
  }
  let secondFailure: unknown;
  try {
    openAgentDb(options);
  } catch (error) {
    secondFailure = error;
  }
  expect(secondFailure).toBe(firstFailure);
  clearOpenFailure(dbPath);
  const reopened = openAgentDb(options);
  expect(readPragma(reopened.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  expectRecord(reopened.db, "schema_meta WHERE meta_key = 'primary'", {
    role: "agent",
    agent_id: "worker-1",
  });
  expect(
    registeredAgentDbs({ env }).find(
      (entry) => entry.agentId === "worker-1" && entry.path === dbPath,
    ),
  ).toBeDefined();
});

it("closes cached handles on normal process exit so no stale WAL remains", () => {
  const stateDir = createTempStateDir();
  const output = runAgentScript(
    `
          const database = agent.openOpenClawAgentDatabase({
            agentId: "worker-1",
            env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_AGENT_DB_EXIT_TEST_DIR },
          });
          const walPath = database.path + "-wal";
          console.log(JSON.stringify({
            agentDatabasePath: database.path,
            agentWalBytesBeforeExit: fs.existsSync(walPath) ? fs.statSync(walPath).size : 0,
          }));
        `,
    { OPENCLAW_AGENT_DB_EXIT_TEST_DIR: stateDir },
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

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
