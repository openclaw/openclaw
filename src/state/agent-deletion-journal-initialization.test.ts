import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ensureMemoryIndexSchema } from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareConfigFileWrite } from "../config/backup-rotation.js";
import { withDeferredPluginMigrationsCurrent } from "../infra/deferred-plugin-migrations.js";
import * as stateOwners from "../infra/gateway-state-owner.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { runSqliteIntegrityCheckSync } from "../infra/sqlite-integrity.js";
import { discoverAgentDatabaseMigrationTargets as discoverTargets } from "../infra/state-migrations.media-persistence-targets.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { beginAgentDeletionJournal as beginJournal } from "../test-utils/agent-deletion-journal.js";
import { reconstructAgentDeletionJournal } from "./agent-deletion-journal-recovery.js";
import { ensureOpenClawAgentDatabaseSchemaSteps as schemaSteps } from "./openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabasesForTest as closeAgentDbsForTest,
  ensureOpenClawAgentDatabaseSchema as ensureAgentSchema,
  openOpenClawAgentDatabase as openAgentDb,
} from "./openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath as incognitoSqlitePath } from "./openclaw-agent-db.paths.js";
import { prepareStateDatabaseInitialization } from "./openclaw-state-db-initialization.js";
import {
  closeOpenClawStateDatabaseForTest as closeStateDbForTest,
  initializeNativeOpenClawStateDatabase as initializeNativeState,
  openOpenClawStateDatabase as openStateDb,
  runOpenClawStateWriteTransaction as writeState,
  withOpenClawStateStartupMigrationCheckpointDatabase as withCheckpoint,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath as stateSqlitePath } from "./openclaw-state-db.paths.js";

afterEach(() => {
  closeAgentDbsForTest();
  closeStateDbForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const makeEnv = () => ({ OPENCLAW_STATE_DIR: tempDirs.make("journal-initialization-") });
const legacy = (env: NodeJS.ProcessEnv) =>
  createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 19 });
const configPath = (env: { OPENCLAW_STATE_DIR: string }) =>
  path.join(env.OPENCLAW_STATE_DIR, "openclaw.json");
const writeConfig = (env: { OPENCLAW_STATE_DIR: string }, config: unknown) =>
  fs.writeFileSync(configPath(env), JSON.stringify(config));
const journalTable = (db: EngineConnection) =>
  db.prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'").get();
function removeState(env: NodeJS.ProcessEnv) {
  for (const file of resolveSqliteDatabaseFilePaths(stateSqlitePath(env))) {
    fs.rmSync(file, { force: true });
  }
}
function discover(env: NodeJS.ProcessEnv, pathname?: string) {
  return discoverTargets({
    env,
    configuredAgentDatabaseTargets: pathname ? [{ agentId: "main", path: pathname }] : [],
    registeredAgentDatabases: [],
  });
}

it.each([
  { entry: "runtime", existingAgent: false },
  { entry: "runtime", existingAgent: true },
  { entry: "native", existingAgent: false },
  { entry: "native", existingAgent: true },
])(
  "initializes native-only state without inventing deletion history ($entry, existing agent=$existingAgent)",
  ({ entry, existingAgent }) => {
    const env = makeEnv();
    if (existingAgent) {
      legacy(env);
      closeStateDbForTest();
    }
    const pathname = stateSqlitePath(env);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    removeState(env);
    // The native app creates this schema-zero table before the first core writer.
    using native = new DatabaseSync(pathname);
    native.exec(`
        CREATE TABLE macos_port_guardian_records (
          pid INTEGER NOT NULL PRIMARY KEY, port INTEGER NOT NULL,
          command TEXT NOT NULL, mode TEXT NOT NULL, timestamp REAL NOT NULL
        ) STRICT;
        CREATE INDEX idx_macos_port_guardian_records_port
          ON macos_port_guardian_records(port, timestamp DESC);
        INSERT INTO macos_port_guardian_records VALUES (4242, 18789, '/synthetic/ssh', 'remote', 42.5);
      `);
    native.close();
    if (entry === "native") {
      initializeNativeState({ env });
    }
    const state = openStateDb({ env });
    expect(journalTable(state.db)).toEqual(
      existingAgent ? undefined : { name: "agent_deletion_journal" },
    );
    expect(state.db.prepare("SELECT command FROM macos_port_guardian_records").get()).toEqual({
      command: "/synthetic/ssh",
    });
  },
);

it("preserves missing history for an on-disk incognito store without discovering its reindex lock", async () => {
  const env = makeEnv();
  const pathname = incognitoSqlitePath({ agentId: "main", env });
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  using database = new DatabaseSync(pathname);
  database.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('preserved')");
  using lock = new DatabaseSync(`${pathname}.reindex-lock.sqlite`);
  lock.exec("CREATE TABLE coordination (id INTEGER)");
  const bytes = fs.readFileSync(pathname);

  expect(prepareStateDatabaseInitialization(stateSqlitePath(env), env)).toEqual({
    kind: "existing",
  });
  openStateDb({ env });
  const discovery = discover(env);
  expect(discovery.deletionJournal.status).toBe("unavailable");
  expect(discovery.unverifiedTargets).toEqual([
    expect.objectContaining({ agentId: "main", path: pathname }),
  ]);
  expect(discovery.warnings.join("\n")).toContain("1 store held back");
  expect(discovery.warnings.join("\n")).not.toContain("reindex-lock");
  const migration = await migrateLegacyMediaPersistence({
    env,
    configuredAgentDatabaseTargets: [],
  });
  expect(migration.warningDisposition).toBe("recoverable");
  expect(migration.warnings.join("\n")).toContain(pathname);
  expect(fs.readFileSync(pathname)).toEqual(bytes);
});

it("ignores a reconstructed reindex-lock hold while still reporting a missing registered store", () => {
  const env = makeEnv();
  const pathname = legacy(env);
  const lockPath = `${pathname}.reindex-lock.sqlite`;
  using lock = new DatabaseSync(lockPath);
  lock.exec("CREATE TABLE coordination (id INTEGER)");
  const missingPath = path.join(
    env.OPENCLAW_STATE_DIR,
    "agents/openclaw/agent/openclaw-agent.sqlite",
  );
  openStateDb({ env }).db.exec("DROP TABLE agent_deletion_journal");
  writeState(
    (database) => reconstructAgentDeletionJournal(database, [{ agentId: "main", path: lockPath }]),
    { env },
  );

  const { targets, unverifiedTargets, warnings, registryRemovals } = discoverTargets({
    env,
    configuredAgentDatabaseTargets: [{ agentId: "main", path: pathname }],
    registeredAgentDatabases: [{ agentId: "openclaw", path: missingPath }],
  });
  expect({ targets, unverifiedTargets, warnings, registryRemovals }).toEqual({
    targets: [expect.objectContaining({ agentId: "main", path: pathname })],
    unverifiedTargets: [],
    warnings: [`Skipped missing registered agent database ${missingPath}.`],
    registryRemovals: [
      {
        agentId: "openclaw",
        path: missingPath,
        change: `Removed missing agent database registry entry ${missingPath}.`,
      },
    ],
  });
  expect(fs.existsSync(lockPath)).toBe(true);
});

it.each(["reconstructed", "deleted-during-integrity", "lost-during-integrity"])(
  "preserves independently managed external agent bytes when history is %s",
  (history) => {
    const env = makeEnv();
    const agentDir = tempDirs.make("journal-independent-external-");
    const pathname = path.join(agentDir, "openclaw-agent.sqlite");
    openStateDb({ env });
    fs.mkdirSync(agentDir, { recursive: true });
    using db = new DatabaseSync(pathname);
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: false });
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "held-proof",
      "retained",
    );
    const readSchema = () =>
      db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all();
    const schema = readSchema();
    const bytes = fs.readFileSync(pathname);
    const options = { agentId: "main", path: pathname, env, register: true };

    if (history === "reconstructed") {
      openStateDb({ env }).db.exec("DROP TABLE agent_deletion_journal");
      writeState(
        (database) =>
          reconstructAgentDeletionJournal(database, [{ agentId: "main", path: pathname }]),
        { env },
      );
    }
    if (history === "deleted-during-integrity" || history === "lost-during-integrity") {
      const operation = schemaSteps(db, options);
      const step = operation.next();
      expect(step.done).toBe(false);
      if (step.done) {
        throw new Error("Expected independently managed history to require integrity checking");
      }
      runSqliteIntegrityCheckSync(step.value);
      if (history === "deleted-during-integrity") {
        beginJournal(
          {
            agentId: "main",
            operationId: "deleted-during-independent-integrity",
            agentDir,
            workspaceDir: path.join(env.OPENCLAW_STATE_DIR, "workspace"),
            sessionsDir: path.join(env.OPENCLAW_STATE_DIR, "agents/main/sessions"),
            databasePaths: [pathname],
            deleteFiles: false,
          },
          { env },
        );
      } else {
        closeStateDbForTest();
        removeState(env);
      }
      expect(() => operation.next()).toThrow(
        history === "deleted-during-integrity"
          ? "OpenClaw agent database is unavailable while agent main is deleted."
          : "Agent deletion journal missing",
      );
    } else {
      expect(() => ensureAgentSchema(db, options)).toThrow(
        "held after deletion journal reconstruction",
      );
    }
    expect({
      version: db.prepare("PRAGMA user_version").get(),
      schema: readSchema(),
      bytes: fs.readFileSync(pathname),
    }).toEqual({ version: { user_version: 0 }, schema, bytes });
    expect(
      openStateDb({ env }).db.prepare("SELECT count(*) AS count FROM agent_databases").get(),
    ).toEqual({ count: 0 });
  },
);

it("captures checkpoint freshness after earlier config publication and process ownership", async () => {
  const env = makeEnv();
  const originalAgentPath = legacy(env);
  closeStateDbForTest();
  removeState(env);
  const customPath = path.join(tempDirs.make("journal-checkpoint-custom-"), "history.sqlite");
  fs.renameSync(originalAgentPath, customPath);
  const bytes = fs.readFileSync(customPath);
  const pathname = configPath(env);
  writeConfig(env, {});
  const config = JSON.stringify({ session: { store: customPath } });
  await using preparedFile = await prepareConfigFileWrite({
    configPath: pathname,
    content: config,
    previousRaw: "{}",
    fsModule: fs,
  });
  const acquire = stateOwners.acquireStateDatabaseSchemaLease;
  const publication = vi
    .spyOn(stateOwners, "acquireStateDatabaseSchemaLease")
    .mockImplementationOnce((options) => {
      withDeferredPluginMigrationsCurrent({ env, expectedPending: [] }, () =>
        preparedFile.publish(),
      );
      return acquire(options);
    });
  try {
    const journal = withCheckpoint(journalTable, { env });
    expect(journal).toBeUndefined();
    expect(fs.readFileSync(pathname, "utf8")).toBe(config);
    expect(discover(env, customPath).targets).toEqual([]);
    expect(fs.readFileSync(customPath)).toEqual(bytes);
  } finally {
    publication.mockRestore();
  }
});

it.each(["missing-table", "missing-database-session-store"])(
  "preserves missing history across operations: %s",
  async (missing) => {
    const env = makeEnv();
    let agentPath = legacy(env);
    closeStateDbForTest();
    const statePath = stateSqlitePath(env);
    if (missing === "missing-table") {
      const db = new DatabaseSync(statePath);
      db.exec("DROP TABLE agent_deletion_journal");
      db.close();
    } else {
      removeState(env);
    }
    if (missing === "missing-database-session-store") {
      const agentDir = tempDirs.make("journal-custom-agent-");
      const customPath = path.join(agentDir, "history.main.sqlite");
      fs.renameSync(agentPath, customPath);
      agentPath = customPath;
      writeConfig(env, { session: { store: path.join(agentDir, "history.json") } });
    }
    const bytes = fs.readFileSync(agentPath);
    for (let operation = 0; operation < 2; operation += 1) {
      const opened = openStateDb({ env });
      expect(journalTable(opened.db)).toBeUndefined();
      closeStateDbForTest();
      const discovery = discover(env, agentPath);
      expect(discovery.targets).toEqual([]);
      expect(discovery.warnings.join("\n")).toContain(
        "deletion journal missing; 1 store held back",
      );
      const migration = await migrateLegacyMediaPersistence({
        env,
        configuredAgentDatabaseTargets: [{ agentId: "main", path: agentPath }],
      });
      expect(migration.warningDisposition, JSON.stringify(migration)).toBe("recoverable");
      expect(migration.warnings.join("\n")).toContain("1 store held back");
      expect(fs.readFileSync(agentPath)).toEqual(bytes);
    }
  },
);

it("creates a known-empty journal for fresh state with an included config", () => {
  const env = makeEnv();
  writeConfig(env, {
    env: { L1072_AGENT_DIR: path.join(env.OPENCLAW_STATE_DIR, "custom-agent") },
    agents: { $include: "./agents.json5" },
  });
  fs.writeFileSync(
    path.join(env.OPENCLAW_STATE_DIR, "agents.json5"),
    "{ entries: { main: { agentDir: '${L1072_AGENT_DIR}' } } }",
  );
  fs.mkdirSync(path.join(env.OPENCLAW_STATE_DIR, "agents"));
  fs.writeFileSync(path.join(env.OPENCLAW_STATE_DIR, "agents", ".DS_Store"), "");
  const opened = openStateDb({ env });
  expect(opened.db.prepare("SELECT count(*) AS count FROM agent_deletion_journal").get()).toEqual({
    count: 0,
  });
  expect(discover(env)).toMatchObject({ warnings: [], retainedTargets: [] });
});

it.each(["empty-agent-wal", "unresolved-storage-env"] as const)(
  "does not infer empty deletion history from %s",
  (source) => {
    const env = makeEnv();
    if (source === "empty-agent-wal") {
      const pathname = path.join(env.OPENCLAW_STATE_DIR, "agents/main/agent/openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(pathname), { recursive: true });
      fs.writeFileSync(pathname, "");
      fs.writeFileSync(`${pathname}-wal`, Buffer.alloc(64));
    } else {
      const config = "{ agents: { entries: { main: { agentDir: '${L1072_ABSENT_AGENT_DIR}' } } } }";
      fs.writeFileSync(configPath(env), config);
    }
    for (let operation = 0; operation < 2; operation += 1) {
      const opened = openStateDb({ env });
      expect(journalTable(opened.db)).toBeUndefined();
      closeStateDbForTest();
    }
  },
);

it("retains selected storage environment when an agent lease opens shared state", () => {
  const root = tempDirs.make("journal-selected-agent-env-");
  const env = {
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "selected.json"),
    STORE_ROOT: path.join(root, "retained"),
  };
  fs.mkdirSync(env.STORE_ROOT);
  const retained = path.join(env.STORE_ROOT, "openclaw-agent.sqlite");
  const database = new DatabaseSync(retained);
  database.exec(
    "CREATE TABLE retained_history (value TEXT); INSERT INTO retained_history VALUES ('kept')",
  );
  database.close();
  const bytes = fs.readFileSync(retained);
  fs.writeFileSync(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({ agents: { entries: { main: { agentDir: "${STORE_ROOT}" } } } }),
  );
  const newPath = path.join(env.OPENCLAW_STATE_DIR, "new-agent.sqlite");

  const opened = openAgentDb({ agentId: "new", path: newPath, env });
  expect(opened.path).toBe(newPath);
  expect(fs.readFileSync(retained)).toEqual(bytes);
  expect(journalTable(openStateDb({ env }).db)).toBeUndefined();
});
