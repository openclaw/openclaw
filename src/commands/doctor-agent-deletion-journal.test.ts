import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  captureSqliteDatabaseAdmissions,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { detectSharedAuthStoreMigration } from "../infra/state-migrations.shared-auth-store.js";
import { completeAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import {
  readAgentDatabaseDeletionSnapshot,
  readAgentDeletionJournalStatusInDatabase,
} from "../state/agent-deletion-journal.read.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { INCOGNITO_AGENT_SQLITE_BASENAME } from "../state/openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { repairDoctorAgentDeletionJournal } from "./doctor-agent-deletion-journal.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";
import { listAuthProfileRepairCandidates } from "./doctor-auth-legacy-paths.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";
import { maybeMigrateModelCatalogCredentials } from "./doctor-model-catalog-credentials.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { maybeRepairCodexSessionRoutes } from "./doctor/shared/codex-route-session-repair.js";

const tempDirs = createTempDirTracker();

function legacyDatabase(agentId: string, env: NodeJS.ProcessEnv, pathname?: string) {
  return createLegacyDatabaseFixture({
    agentId,
    env,
    eventsBySession: {},
    schemaVersion: 19,
    ...(pathname ? { path: pathname } : {}),
  });
}

function repairJournal(
  preflight: Awaited<ReturnType<typeof prepareDoctorDatabasePreflight>>,
  env: NodeJS.ProcessEnv,
  shouldRepair = true,
) {
  return repairDoctorAgentDeletionJournal({ preflight, shouldRepair, env });
}

function reconstructionRow(db: EngineConnection) {
  return db
    .prepare(
      "SELECT report_json FROM migration_sources WHERE migration_kind = 'agent-deletion-journal-reconstruction'",
    )
    .get();
}

const readFiles = (files: string[]) => files.map((file) => fs.readFileSync(file));
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
const journalRow = (db: EngineConnection, agentId: string) =>
  db.prepare("SELECT * FROM agent_deletion_journal WHERE agent_id = ?").get(agentId);

function makeState(prefix: string, canonical = true) {
  const directory = tempDirs.make(prefix);
  const stateDir = canonical ? fs.realpathSync.native(directory) : directory;
  const env = { OPENCLAW_STATE_DIR: stateDir };
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return { stateDir, env };
}

function configFor(workspace?: string): OpenClawConfig {
  return {
    agents: { entries: { main: workspace ? { workspace } : {} } },
    plugins: { enabled: false },
  };
}

afterEach(async () => {
  try {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const roots = [...tempDirs.dirs].map((dir) => `${fs.realpathSync(dir)}${path.sep}`);
    // Physical admissions outlive native handles, including held stores outside the state root.
    for (const { location } of captureSqliteDatabaseAdmissions()) {
      if (roots.some((root) => location.startsWith(root))) {
        retireSqliteDatabaseAdmissionForPath(location);
      }
    }
    expect(
      captureSqliteDatabaseAdmissions()
        .filter(({ location }) => roots.some((root) => location.startsWith(root)))
        .map(({ location }) => location),
    ).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    tempDirs.cleanup();
  }
});

it.each([
  ["retired", "database_paths_json", "[", false, false],
  ["retired", "cleanup_paths_json", "[", false, false],
  ["retired", "database_paths_json", "[1]", true, false],
  ["openclaw", "database_paths_json", "[]", false, false],
  ["crestodian", "database_paths_json", "[]", true, false],
  ["retired", "database_paths_json", "[", false, true],
] as const)(
  "quarantines unusable %s %s history (%s, complete=%s, archiveBlocked=%s) without touching stores",
  async (agentId, column, raw, complete, archiveBlocked) => {
    const { env } = makeState("doctor-unreadable-journal-", false);
    const cfg = configFor();
    const healthy = legacyDatabase("main", env);
    const pathname = legacyDatabase(agentId, env);
    const lockPath = `${pathname}.reindex-lock.sqlite`;
    const incognitoPath = path.join(path.dirname(pathname), INCOGNITO_AGENT_SQLITE_BASENAME);
    fs.copyFileSync(pathname, incognitoPath);
    using lock = new DatabaseSync(lockPath);
    lock.exec("CREATE TABLE coordination (id INTEGER)");
    const externalPath =
      column === "cleanup_paths_json"
        ? legacyDatabase(
            agentId,
            env,
            path.join(tempDirs.make("doctor-journal-external-"), "history.sqlite"),
          )
        : undefined;
    const entry = {
      agentId,
      operationId: "unusable-deletion",
      agentDir: path.dirname(pathname),
      workspaceDir: path.join(env.OPENCLAW_STATE_DIR, `workspace-${agentId}`),
      sessionsDir: path.join(env.OPENCLAW_STATE_DIR, "agents", agentId, "sessions"),
      deleteFiles: false,
      databasePaths: externalPath ? [externalPath] : [],
    };
    beginAgentDeletionJournal(entry, { env });
    if (externalPath) {
      unregisterOpenClawAgentDatabase({ agentId, path: externalPath, env });
    }
    // A valid sibling must retain its cleanup authority and completion path.
    beginAgentDeletionJournal(
      { ...entry, agentId: "valid", operationId: "valid-deletion" },
      { env },
    );
    const state = openOpenClawStateDatabase({ env });
    if (complete) {
      runOpenClawStateWriteTransaction(
        (database) => completeAgentDeletionJournalInDatabase(database, agentId, entry.operationId),
        { env },
      );
    }
    state.db
      .prepare(`UPDATE agent_deletion_journal SET ${column} = ? WHERE agent_id = ?`)
      .run(raw, agentId);
    const original = journalRow(state.db, agentId);
    const valid = journalRow(state.db, "valid");
    const before = fs.readFileSync(pathname);
    const externalBefore = externalPath ? fs.readFileSync(externalPath) : undefined;
    const recoveryDir = path.join(env.OPENCLAW_STATE_DIR, "agents", agentId, "recovery");
    if (archiveBlocked) {
      fs.writeFileSync(recoveryDir, "preserved obstruction");
    }
    const preflight = await prepareDoctorDatabasePreflight({ cfg });
    const result = await repairJournal(preflight, env);
    if (archiveBlocked) {
      expect(result.warnings.join("\n")).toContain("Could not save deletion recovery receipt");
      expect(journalRow(state.db, agentId)).toEqual(original);
      expect(fs.readFileSync(pathname)).toEqual(before);
      expect(fs.readFileSync(recoveryDir, "utf8")).toBe("preserved obstruction");
      const next = await prepareDoctorDatabasePreflight({ cfg });
      expect(next.agentDatabaseMigrationDiscovery?.discovery.targets).toEqual([]);
      expect(next.agentDatabaseMigrationDiscovery?.discovery.unverifiedTargets).toContainEqual(
        expect.objectContaining({ agentId, path: pathname }),
      );
      return;
    }
    expect(result.changes.join("\n")).toContain("Quarantined unusable agent deletion journal");
    if (agentId === "retired") {
      expect(result.warnings.join("\n")).toContain(pathname);
    }
    const files = fs.readdirSync(recoveryDir);
    expect(files).toHaveLength(1);
    const receipt = JSON.parse(fs.readFileSync(path.join(recoveryDir, files[0]!), "utf8"));
    expect(receipt.journal).toEqual([original]);
    expect(receipt.held).toContainEqual({ agentId, path: pathname });
    expect(receipt.held).toContainEqual({ agentId, path: incognitoPath });
    expect(fs.readFileSync(incognitoPath)).toEqual(before);
    expect(receipt.held).not.toContainEqual({ agentId, path: lockPath });
    if (externalPath) {
      expect(receipt.held).toContainEqual({ agentId, path: externalPath });
      expect(fs.readFileSync(externalPath)).toEqual(externalBefore);
    }
    if (agentId === "retired") {
      expect(readAgentDeletionJournalStatusInDatabase(state.db, agentId)).toBe("complete");
      expect(readAgentDatabaseDeletionSnapshot(env, "runtime")?.retainedDeletions).toMatchObject({
        status: "present",
        entries: expect.arrayContaining([expect.objectContaining({ agentId })]),
      });
    } else {
      expect(journalRow(state.db, agentId)).toBeUndefined();
    }
    expect(journalRow(state.db, "valid")).toEqual(valid);
    expect(
      runOpenClawStateWriteTransaction(
        (database) => completeAgentDeletionJournalInDatabase(database, "valid", "valid-deletion"),
        { env },
      ),
    ).toBe(true);
    expect(fs.readFileSync(pathname)).toEqual(before);
    if (agentId === "retired") {
      expect(result.warnings.join("\n")).toMatch(/agents add '?retired'?/);
      expect(result.warnings.join("\n")).toMatch(/agents delete '?retired'? --force/);
    } else {
      expect(result.warnings).toEqual([]);
    }
    const next = await prepareDoctorDatabasePreflight({ cfg });
    const targets = next.agentDatabaseMigrationDiscovery?.discovery.targets;
    if (agentId === "retired") {
      expect(targets).toEqual([expect.objectContaining({ agentId: "main", path: healthy })]);
    } else {
      expect(targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentId: "main", path: healthy }),
          expect.objectContaining({ agentId, path: pathname }),
        ]),
      );
      expect(next.agentDatabaseMigrationDiscovery?.discovery.unverifiedTargets).toEqual([]);
    }
    expect((await repairJournal(next, env)).changes).toEqual([]);
    expect(fs.readdirSync(recoveryDir)).toEqual(files);
    expect(fs.readFileSync(pathname)).toEqual(before);
  },
);

it.each([
  "default",
  "external-registered",
  "configured-custom-lost-state",
  "incognito-lost-state",
  "malformed-config",
])(
  "reconstructs with a receipt and keeps %s stores held on the next Doctor pass",
  async (location) => {
    const { stateDir, env } = makeState("doctor-journal-recovery-");
    const cfg = configFor(path.join(stateDir, "workspace"));
    const stores = ["main", "retired"].map((agentId) => legacyDatabase(agentId, env));
    const lockPath = `${stores[0]}.reindex-lock.sqlite`;
    using lock = new DatabaseSync(lockPath);
    lock.exec("CREATE TABLE coordination (id INTEGER)");
    fs.copyFileSync(lockPath, path.join(path.dirname(stores[0]!), "capture.sqlite"));
    closeOpenClawStateDatabaseForTest();
    const statePath = resolveOpenClawStateSqlitePath(env);
    const db = new DatabaseSync(statePath);
    db.exec("DROP TABLE agent_deletion_journal");
    const lostState =
      location === "configured-custom-lost-state" || location === "incognito-lost-state";
    if (lostState) {
      const custom = path.join(
        path.dirname(stores[0]!),
        location === "incognito-lost-state" ? INCOGNITO_AGENT_SQLITE_BASENAME : "history.sqlite",
      );
      fs.renameSync(stores[0]!, custom);
      stores[0] = custom;
      if (location === "configured-custom-lost-state") {
        cfg.session = { store: custom };
      }
    } else if (location !== "default") {
      const custom = path.join(tempDirs.make("doctor-journal-custom-"), "history.main.sqlite");
      fs.renameSync(stores[0]!, custom);
      stores[0] = custom;
      if (location === "malformed-config") {
        db.exec("DELETE FROM agent_databases WHERE agent_id = 'main'");
        cfg.session = { store: path.join(path.dirname(custom), "history.json") };
      } else {
        db.prepare("UPDATE agent_databases SET path = ? WHERE agent_id = 'main'").run(custom);
      }
    }
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    writeJson(configPath, cfg);
    db.close();
    if (lostState) {
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.rmSync(statePath + suffix, { force: true });
      }
    }
    const bytes = readFiles(stores);
    if (location === "malformed-config") {
      fs.writeFileSync(configPath, '{"session":');
      const incomplete = await prepareDoctorDatabasePreflight();
      const refused = await repairJournal(incomplete, env);
      expect(refused.changes).toEqual([]);
      expect(refused.warnings.join("\n")).toContain(
        "ownership configuration could not be verified",
      );
      {
        using unchanged = new DatabaseSync(statePath, { readOnly: true });
        expect(
          unchanged
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'")
            .get(),
        ).toBeUndefined();
        expect(reconstructionRow(unchanged)).toBeUndefined();
      }
      expect(readFiles(stores)).toEqual(bytes);
      writeJson(configPath, cfg);
      const stale = await repairJournal(incomplete, env);
      expect(stale.changes).toEqual([]);
      expect(stale.warnings.join("\n")).toContain("ownership configuration could not be verified");
    }
    const preflight = await prepareDoctorDatabasePreflight();
    const preview = await repairJournal(preflight, env, false);
    expect(preview.changes).toEqual([]);
    expect(preview.warnings.join("\n")).toContain("deletion journal missing; 2 stores held back");
    const repaired = await repairJournal(preflight, env);
    expect(repaired.changes.join("\n")).toContain("recorded a Doctor receipt");
    expect(repaired.warnings.join("\n")).toMatch(/agents add '?main'?/);
    expect(repaired.warnings.join("\n")).toContain("--non-interactive");
    closeOpenClawStateDatabaseForTest();
    const next = await prepareDoctorDatabasePreflight();
    expect(next.agentDatabaseMigrationDiscovery?.discovery.targets).toEqual([]);
    expect(next.pendingMigrations?.filter((entry) => entry.kind === "agent") ?? []).toEqual([]);
    expect((await repairJournal(next, env)).changes).toEqual([]);
    const state = openOpenClawStateDatabase({ env });
    const row = reconstructionRow(state.db);
    expect(row?.report_json).toEqual(
      expect.stringContaining("Reconstructed the missing agent deletion journal"),
    );
    const report = JSON.parse(String(row?.report_json));
    expect(report.held).toEqual(
      expect.arrayContaining([
        {
          agentId: "main",
          path:
            location === "default" || lostState ? path.relative(stateDir, stores[0]!) : stores[0],
        },
        { agentId: "retired", path: path.relative(stateDir, stores[1]!) },
      ]),
    );
    expect(report.held).toHaveLength(2);
    for (const [index, agentId] of ["main", "retired"].entries()) {
      const leaseId = claimOpenClawAgentDatabaseLease({ agentId, env, path: stores[index]! });
      releaseOpenClawAgentDatabaseLease(leaseId, { env }, "read-only");
    }
    expect(readFiles(stores)).toEqual(bytes);
  },
);

it("keeps deletion history unavailable when only canonical SQLite sidecars survive", async () => {
  const { stateDir, env } = makeState("doctor-journal-sidecars-");
  const agentDir = path.join(stateDir, "agents", "retired", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const sidecars = ["-wal", "-shm", "-journal"].map((suffix) =>
    path.join(agentDir, `openclaw-agent.sqlite${suffix}`),
  );
  for (const sidecar of sidecars) {
    fs.writeFileSync(sidecar, "preserved SQLite family fragment");
  }
  const bytes = readFiles(sidecars);
  const state = openOpenClawStateDatabase({ env });
  const preflight = await prepareDoctorDatabasePreflight({ cfg: { plugins: { enabled: false } } });
  const repaired = await repairJournal(preflight, env);
  expect(repaired.changes).toEqual([]);
  expect(repaired.warnings.join("\n")).toContain("recovery inventory is incomplete");
  const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
  expect(preflight.agentDatabaseMigrationDiscovery?.discovery.failures).toContainEqual({
    path: databasePath,
    reason: expect.stringContaining("without a regular main database"),
  });
  expect(fs.existsSync(databasePath)).toBe(false);
  expect(
    state.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'").get(),
  ).toBeUndefined();
  expect(reconstructionRow(state.db)).toBeUndefined();
  expect(readFiles(sidecars)).toEqual(bytes);
});

it.each([
  "default",
  "unregistered",
  "renamed-canonical",
  "configured-new-owner",
  "env-selected",
  "hardlinked-owner",
])(
  "preserves %s credential artifacts after journal reconstruction without main state",
  async (location) => {
    const state = makeState("doctor-held-artifacts-");
    const { stateDir } = state;
    const env: NodeJS.ProcessEnv = state.env;
    const cfg = configFor();
    const usesCustomDirectory = location === "configured-new-owner" || location === "env-selected";
    const customAgentDirectory = tempDirs.make("doctor-held-agent-directory-");
    const retiredPath = legacyDatabase(
      "retired",
      env,
      location === "renamed-canonical"
        ? path.join(stateDir, "agents", "old-name", "agent", "openclaw-agent.sqlite")
        : usesCustomDirectory
          ? path.join(customAgentDirectory, "openclaw-agent.sqlite")
          : undefined,
    );
    if (location === "unregistered") {
      unregisterOpenClawAgentDatabase({ agentId: "retired", path: retiredPath, env });
    }
    const customDirectory = tempDirs.make("doctor-held-non-agent-parent-");
    const customDatabase = legacyDatabase(
      "archive",
      env,
      path.join(customDirectory, "history.sqlite"),
    );
    const agentDir = path.dirname(retiredPath);
    const catalogPath = path.join(agentDir, "models.json");
    const authPath = path.join(agentDir, "auth-profiles.json");
    const auth = createAuthProfileStoreFixture({
      "fixture:default": createApiKeyCredential("fixture", "synthetic-held-credential"),
    });
    writeJson(authPath, auth);
    writeJson(path.join(customDirectory, "auth-profiles.json"), auth);
    writeJson(catalogPath, {
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          apiKey: "synthetic-held-credential",
          models: [],
        },
      },
    });
    const authPaths = [authPath];
    const aliasArtifacts: string[] = [];
    if (location === "hardlinked-owner") {
      cfg.agents = { ownership: "explicit", entries: { retired: {}, secondary: {} } };
      const secondDir = path.join(stateDir, "agents", "secondary", "agent");
      fs.mkdirSync(secondDir, { recursive: true });
      const secondDatabase = path.join(secondDir, "openclaw-agent.sqlite");
      fs.linkSync(retiredPath, secondDatabase);
      const secondAuth = path.join(secondDir, "auth-profiles.json");
      const secondCatalog = path.join(secondDir, "models.json");
      const profileId = "openai-codex:default";
      const ref = {
        source: "openclaw-credentials",
        provider: "openai-codex",
        id: "0123456789abcdef0123456789abcdef",
      };
      writeJson(
        secondAuth,
        createAuthProfileStoreFixture({
          [profileId]: { type: "oauth", provider: ref.provider, oauthRef: ref },
        }),
      );
      fs.copyFileSync(catalogPath, secondCatalog);
      authPaths.push(secondAuth);
      aliasArtifacts.push(secondDatabase, secondAuth, secondCatalog);
    }
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    writeJson(configPath, cfg);
    closeOpenClawStateDatabaseForTest();
    const statePath = resolveOpenClawStateSqlitePath(env);
    const database = new DatabaseSync(statePath);
    database.exec("DROP TABLE agent_deletion_journal");
    database.close();
    const protectedPaths = [retiredPath, customDatabase, catalogPath, authPath, ...aliasArtifacts];
    const bytes = readFiles(protectedPaths);
    const mainPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    expect(fs.existsSync(mainPath)).toBe(false);
    const initial = await prepareDoctorDatabasePreflight();
    const reconstruction = await repairJournal(initial, env);
    expect(reconstruction.changes.join("\n")).toContain("recorded a Doctor receipt");
    const databaseState = openOpenClawStateDatabase({ env });
    expect(
      databaseState.db.prepare("SELECT count(*) AS count FROM agent_deletion_journal").get(),
    ).toEqual({
      count: 0,
    });
    const source = reconstructionRow(databaseState.db);
    expect(JSON.parse(String(source?.report_json)).held).toEqual(
      expect.arrayContaining([
        {
          agentId: "retired",
          path: usesCustomDirectory ? retiredPath : path.relative(stateDir, retiredPath),
        },
      ]),
    );
    expect(fs.existsSync(mainPath)).toBe(false);
    expect(
      detectSharedAuthStoreMigration({ stateDir, env, doctorOnlyStateMigrations: true }).held,
    ).not.toBe(true);
    if (location === "configured-new-owner") {
      cfg.agents = { entries: { main: { agentDir: customAgentDirectory } } };
      writeJson(configPath, cfg);
    } else if (location === "env-selected") {
      env.OPENCLAW_AGENT_DIR = customAgentDirectory;
      vi.stubEnv("OPENCLAW_AGENT_DIR", customAgentDirectory);
    }
    const runtime = {
      log() {},
      error() {},
      exit(code: number): never {
        throw new Error(`unexpected exit ${code}`);
      },
    };
    for (let pass = 0; pass < 2; pass += 1) {
      closeOpenClawStateDatabaseForTest();
      const next = await prepareDoctorDatabasePreflight();
      expect((await repairJournal(next, env)).changes).toEqual([]);
      const repairPaths = listAuthProfileRepairCandidates(cfg, env).map(
        (candidate) => candidate.authPath,
      );
      for (const heldAuthPath of authPaths) {
        expect(repairPaths).not.toContain(heldAuthPath);
      }
      // Explicit directory inventory does not make an arbitrary held DB's parent an agent namespace.
      expect(
        listAuthProfileRepairCandidates(cfg, { ...env, OPENCLAW_AGENT_DIR: customDirectory }).map(
          (candidate) => candidate.authPath,
        ),
      ).toContain(path.join(customDirectory, "auth-profiles.json"));
      const imported = await maybeMigrateAuthProfileJsonStoresToSqlite({
        cfg,
        env,
        prompter: { confirmAutoFix: async () => true },
      });
      for (const heldAuthPath of authPaths) {
        expect(imported.detected).not.toContain(heldAuthPath);
      }
      const catalogs = await maybeMigrateModelCatalogCredentials({
        cfg,
        env,
        runtime,
        prompter: createDoctorPrompter({
          runtime,
          options: { repair: true, nonInteractive: true },
        }),
      });
      expect(catalogs).toMatchObject({ detected: 0, migrated: 0, warnings: [] });
      expect(await maybeRepairCodexSessionRoutes({ cfg, env, shouldRepair: true })).toMatchObject({
        scannedStores: 0,
        changes: [],
      });
      const leaseId = claimOpenClawAgentDatabaseLease({
        agentId: "retired",
        path: retiredPath,
        env,
      });
      releaseOpenClawAgentDatabaseLease(leaseId, { env }, "read-only");
      expect(readFiles(protectedPaths)).toEqual(bytes);
    }
  },
);
