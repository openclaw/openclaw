import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLegacyDatabaseFixture } from "../infra/state-migrations.media-persistence.test-support.js";
import { detectSharedAuthStoreMigration } from "../infra/state-migrations.shared-auth-store.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { repairDoctorAgentDeletionJournal } from "./doctor-agent-deletion-journal.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";
import { listAuthProfileRepairCandidates } from "./doctor-auth-legacy-paths.js";
import { maybeRepairLegacyOAuthSidecarProfiles } from "./doctor-auth-oauth-sidecar.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";
import { maybeMigrateModelCatalogCredentials } from "./doctor-model-catalog-credentials.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { maybeRepairCodexSessionRoutes } from "./doctor/shared/codex-route-session-repair.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reports unreadable journal history without replacing it or silently clearing the holds", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("doctor-unreadable-journal-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } }, plugins: { enabled: false } };
  const pathname = createLegacyDatabaseFixture({
    agentId: "retired",
    env,
    eventsBySession: {},
    schemaVersion: 19,
  });
  beginAgentDeletionJournal(
    {
      agentId: "retired",
      operationId: "retained-unreadable",
      agentDir: path.dirname(pathname),
      workspaceDir: path.join(env.OPENCLAW_STATE_DIR, "workspace-retired"),
      sessionsDir: path.join(env.OPENCLAW_STATE_DIR, "agents", "retired", "sessions"),
      deleteFiles: false,
    },
    { env },
  );
  const state = openOpenClawStateDatabase({ env });
  runOpenClawStateWriteTransaction(
    (database) =>
      completeAgentDeletionJournalInDatabase(database, "retired", "retained-unreadable"),
    { env },
  );
  state.db.exec("UPDATE agent_deletion_journal SET database_paths_json = '[1]'");
  const before = fs.readFileSync(pathname);
  for (const shouldRepair of [false, true]) {
    const preflight = await prepareDoctorDatabasePreflight({ cfg });
    const result = await repairDoctorAgentDeletionJournal({ preflight, shouldRepair, env });
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("deletion journal unreadable");
    expect(result.warnings.join("\n")).toContain(pathname);
    expect(result.warnings.join("\n")).toContain("openclaw doctor --fix");
    expect(
      state.db.prepare("SELECT database_paths_json FROM agent_deletion_journal").get(),
    ).toEqual({
      database_paths_json: "[1]",
    });
    expect(state.db.prepare("SELECT * FROM migration_sources").all()).toEqual([]);
    expect(fs.readFileSync(pathname)).toEqual(before);
  }
});

it.each(["default", "custom-unregistered", "external-registered", "canonical-custom-lost-state"])(
  "reconstructs with a receipt and keeps %s stores held on the next Doctor pass",
  async (location) => {
    const stateDir = fs.realpathSync.native(tempDirs.make("doctor-journal-recovery-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace: path.join(stateDir, "workspace") } } },
      plugins: { enabled: false },
    };
    const stores = ["main", "retired"].map((agentId) =>
      createLegacyDatabaseFixture({ agentId, env, eventsBySession: {}, schemaVersion: 19 }),
    );
    closeOpenClawStateDatabaseForTest();
    const statePath = resolveOpenClawStateSqlitePath(env);
    const db = new DatabaseSync(statePath);
    db.exec("DROP TABLE agent_deletion_journal");
    const lostState = location === "canonical-custom-lost-state";
    if (lostState) {
      const custom = path.join(path.dirname(stores[0]!), "history.sqlite");
      fs.renameSync(stores[0]!, custom);
      stores[0] = custom;
    } else if (location !== "default") {
      const custom = path.join(tempDirs.make("doctor-journal-custom-"), "history.main.sqlite");
      fs.renameSync(stores[0]!, custom);
      stores[0] = custom;
      if (location === "custom-unregistered") {
        db.exec("DELETE FROM agent_databases WHERE agent_id = 'main'");
        cfg.session = { store: path.join(path.dirname(custom), "history.json") };
      } else {
        db.prepare("UPDATE agent_databases SET path = ? WHERE agent_id = 'main'").run(custom);
      }
    }
    const configPath = path.join(stateDir, "openclaw.json");
    if (!lostState) {
      fs.writeFileSync(configPath, JSON.stringify(cfg));
    }
    db.close();
    if (lostState) {
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.rmSync(statePath + suffix, { force: true });
      }
    }
    const bytes = stores.map((file) => fs.readFileSync(file));
    const preflight = await prepareDoctorDatabasePreflight(lostState ? {} : { cfg });
    const preview = await repairDoctorAgentDeletionJournal({ preflight, shouldRepair: false, env });
    expect(preview.changes).toEqual([]);
    expect(preview.warnings.join("\n")).toContain("deletion journal missing; 2 stores held back");
    const repaired = await repairDoctorAgentDeletionJournal({ preflight, shouldRepair: true, env });
    expect(repaired.changes.join("\n")).toContain("recorded a Doctor receipt");
    expect(repaired.warnings.join("\n")).toMatch(/agents add '?main'?/);
    expect(repaired.warnings.join("\n")).toContain("--non-interactive");
    closeOpenClawStateDatabaseForTest();
    const next = await prepareDoctorDatabasePreflight(lostState ? {} : { cfg });
    expect(next.agentDatabaseMigrationDiscovery?.discovery.targets).toEqual([]);
    expect(next.pendingMigrations?.filter((entry) => entry.kind === "agent") ?? []).toEqual([]);
    expect(
      (await repairDoctorAgentDeletionJournal({ preflight: next, shouldRepair: true, env }))
        .changes,
    ).toEqual([]);
    const state = openOpenClawStateDatabase({ env });
    const row = state.db
      .prepare(
        "SELECT report_json FROM migration_sources WHERE migration_kind = 'agent-deletion-journal-reconstruction'",
      )
      .get();
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
    stores.forEach((file, index) => expect(fs.readFileSync(file)).toEqual(bytes[index]));
    if (lostState) {
      expect(fs.existsSync(configPath)).toBe(false);
    }
  },
);

it("keeps deletion history unavailable when only custom SQLite sidecars survive", async () => {
  const stateDir = fs.realpathSync.native(tempDirs.make("doctor-journal-sidecars-"));
  const env = { OPENCLAW_STATE_DIR: stateDir };
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const agentDir = path.join(stateDir, "agents", "retired", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const sidecars = ["history.sqlite-wal", "pending.sqlite-shm", "rolled.sqlite-journal"].map(
    (name) => path.join(agentDir, name),
  );
  for (const sidecar of sidecars) {
    fs.writeFileSync(sidecar, "preserved SQLite family fragment");
  }
  const bytes = sidecars.map((file) => fs.readFileSync(file));
  const state = openOpenClawStateDatabase({ env });
  const preflight = await prepareDoctorDatabasePreflight({ cfg: { plugins: { enabled: false } } });
  const repaired = await repairDoctorAgentDeletionJournal({ preflight, shouldRepair: true, env });
  expect(repaired.changes).toEqual([]);
  expect(repaired.warnings.join("\n")).toContain("recovery inventory is incomplete");
  for (const name of ["history.sqlite", "pending.sqlite", "rolled.sqlite"]) {
    expect(preflight.agentDatabaseMigrationDiscovery?.discovery.failures).toContainEqual({
      path: path.join(agentDir, name),
      reason: expect.stringContaining("without a regular main database"),
    });
    expect(fs.existsSync(path.join(agentDir, name))).toBe(false);
  }
  expect(
    state.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'agent_deletion_journal'").get(),
  ).toBeUndefined();
  expect(
    state.db
      .prepare(
        "SELECT report_json FROM migration_sources WHERE migration_kind = 'agent-deletion-journal-reconstruction'",
      )
      .get(),
  ).toBeUndefined();
  expect(sidecars.map((file) => fs.readFileSync(file))).toEqual(bytes);
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
    const stateDir = fs.realpathSync.native(tempDirs.make("doctor-held-artifacts-"));
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: stateDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      plugins: { enabled: false },
    };
    const usesCustomDirectory = location === "configured-new-owner" || location === "env-selected";
    const customAgentDirectory = tempDirs.make("doctor-held-agent-directory-");
    const retiredPath = createLegacyDatabaseFixture({
      agentId: "retired",
      env,
      eventsBySession: {},
      schemaVersion: 19,
      ...(location === "renamed-canonical"
        ? { path: path.join(stateDir, "agents", "old-name", "agent", "openclaw-agent.sqlite") }
        : usesCustomDirectory
          ? { path: path.join(customAgentDirectory, "openclaw-agent.sqlite") }
          : {}),
    });
    if (location === "unregistered") {
      unregisterOpenClawAgentDatabase({ agentId: "retired", path: retiredPath, env });
    }
    const customDirectory = tempDirs.make("doctor-held-non-agent-parent-");
    const customDatabase = createLegacyDatabaseFixture({
      agentId: "archive",
      env,
      eventsBySession: {},
      schemaVersion: 19,
      path: path.join(customDirectory, "history.sqlite"),
    });
    const agentDir = path.dirname(retiredPath);
    const catalogPath = path.join(agentDir, "models.json");
    const authPath = path.join(agentDir, "auth-profiles.json");
    const auth = JSON.stringify({
      version: 1,
      profiles: {
        "fixture:default": {
          type: "api_key",
          provider: "fixture",
          key: "synthetic-held-credential",
        },
      },
    });
    fs.writeFileSync(authPath, auth);
    fs.writeFileSync(path.join(customDirectory, "auth-profiles.json"), auth);
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://example.invalid/v1",
            apiKey: "synthetic-held-credential",
            models: [],
          },
        },
      }),
    );
    const authPaths = [authPath];
    const aliasArtifacts: string[] = [];
    if (location === "hardlinked-owner") {
      cfg.agents = { entries: { retired: {}, secondary: {} } };
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
      fs.writeFileSync(
        secondAuth,
        JSON.stringify({
          version: 1,
          profiles: {
            [profileId]: { type: "oauth", provider: ref.provider, oauthRef: ref },
          },
        }),
      );
      fs.copyFileSync(catalogPath, secondCatalog);
      const sidecar = path.join(stateDir, "credentials", "auth-profiles", `${ref.id}.json`);
      fs.mkdirSync(path.dirname(sidecar), { recursive: true });
      fs.writeFileSync(
        sidecar,
        JSON.stringify({
          version: 1,
          profileId,
          provider: ref.provider,
          access: "synthetic-held-access",
          refresh: "synthetic-held-refresh",
        }),
      );
      authPaths.push(secondAuth);
      aliasArtifacts.push(secondDatabase, secondAuth, secondCatalog, sidecar);
    }
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(cfg));
    closeOpenClawStateDatabaseForTest();
    const statePath = resolveOpenClawStateSqlitePath(env);
    const database = new DatabaseSync(statePath);
    database.exec("DROP TABLE agent_deletion_journal");
    database.close();
    const protectedPaths = [retiredPath, customDatabase, catalogPath, authPath, ...aliasArtifacts];
    const bytes = protectedPaths.map((file) => fs.readFileSync(file));
    const mainPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    expect(fs.existsSync(mainPath)).toBe(false);
    const initial = await prepareDoctorDatabasePreflight({ cfg });
    const reconstruction = await repairDoctorAgentDeletionJournal({
      preflight: initial,
      shouldRepair: true,
      env,
    });
    expect(reconstruction.changes.join("\n")).toContain("recorded a Doctor receipt");
    const state = openOpenClawStateDatabase({ env });
    expect(state.db.prepare("SELECT count(*) AS count FROM agent_deletion_journal").get()).toEqual({
      count: 0,
    });
    const source = state.db
      .prepare(
        "SELECT report_json FROM migration_sources WHERE migration_kind = 'agent-deletion-journal-reconstruction'",
      )
      .get();
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
      fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(cfg));
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
      const next = await prepareDoctorDatabasePreflight({ cfg });
      expect(
        (await repairDoctorAgentDeletionJournal({ preflight: next, shouldRepair: true, env }))
          .changes,
      ).toEqual([]);
      const sidecarRepair = await maybeRepairLegacyOAuthSidecarProfiles({
        cfg,
        env,
        emitNotes: false,
        prompter: { confirmAutoFix: async () => true },
      });
      expect(sidecarRepair.changes).toEqual([]);
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
        repairedStores: 0,
        repairedSessions: 0,
      });
      const leaseId = claimOpenClawAgentDatabaseLease({
        agentId: "retired",
        path: retiredPath,
        env,
      });
      releaseOpenClawAgentDatabaseLease(leaseId, { env }, "read-only");
      expect(protectedPaths.map((file) => fs.readFileSync(file))).toEqual(bytes);
    }
  },
);
