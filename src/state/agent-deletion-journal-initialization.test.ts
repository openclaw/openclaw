import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureMemoryIndexSchema } from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareConfigFileWrite } from "../config/backup-rotation.js";
import { withDeferredPluginMigrationsCurrent } from "../infra/deferred-plugin-migrations.js";
import * as stateOwners from "../infra/gateway-state-owner.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { runSqliteIntegrityCheckSync } from "../infra/sqlite-integrity.js";
import { discoverAgentDatabaseMigrationTargets } from "../infra/state-migrations.media-persistence-targets.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { reconstructAgentDeletionJournal } from "./agent-deletion-journal-recovery.js";
import { prepareAgentDeletionPathFence } from "./agent-deletion-journal.js";
import { ensureOpenClawAgentDatabaseSchemaSteps } from "./openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabasesForTest,
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { prepareStateDatabaseInitialization } from "./openclaw-state-db-initialization.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("agent deletion journal initialization", () => {
  it("preserves missing history for an on-disk incognito store without discovering its reindex lock", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-incognito-artifact-") };
    const pathname = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    using database = new DatabaseSync(pathname);
    database.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('preserved')");
    using lock = new DatabaseSync(`${pathname}.reindex-lock.sqlite`);
    lock.exec("CREATE TABLE coordination (id INTEGER)");
    const bytes = fs.readFileSync(pathname);

    expect(prepareStateDatabaseInitialization(resolveOpenClawStateSqlitePath(env), env)).toEqual({
      kind: "existing",
    });
    openOpenClawStateDatabase({ env });
    const discovery = discoverAgentDatabaseMigrationTargets({
      env,
      configuredAgentDatabaseTargets: [],
      registeredAgentDatabases: [],
    });
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
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-lock-artifact-") };
    const pathname = createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 19 });
    const lockPath = `${pathname}.reindex-lock.sqlite`;
    using lock = new DatabaseSync(lockPath);
    lock.exec("CREATE TABLE coordination (id INTEGER)");
    const missingPath = path.join(
      env.OPENCLAW_STATE_DIR,
      "agents/openclaw/agent/openclaw-agent.sqlite",
    );
    openOpenClawStateDatabase({ env }).db.exec("DROP TABLE agent_deletion_journal");
    runOpenClawStateWriteTransaction(
      (database) =>
        reconstructAgentDeletionJournal(database, [{ agentId: "main", path: lockPath }]),
      { env },
    );

    const discovery = discoverAgentDatabaseMigrationTargets({
      env,
      configuredAgentDatabaseTargets: [{ agentId: "main", path: pathname }],
      registeredAgentDatabases: [{ agentId: "openclaw", path: missingPath }],
    });
    expect(discovery.targets).toEqual([
      expect.objectContaining({ agentId: "main", path: pathname }),
    ]);
    expect(discovery.unverifiedTargets).toEqual([]);
    expect(discovery.warnings).toEqual([
      `Skipped missing registered agent database ${missingPath}.`,
    ]);
    expect(discovery.registryRemovals).toEqual([
      {
        agentId: "openclaw",
        path: missingPath,
        change: `Removed missing agent database registry entry ${missingPath}.`,
      },
    ]);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it.each([
    { history: "reconstructed", location: "external" },
    { history: "deleted-during-integrity", location: "external" },
    { history: "lost-during-integrity", location: "external" },
  ])(
    "preserves $location independently managed agent bytes when history is $history",
    ({ history }) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-independent-agent-") };
      const agentDir = tempDirs.make("journal-independent-external-");
      const pathname = path.join(agentDir, "openclaw-agent.sqlite");
      openOpenClawStateDatabase({ env });
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
        openOpenClawStateDatabase({ env }).db.exec("DROP TABLE agent_deletion_journal");
        runOpenClawStateWriteTransaction(
          (database) =>
            reconstructAgentDeletionJournal(database, [{ agentId: "main", path: pathname }]),
          { env },
        );
      }
      if (history === "deleted-during-integrity" || history === "lost-during-integrity") {
        const operation = ensureOpenClawAgentDatabaseSchemaSteps(db, options);
        const step = operation.next();
        expect(step.done).toBe(false);
        if (step.done) {
          throw new Error("Expected independently managed history to require integrity checking");
        }
        runSqliteIntegrityCheckSync(step.value);
        if (history === "deleted-during-integrity") {
          beginAgentDeletionJournal(
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
          closeOpenClawStateDatabaseForTest();
          for (const file of resolveSqliteDatabaseFilePaths(resolveOpenClawStateSqlitePath(env))) {
            fs.rmSync(file, { force: true });
          }
        }
        expect(() => operation.next()).toThrow(
          history === "deleted-during-integrity"
            ? "Agent deletion journal changed"
            : "Agent deletion journal missing",
        );
      } else {
        expect(() => ensureOpenClawAgentDatabaseSchema(db, options)).toThrow(
          "held after deletion journal reconstruction",
        );
      }
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
      expect(readSchema()).toEqual(schema);
      expect(fs.readFileSync(pathname)).toEqual(bytes);
      expect(
        openOpenClawStateDatabase({ env })
          .db.prepare("SELECT count(*) AS count FROM agent_databases")
          .get(),
      ).toEqual({ count: 0 });
    },
  );

  it("holds the shared deletion fence through independent schema mutation but releases it for integrity", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-independent-exclusion-") };
    const shared = openOpenClawStateDatabase({ env });
    using contender = new DatabaseSync(shared.path);
    contender.exec("PRAGMA busy_timeout = 0");
    const pathname = path.join(env.OPENCLAW_STATE_DIR, "agents/main/agent/openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    using db = new DatabaseSync(pathname);
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: false });
    const execute = db.exec.bind(db);
    let guardedMutations = 0;
    const mutation = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (/\b(?:CREATE|ALTER|DROP)\b/.test(sql)) {
        expect(() => {
          try {
            contender.exec("BEGIN IMMEDIATE");
          } finally {
            if (contender.isTransaction) {
              contender.exec("ROLLBACK");
            }
          }
        }).toThrow(/busy|locked/);
        guardedMutations++;
      }
      return execute(sql);
    });
    const operation = ensureOpenClawAgentDatabaseSchemaSteps(db, {
      agentId: "main",
      path: pathname,
      env,
      register: true,
    });
    try {
      const step = operation.next();
      expect(step.done).toBe(false);
      if (step.done) {
        throw new Error("Expected independently managed history to require integrity checking");
      }
      contender.exec("BEGIN IMMEDIATE");
      contender.exec("ROLLBACK");
      runSqliteIntegrityCheckSync(step.value);
      expect(operation.next().done).toBe(true);
      expect(guardedMutations).toBeGreaterThan(0);
      expect(shared.db.prepare("SELECT agent_id FROM agent_databases").all()).toEqual([
        { agent_id: "main" },
      ]);
    } finally {
      mutation.mockRestore();
      operation.return();
    }
  });

  it("captures checkpoint freshness after earlier config publication and process ownership", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-checkpoint-publication-") };
    const originalAgentPath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {},
      schemaVersion: 19,
    });
    closeOpenClawStateDatabaseForTest();
    const statePath = resolveOpenClawStateSqlitePath(env);
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(statePath + suffix, { force: true });
    }
    const customPath = path.join(tempDirs.make("journal-checkpoint-custom-"), "history.sqlite");
    fs.renameSync(originalAgentPath, customPath);
    const bytes = fs.readFileSync(customPath);
    const configPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw.json");
    fs.writeFileSync(configPath, "{}");
    const config = JSON.stringify({ session: { store: customPath } });
    await using preparedFile = await prepareConfigFileWrite({
      configPath,
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
      const journal = withOpenClawStateStartupMigrationCheckpointDatabase(
        (database) =>
          database
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'")
            .get(),
        { env },
      );
      expect(journal).toBeUndefined();
      expect(fs.readFileSync(configPath, "utf8")).toBe(config);
      expect(
        discoverAgentDatabaseMigrationTargets({
          env,
          configuredAgentDatabaseTargets: [{ agentId: "main", path: customPath }],
          registeredAgentDatabases: [],
        }).targets,
      ).toEqual([]);
      expect(fs.readFileSync(customPath)).toEqual(bytes);
    } finally {
      publication.mockRestore();
    }
  });

  it.each(["missing-table", "missing-database-session-store"])(
    "preserves missing history across operations: %s",
    async (missing) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-existing-") };
      let agentPath = createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 19 });
      closeOpenClawStateDatabaseForTest();
      const statePath = resolveOpenClawStateSqlitePath(env);
      if (missing === "missing-table") {
        const db = new DatabaseSync(statePath);
        db.exec("DROP TABLE agent_deletion_journal");
        db.close();
      } else {
        for (const suffix of ["", "-wal", "-shm"]) {
          fs.rmSync(statePath + suffix, { force: true });
        }
      }
      if (missing === "missing-database-session-store") {
        const agentDir = tempDirs.make("journal-custom-agent-");
        const customPath = path.join(agentDir, "history.main.sqlite");
        fs.renameSync(agentPath, customPath);
        agentPath = customPath;
        const configPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw.json");
        fs.writeFileSync(
          configPath,
          JSON.stringify({ session: { store: path.join(agentDir, "history.json") } }),
        );
      }
      const bytes = fs.readFileSync(agentPath);
      for (let operation = 0; operation < 2; operation += 1) {
        const opened = openOpenClawStateDatabase({ env });
        expect(
          opened.db
            .prepare("SELECT name FROM sqlite_master WHERE name = 'agent_deletion_journal'")
            .get(),
        ).toBeUndefined();
        closeOpenClawStateDatabaseForTest();
        const discovery = discoverAgentDatabaseMigrationTargets({
          env,
          configuredAgentDatabaseTargets: [{ agentId: "main", path: agentPath }],
          registeredAgentDatabases: [],
        });
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
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-fresh-") };
    fs.writeFileSync(
      path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
      JSON.stringify({
        env: { L1072_AGENT_DIR: path.join(env.OPENCLAW_STATE_DIR, "custom-agent") },
        agents: { $include: "./agents.json5" },
      }),
    );
    fs.writeFileSync(
      path.join(env.OPENCLAW_STATE_DIR, "agents.json5"),
      "{ entries: { main: { agentDir: '${L1072_AGENT_DIR}' } } }",
    );
    fs.mkdirSync(path.join(env.OPENCLAW_STATE_DIR, "agents"));
    fs.writeFileSync(path.join(env.OPENCLAW_STATE_DIR, "agents", ".DS_Store"), "");
    const opened = openOpenClawStateDatabase({ env });
    expect(opened.db.prepare("SELECT count(*) AS count FROM agent_deletion_journal").get()).toEqual(
      { count: 0 },
    );
    const discovery = discoverAgentDatabaseMigrationTargets({
      env,
      configuredAgentDatabaseTargets: [],
      registeredAgentDatabases: [],
    });
    expect(discovery.warnings).toEqual([]);
    expect(discovery.retainedTargets).toEqual([]);
  });

  it.each(["empty-agent-wal", "unresolved-storage-env"] as const)(
    "does not infer empty deletion history from %s",
    (source) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-unknown-") };
      if (source === "empty-agent-wal") {
        const pathname = path.join(
          env.OPENCLAW_STATE_DIR,
          "agents/main/agent/openclaw-agent.sqlite",
        );
        fs.mkdirSync(path.dirname(pathname), { recursive: true });
        fs.writeFileSync(pathname, "");
        fs.writeFileSync(`${pathname}-wal`, Buffer.alloc(64));
      } else {
        const config =
          "{ agents: { entries: { main: { agentDir: '${L1072_ABSENT_AGENT_DIR}' } } } }";
        fs.writeFileSync(path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"), config);
      }
      for (let operation = 0; operation < 2; operation += 1) {
        const opened = openOpenClawStateDatabase({ env });
        expect(
          opened.db
            .prepare("SELECT name FROM sqlite_master WHERE name = 'agent_deletion_journal'")
            .get(),
        ).toBeUndefined();
        closeOpenClawStateDatabaseForTest();
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

    const opened = openOpenClawAgentDatabase({ agentId: "new", path: newPath, env });
    expect(opened.path).toBe(newPath);
    const fence = prepareAgentDeletionPathFence({ agentId: "new", path: newPath }, { env });
    expect(fence).toMatchObject({ journal: "unknown", entries: [] });
    expect(fs.readFileSync(retained)).toEqual(bytes);
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'")
        .get(),
    ).toBeUndefined();
  });
});
