import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureMemoryIndexSchema } from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareConfigFileWrite } from "../config/backup-rotation.js";
import { withDeferredPluginMigrationsCurrent } from "../infra/deferred-plugin-migrations.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { runSqliteIntegrityCheckSync } from "../infra/sqlite-integrity.js";
import * as stateCoordinator from "../infra/state-database-coordinator.js";
import { discoverAgentDatabaseMigrationTargets } from "../infra/state-migrations.media-persistence-targets.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { reconstructAgentDeletionJournal } from "./agent-deletion-journal-recovery.js";
import {
  beginAgentDeletionJournal,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import { ensureOpenClawAgentDatabaseSchemaSteps } from "./openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabasesForTest,
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
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
  it.each(
    ["missing", "reconstructed", "deleted-during-integrity", "lost-during-integrity"].flatMap(
      (history) => ["canonical", "external"].map((location) => ({ history, location })),
    ),
  )(
    "preserves $location independently managed agent bytes when history is $history",
    ({ history, location }) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-independent-agent-") };
      const agentDir =
        location === "external"
          ? tempDirs.make("journal-independent-external-")
          : path.join(env.OPENCLAW_STATE_DIR, "agents/main/agent");
      const pathname = path.join(agentDir, "openclaw-agent.sqlite");
      if (history !== "missing") {
        openOpenClawStateDatabase({ env });
      }
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
          history === "missing"
            ? "Agent deletion journal missing"
            : "held after deletion journal reconstruction",
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

  it("captures checkpoint freshness after an earlier config publication obtains the state coordinator", async () => {
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
    const acquire = stateCoordinator.acquireStateDatabaseCoordinator;
    const publication = vi
      .spyOn(stateCoordinator, "acquireStateDatabaseCoordinator")
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

  it.each([
    "missing-table",
    "missing-database",
    "missing-database-canonical-custom",
    "missing-database-custom-store",
    "missing-database-config-include",
    "missing-database-session-store",
    "missing-database-acp-store",
  ])("preserves missing history across operations: %s", async (missing) => {
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
    if (missing === "missing-database-canonical-custom") {
      const customPath = path.join(path.dirname(agentPath), "history.sqlite");
      fs.renameSync(agentPath, customPath);
      agentPath = customPath;
    }
    if (
      missing === "missing-database-custom-store" ||
      missing === "missing-database-config-include" ||
      missing === "missing-database-session-store" ||
      missing === "missing-database-acp-store"
    ) {
      const agentDir = tempDirs.make("journal-custom-agent-");
      const customPath = path.join(
        agentDir,
        missing === "missing-database-acp-store"
          ? "history.archivist.sqlite"
          : missing === "missing-database-session-store"
            ? "history.main.sqlite"
            : "openclaw-agent.sqlite",
      );
      fs.renameSync(agentPath, customPath);
      agentPath = customPath;
      const configPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw.json");
      if (missing === "missing-database-config-include") {
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            env: { L1072_AGENT_DIR: agentDir },
            agents: { $include: "./agents.json5" },
          }),
        );
        fs.writeFileSync(
          path.join(env.OPENCLAW_STATE_DIR, "agents.json5"),
          "{ entries: { main: { agentDir: '${L1072_AGENT_DIR}' } } }",
        );
      } else {
        fs.writeFileSync(
          configPath,
          JSON.stringify(
            missing === "missing-database-acp-store"
              ? {
                  acp: { defaultAgent: "archivist" },
                  session: { store: path.join(agentDir, "history.{agentId}.sqlite") },
                }
              : missing === "missing-database-session-store"
                ? { session: { store: path.join(agentDir, "history.json") } }
                : { agents: { entries: { main: { agentDir } } } },
          ),
        );
      }
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
  });

  it.each([
    "missing",
    "inline",
    "include-env",
    "legacy-session-json",
    "empty-agent",
    "external-agent",
  ])("creates a known-empty journal for fresh state (config: %s)", (configSource) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-fresh-") };
    if (configSource === "external-agent") {
      openOpenClawAgentDatabase({
        agentId: "main",
        path: path.join(tempDirs.make("journal-fresh-external-"), "openclaw-agent.sqlite"),
        env,
      });
    }
    if (configSource === "legacy-session-json" || configSource === "empty-agent") {
      const file = path.join(
        env.OPENCLAW_STATE_DIR,
        "agents",
        "main",
        configSource === "empty-agent" ? "agent/openclaw-agent.sqlite" : "sessions/sessions.json",
      );
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, configSource === "empty-agent" ? "" : "{}");
    }
    if (configSource === "inline" || configSource === "include-env") {
      fs.writeFileSync(
        path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
        configSource === "inline"
          ? "{ agents: { entries: { main: {} } } }"
          : JSON.stringify({
              env: { L1072_AGENT_DIR: path.join(env.OPENCLAW_STATE_DIR, "custom-agent") },
              agents: { $include: "./agents.json5" },
            }),
      );
      if (configSource === "include-env") {
        fs.writeFileSync(
          path.join(env.OPENCLAW_STATE_DIR, "agents.json5"),
          "{ entries: { main: { agentDir: '${L1072_AGENT_DIR}' } } }",
        );
      }
      fs.mkdirSync(path.join(env.OPENCLAW_STATE_DIR, "agents"));
      fs.writeFileSync(path.join(env.OPENCLAW_STATE_DIR, "agents", ".DS_Store"), "");
    }
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

  it.each([
    "existing-empty-database",
    "shared-wal",
    "shared-shm",
    "shared-journal",
    "empty-agent-wal",
    "empty-agent-shm",
    "empty-agent-journal",
    "invalid-json5",
    "missing-include",
    "unresolved-storage-env",
    "unresolved-session-owner-env",
    "unresolved-roster-id-env",
    "unresolved-runtime-type-env",
    "invalid-roster",
    "invalid-agent-dir",
  ] as const)("does not infer empty deletion history from %s", (source) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("journal-unknown-") };
    if (source === "existing-empty-database") {
      const pathname = resolveOpenClawStateSqlitePath(env);
      fs.mkdirSync(path.dirname(pathname));
      new DatabaseSync(pathname).close();
    } else if (source === "shared-wal" || source === "shared-shm" || source === "shared-journal") {
      const pathname = resolveOpenClawStateSqlitePath(env);
      fs.mkdirSync(path.dirname(pathname));
      const suffix = { "shared-wal": "-wal", "shared-shm": "-shm", "shared-journal": "-journal" }[
        source
      ];
      fs.writeFileSync(pathname + suffix, Buffer.alloc(64));
    } else if (
      source === "empty-agent-wal" ||
      source === "empty-agent-shm" ||
      source === "empty-agent-journal"
    ) {
      const pathname = path.join(env.OPENCLAW_STATE_DIR, "agents/main/agent/openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(pathname), { recursive: true });
      fs.writeFileSync(pathname, "");
      const suffix = {
        "empty-agent-wal": "-wal",
        "empty-agent-shm": "-shm",
        "empty-agent-journal": "-journal",
      }[source];
      fs.writeFileSync(pathname + suffix, Buffer.alloc(64));
    } else {
      const config = {
        "invalid-json5": "{ agents:",
        "missing-include": "{ $include: './missing.json5' }",
        "unresolved-storage-env":
          "{ agents: { entries: { main: { agentDir: '${L1072_ABSENT_AGENT_DIR}' } } } }",
        "unresolved-session-owner-env":
          "{ acp: { defaultAgent: '${L1072_ABSENT_AGENT_ID}' }, session: { store: 'history.{agentId}.sqlite' } }",
        "unresolved-roster-id-env":
          "{ agents: { list: [{ id: '${L1072_ABSENT_AGENT_ID}' }] }, session: { store: 'history.{agentId}.sqlite' } }",
        "unresolved-runtime-type-env":
          "{ agents: { entries: { main: { runtime: { type: '${L1072_ABSENT_RUNTIME}', acp: { agent: 'archivist' } } } } }, session: { store: 'history.{agentId}.sqlite' } }",
        "invalid-roster": "{ agents: { entries: 'invalid' } }",
        "invalid-agent-dir": "{ agents: { entries: { main: { agentDir: 42 } } } }",
      }[source];
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
  });

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
