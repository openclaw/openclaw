import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { repairDoctorAgentDeletionJournal } from "../commands/doctor-agent-deletion-journal.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "../commands/doctor-auth-flat-profiles.js";
import { listAuthProfileRepairCandidates } from "../commands/doctor-auth-legacy-paths.js";
import { maybeMigrateModelCatalogCredentials } from "../commands/doctor-model-catalog-credentials.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import { repairCanonicalSessionKeys } from "../commands/doctor-session-canonical-keys.js";
import { runDoctorSessionSqlite } from "../commands/doctor-session-sqlite.js";
import { noteSessionTranscriptHeaderHealth } from "../commands/doctor-session-transcript-headers.js";
import { noteSessionTranscriptLabelHealth } from "../commands/doctor-session-transcript-labels.js";
import { noteSessionTranscriptHealth } from "../commands/doctor-session-transcripts.js";
import { noteStateIntegrity } from "../commands/doctor-state-integrity.js";
import { detectTelegramGeneralTopicConversationRepairs } from "../commands/doctor-telegram-general-topic-conversations.js";
import { maybeRepairCodexSessionRoutes } from "../commands/doctor/shared/codex-route-session-repair.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  assertOpenClawDatabasesReady,
  preflightOpenClawDatabaseSchemas,
} from "../state/openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { projectExistingAgentDatabaseTargets } from "./session-sqlite-migration-readers.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "./state-migrations.media-persistence-targets.js";
import {
  createLegacyDatabaseFixture,
  readDatabaseSnapshot,
} from "./state-migrations.media-persistence.test-support.js";
import { throwIfDoctorStateMigrationRefused } from "./state-migrations.messages.js";
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "./state-migrations.shared-auth-store.js";
import type { LegacyStateMigrationStepReceipt } from "./state-migrations.types.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  note.mockClear();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Doctor with a deleted agent database", () => {
  it.each([false, true])(
    "records held stores as advisories and completes independent repairs (unknown custom owner: %s)",
    async (unknownOwner) => {
      const stateDir = fs.realpathSync.native(tempDirs.make("doctor-missing-deletion-history-"));
      const env = { OPENCLAW_STATE_DIR: stateDir };
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {} } },
        plugins: { enabled: false },
      };
      const stores = ["main", "retired"].map((agentId) =>
        createLegacyDatabaseFixture({ agentId, env, eventsBySession: {}, schemaVersion: 19 }),
      );
      const custom = path.join(tempDirs.make("doctor-held-custom-"), "history.sqlite");
      if (unknownOwner) {
        const fixture = createLegacyDatabaseFixture({
          agentId: "unknown",
          env,
          eventsBySession: {},
          schemaVersion: 19,
          path: custom,
        });
        const customDb = new DatabaseSync(fixture);
        customDb.exec("DELETE FROM schema_meta");
        customDb.close();
        unregisterOpenClawAgentDatabase({ agentId: "unknown", path: custom, env });
        stores.push(custom);
        cfg.session = { store: custom };
      }
      closeOpenClawStateDatabaseForTest();
      const database = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
      database.exec("DROP TABLE agent_deletion_journal");
      database.close();
      const bytes = stores.map((file) => fs.readFileSync(file));
      let prepared: PreparedAgentDatabaseMigrationDiscovery | undefined;
      const preflight = await preflightOpenClawDatabaseSchemas({
        env,
        configuredAgentDatabaseTargets: [{ agentId: "main", path: stores[0]! }],
        configuredAgentDatabaseCandidatePaths: unknownOwner ? [custom] : [],
        onAgentDatabaseDiscovery: (discovery) => {
          prepared = discovery;
        },
      });
      if (unknownOwner) {
        const recovery = await repairDoctorAgentDeletionJournal({
          preflight: { ...preflight, agentDatabaseMigrationDiscovery: prepared },
          shouldRepair: true,
          env,
        });
        expect(recovery.changes).toEqual([]);
        expect(recovery.warnings.join("\n")).toContain("recovery inventory is incomplete");
      }
      const execPath = path.join(stateDir, "exec-approvals.json");
      fs.writeFileSync(execPath, JSON.stringify({ version: 1, defaults: {}, agents: {} }));
      const receipts: LegacyStateMigrationStepReceipt[] = [];
      const result = await autoMigrateLegacyState({
        cfg,
        env,
        agentDatabaseMigrationDiscovery: prepared,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        onStepReceipt: (receipt) => receipts.push(receipt),
        log: { info() {}, warn() {} },
      });
      expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).not.toThrow();
      const sharedAuth = receipts.find((receipt) => receipt.id === "shared-auth-store");
      expect(sharedAuth).toMatchObject({
        outcome: "skipped",
        warnings: [expect.stringContaining("skipped: store held for agent main")],
      });
      expect(result.warnings).toContain(sharedAuth!.warnings[0]);
      expect(sharedAuth!.warnings[0]).toContain(stores[0]);
      expect(result.warnings.join("\n")).toContain("deletion journal missing");
      expect(fs.existsSync(execPath)).toBe(false);
      expect(receipts.find((receipt) => receipt.id === "exec-approvals")?.outcome).toBe(
        "completed",
      );
      stores.forEach((file, index) => expect(fs.readFileSync(file)).toEqual(bytes[index]));
    },
  );

  it("repairs a configured survivor when only the deleted owner's registration remains", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("doctor-configured-survivor-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      plugins: { enabled: false },
    };
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {},
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    registerOpenClawAgentDatabase({ agentId: "retired", path: databasePath, env });
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId: "delete-retired",
        agentDir: path.dirname(databasePath),
        workspaceDir: path.join(stateDir, "workspace-retired"),
        sessionsDir: path.join(stateDir, "agents", "retired", "sessions"),
        deleteFiles: false,
      },
      { env },
    );
    runOpenClawStateWriteTransaction(
      (database) => {
        completeAgentDeletionJournalInDatabase(database, "retired", "delete-retired");
      },
      { env },
    );
    unregisterOpenClawAgentDatabase({ agentId: "main", path: databasePath, env });
    expect(
      projectExistingAgentDatabaseTargets(
        [
          { agentId: "retired", storePath: databasePath },
          { agentId: "main", storePath: databasePath },
        ],
        env,
        cfg,
      ).map((target) => target.agentId),
    ).toEqual(["main"]);
    expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
      scannedStores: 1,
    });
    unregisterOpenClawAgentDatabase({ agentId: "main", path: databasePath, env });
    const activeAlias = path.join(stateDir, "active-alias.sqlite");
    fs.linkSync(databasePath, activeAlias);
    try {
      await expect(
        runDoctorSessionSqlite({ allAgents: true, cfg, env, mode: "import" }),
      ).rejects.toThrow("hard-linked path");
    } finally {
      fs.unlinkSync(activeAlias);
    }
    fs.writeFileSync(
      path.join(path.dirname(databasePath), "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://example.invalid/v1",
            apiKey: "synthetic-catalog-key",
            models: [],
          },
        },
      }),
    );
    const runtime = {
      log() {},
      error() {},
      exit(code: number): never {
        throw new Error(`unexpected exit ${code}`);
      },
    };
    const catalogs = await maybeMigrateModelCatalogCredentials({
      cfg,
      env,
      runtime,
      prompter: createDoctorPrompter({ runtime, options: { repair: true, nonInteractive: true } }),
    });
    expect(catalogs).toMatchObject({ detected: 1, migrated: 1, warnings: [] });
    const activeLegacyStore = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(activeLegacyStore), { recursive: true });
    fs.writeFileSync(
      activeLegacyStore,
      JSON.stringify({ "agent:main:legacy": { sessionId: "active-legacy", updatedAt: 1 } }),
    );
    expect(() => assertSessionStoreMigrationComplete({ cfg, env, operation: "doctor" })).toThrow(
      "Legacy session store requires migration",
    );
  });

  it("records shared auth as held for deleted main even with a surviving physical registration", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("doctor-retained-shared-auth-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sourcePath = createLegacyDatabaseFixture({
      agentId: "alive",
      path: path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      env,
      eventsBySession: {},
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    const source = new DatabaseSync(sourcePath);
    source
      .prepare(
        "INSERT INTO auth_profile_store(store_key,store_json,updated_at) VALUES('primary',?,1)",
      )
      .run(
        JSON.stringify({
          version: 1,
          profiles: {
            "fixture:default": {
              type: "api_key",
              provider: "fixture",
              key: "synthetic-retained-main-key",
            },
          },
        }),
      );
    source.close();
    beginAgentDeletionJournal(
      {
        agentId: "main",
        operationId: "delete-shared-auth",
        agentDir: path.dirname(sourcePath),
        workspaceDir: path.join(stateDir, "workspace"),
        sessionsDir: path.join(stateDir, "agents", "main", "sessions"),
        deleteFiles: false,
      },
      { env },
    );
    runOpenClawStateWriteTransaction(
      (database) => completeAgentDeletionJournalInDatabase(database, "main", "delete-shared-auth"),
      { env },
    );
    const bytes = fs.readFileSync(sourcePath);
    const detected = detectSharedAuthStoreMigration({
      stateDir,
      env,
      doctorOnlyStateMigrations: true,
    });
    const result = await migrateSharedAuthStore({ detected, stateDir, env });
    expect(result).toMatchObject({
      outcome: "skipped",
      warningDisposition: "recoverable",
      changes: [],
    });
    expect(result.warnings.join("\n")).toContain("agent main");
    expect(result.warnings.join("\n")).toContain(sourcePath);
    expect(result.warnings.join("\n")).toContain("openclaw doctor --fix");
    await expect(
      noteStateIntegrity(
        { agents: { ownership: "explicit", entries: { main: {} } }, plugins: { enabled: false } },
        { confirmRuntimeRepair: async () => false, note },
      ),
    ).resolves.toBeUndefined();
    expect(fs.readFileSync(sourcePath)).toEqual(bytes);
  });

  it("keeps deleted credential files held when only their database is shared with an active owner", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("doctor-retained-credential-alias-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      plugins: { enabled: false },
    };
    const activePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {},
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    const retiredDir = path.join(stateDir, "agents", "retired", "agent");
    fs.mkdirSync(retiredDir, { recursive: true });
    const retiredPath = path.join(retiredDir, "openclaw-agent.sqlite");
    fs.linkSync(activePath, retiredPath);
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId: "delete-credential-alias",
        agentDir: retiredDir,
        workspaceDir: path.join(stateDir, "retired-workspace"),
        sessionsDir: path.join(stateDir, "agents", "retired", "sessions"),
        deleteFiles: false,
      },
      { env },
    );
    runOpenClawStateWriteTransaction(
      (database) =>
        completeAgentDeletionJournalInDatabase(database, "retired", "delete-credential-alias"),
      { env },
    );
    const catalog = path.join(retiredDir, "models.json");
    const auth = path.join(retiredDir, "auth-profiles.json");
    fs.writeFileSync(
      catalog,
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://example.invalid/v1",
            apiKey: "synthetic-retained-key",
            models: [],
          },
        },
      }),
    );
    fs.writeFileSync(
      auth,
      JSON.stringify({
        version: 1,
        profiles: {
          "fixture:default": {
            type: "api_key",
            provider: "fixture",
            key: "synthetic-retained-key",
          },
        },
      }),
    );
    const bytes = [catalog, auth].map((file) => fs.readFileSync(file));
    expect(
      listAuthProfileRepairCandidates(cfg, env).map((candidate) => candidate.authPath),
    ).not.toContain(auth);
    const imported = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg,
      env,
      prompter: { confirmAutoFix: async () => true },
    });
    expect(imported.detected).not.toContain(auth);
    const runtime = {
      log() {},
      error() {},
      exit(code: number): never {
        throw new Error(`unexpected exit ${code}`);
      },
    };
    const result = await maybeMigrateModelCatalogCredentials({
      cfg,
      env,
      runtime,
      prompter: createDoctorPrompter({ runtime, options: { repair: true, nonInteractive: true } }),
    });
    expect(result).toMatchObject({ detected: 0, migrated: 0, warnings: [] });
    expect([catalog, auth].map((file) => fs.readFileSync(file))).toEqual(bytes);
  });

  it.each([
    { deleteFiles: false, registered: true, location: "default" },
    { deleteFiles: false, registered: false, location: "default" },
    { deleteFiles: false, registered: false, location: "custom" },
    { deleteFiles: false, registered: false, location: "old-name" },
    { deleteFiles: true, registered: true, location: "default" },
  ])(
    "preserves deleted state (deleteFiles=$deleteFiles, registered=$registered, location=$location)",
    async ({ deleteFiles, registered, location }) => {
      const stateDir = fs.realpathSync.native(tempDirs.make("doctor-retained-deletion-"));
      const env = { OPENCLAW_STATE_DIR: stateDir };
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {} } },
        plugins: { enabled: false },
      };
      const activePath = createLegacyDatabaseFixture({
        env,
        eventsBySession: {},
        schemaVersion: 19,
      });
      const retainedPath = createLegacyDatabaseFixture({
        agentId: "retired",
        env,
        eventsBySession: {},
        schemaVersion: 19,
        ...(location !== "default"
          ? {
              path: path.join(
                location === "custom"
                  ? tempDirs.make("doctor-retained-custom-")
                  : path.join(stateDir, "agents", "old-name"),
                "agent",
                "openclaw-agent.sqlite",
              ),
            }
          : {}),
      });
      const agentDir = path.dirname(retainedPath);
      const retainedStore = path.join(stateDir, "agents", "retired", "sessions", "sessions.json");
      const retainedStoreBytes = JSON.stringify({
        "agent:retired:legacy": { sessionId: "retired-legacy", updatedAt: 1 },
      });
      fs.mkdirSync(path.dirname(retainedStore), { recursive: true });
      fs.writeFileSync(retainedStore, retainedStoreBytes);
      const workspaceDir = path.join(stateDir, "workspace-retired");
      beginAgentDeletionJournal(
        {
          agentId: "retired",
          operationId: "delete-retired",
          agentDir,
          workspaceDir,
          sessionsDir: path.join(stateDir, "agents", "retired", "sessions"),
          deleteFiles,
        },
        { env },
      );
      if (!deleteFiles) {
        runOpenClawStateWriteTransaction(
          (database) => {
            completeAgentDeletionJournalInDatabase(database, "retired", "delete-retired");
          },
          { env },
        );
      }
      if (!registered) {
        unregisterOpenClawAgentDatabase({ agentId: "retired", path: retainedPath, env });
      }
      const before = fs.readFileSync(retainedPath);
      const candidatePath =
        !deleteFiles && registered && location === "default"
          ? path.join(stateDir, "retained-candidate.sqlite")
          : retainedPath;
      if (candidatePath !== retainedPath) {
        fs.linkSync(retainedPath, candidatePath);
      }
      let prepared: PreparedAgentDatabaseMigrationDiscovery | undefined;
      const preflight = await preflightOpenClawDatabaseSchemas({
        env,
        configuredAgentDatabaseTargets: [],
        configuredAgentDatabaseCandidatePaths: [candidatePath],
        onAgentDatabaseDiscovery: (discovery) => {
          prepared = discovery;
        },
      });
      if (!deleteFiles) {
        expect(preflight.pendingMigrations?.map((entry) => entry.path)).toEqual([activePath]);
        expect(prepared?.discovery.warnings.join("\n")).toContain("retained-by-deletion");
        expect(prepared?.discovery.warnings.join("\n")).toContain(retainedPath);
      }
      expect(fs.readFileSync(retainedPath).equals(before)).toBe(true);
      const execPath = path.join(stateDir, "exec-approvals.json");
      fs.writeFileSync(execPath, JSON.stringify({ version: 1, defaults: {}, agents: {} }));
      const result = await autoMigrateLegacyState({
        cfg,
        env,
        agentDatabaseMigrationDiscovery: prepared,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        log: { info() {}, warn() {} },
      });
      expect(readDatabaseSnapshot(activePath).version.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      const migration = result.stepReceipts.find((receipt) => receipt.id === "media-persistence");
      if (deleteFiles) {
        expect(migration).toMatchObject({ outcome: "refused" });
        expect(migration?.warnings.join("\n")).toContain(
          "unavailable while agent retired is deleted",
        );
        expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).toThrow(
          "Later repairs were not run",
        );
        expect(fs.existsSync(execPath)).toBe(true);
      } else {
        expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).not.toThrow();
        expect(migration).toMatchObject({ outcome: "warning" });
        expect(migration?.warnings.join("\n")).toContain("Held agent retired");
        expect(migration?.warnings.join("\n")).toContain(retainedPath);
        expect(migration?.warnings.join("\n")).toContain("openclaw doctor --fix");
        expect(result.warnings).toEqual(expect.arrayContaining(migration!.warnings));
        expect(fs.existsSync(execPath)).toBe(false);
        if (registered && location === "default") {
          await expect(
            runDoctorSessionSqlite({ cfg, env, mode: "import", agent: "retired" }),
          ).rejects.toThrow("hard-linked path");
          await noteSessionTranscriptHealth({
            cfg,
            env,
            shouldRepair: true,
            postSessionPluginMigration: result.postSessionPluginMigration,
            postSessionPluginMigrationPlanBound: true,
          });
          await noteSessionTranscriptHeaderHealth({ cfg, env, shouldRepair: true });
          await noteSessionTranscriptLabelHealth({ cfg, env, shouldRepair: true });
          const runtime = {
            log() {},
            error() {},
            exit(code: number): never {
              throw new Error(`unexpected exit ${code}`);
            },
          };
          const catalogs = await maybeMigrateModelCatalogCredentials({
            cfg,
            env,
            runtime,
            prompter: createDoctorPrompter({
              runtime,
              options: { repair: true, nonInteractive: true },
            }),
          });
          expect(catalogs.warnings).toEqual([]);
          expect(detectTelegramGeneralTopicConversationRepairs({ cfg, env })).toEqual([]);
          expect(
            await maybeRepairCodexSessionRoutes({ cfg, env, shouldRepair: true }),
          ).toMatchObject({ warnings: [] });
          expect(note).not.toHaveBeenCalledWith(
            expect.stringContaining("retired"),
            "Doctor warnings",
          );
        } else {
          expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
            scannedStores: 1,
          });
        }
        await expect(
          assertOpenClawDatabasesReady({
            env,
            operation: "doctor",
            configuredAgentDatabaseTargets: [],
          }),
        ).resolves.toBeUndefined();
        await expect(
          assertOpenClawDatabasesReady({ env, operation: "gateway-restart" }),
        ).resolves.toBeUndefined();
        expect(() =>
          assertSessionStoreMigrationComplete({ cfg, env, operation: "doctor" }),
        ).not.toThrow();
        expect(fs.readFileSync(retainedStore, "utf8")).toBe(retainedStoreBytes);
        if (registered && location === "default") {
          const globalStore = path.join(stateDir, "sessions", "sessions.json");
          fs.mkdirSync(path.dirname(globalStore), { recursive: true });
          fs.writeFileSync(globalStore, retainedStoreBytes);
          const assertGlobalReady = () =>
            assertSessionStoreMigrationComplete({
              cfg: { agents: { ownership: "explicit", entries: { retired: {} } } },
              env,
              operation: "doctor",
            });
          expect(assertGlobalReady).not.toThrow();
          expect(fs.readFileSync(globalStore, "utf8")).toBe(retainedStoreBytes);
          fs.writeFileSync(
            globalStore,
            JSON.stringify({
              "agent:retired:legacy": { sessionId: "retired-legacy", updatedAt: 1 },
              "agent:unassigned:legacy": { sessionId: "unknown-legacy", updatedAt: 1 },
            }),
          );
          expect(assertGlobalReady).toThrow("Legacy session store requires migration");
          fs.writeFileSync(globalStore, "{}");
          expect(assertGlobalReady).toThrow("Legacy session store requires migration");
        }
        expect(fs.readFileSync(retainedPath).equals(before)).toBe(true);
      }
      expect(() => openOpenClawAgentDatabase({ agentId: "retired", env })).toThrow(
        "unavailable while agent retired is deleted",
      );
    },
  );
});
