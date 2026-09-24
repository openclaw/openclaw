import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../agents/config.js";
import { resolveInstallAgentDir } from "../agents/install-agent-dir.js";
import { readCurrentConfigForResolution } from "../config/io.runtime.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pluginDoctorContractRegistryLoaderState } from "../plugins/doctor-contract-registry-loader-state.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { snapshotFiles } from "./state-migrations.caller-mode.test-helpers.js";
import {
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  planLegacyStateMigrationsReadOnly,
} from "./state-migrations.doctor.js";
import { migrateLegacyAgentDir } from "./state-migrations.legacy-sessions.js";
import type { LegacyStateMigrationPlan } from "./state-migrations.types.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";

const tempDirs = createTrackedTempDirs();

function candidateAt(
  root: string,
  version = "test",
): Pick<LegacyStateMigrationPlan["candidate"], "root" | "version"> {
  return { root, version };
}

async function makeFixture() {
  const root = await tempDirs.make("openclaw-doctor-caller-mode-");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "copied-state");
  const configPath = path.join(root, "copied-openclaw.json");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  // Storage receipts need a real candidate inventory, not unrelated bundled Doctor runtimes.
  const bundledRoot = path.join(root, "extensions");
  const pluginRoot = path.join(bundledRoot, "candidate-plugin");
  fs.mkdirSync(pluginRoot, { recursive: true });
  createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: "candidate-plugin",
    manifest: {
      providers: [],
      channels: [],
      channelConfigs: {},
      providerAuthChoices: [],
      doctorContract: { stateMigrations: [] },
    },
  });
  const cfg: OpenClawConfig = {
    plugins: { entries: { "candidate-plugin": { enabled: true } } },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(cfg)}\n`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  };
  return { root, homeDir, stateDir, configPath, env };
}

afterEach(async () => {
  pluginDoctorContractRegistryLoaderState.moduleLoaderFactory = undefined;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

describe("legacy state migration caller storage", () => {
  it("reports legacy-main session repairs without migrating when other detectors are empty", async () => {
    await withOpenClawTestState(
      { label: "preflight-legacy-main", layout: "split", agentEnv: "clear" },
      async (state) => {
        const cfg = { agents: { entries: { worker: {} } } };
        const source = { agentId: "main", env: state.env, sessionKey: "agent:main:chat" };
        const destination = { agentId: "worker", env: state.env, sessionKey: "agent:worker:chat" };
        const entry = { sessionId: "legacy-main-session", updatedAt: 100 };
        runOpenClawAgentWriteTransaction(
          (database) =>
            writeSessionEntry(database, source.sessionKey, entry, {
              allowStoredAliases: true,
              previousEntry: null,
            }),
          source,
        );

        const result = await autoMigrateLegacyState({
          cfg,
          env: state.env,
          homedir: () => state.home,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });

        expect(result.changes).not.toContain(
          "Migrated legacy main session claim agent:worker:chat.",
        );
        expect(result.notices).toContainEqual(expect.stringContaining("openclaw doctor --fix"));
        expect(loadExactSessionEntryReadOnly(source)?.entry).toMatchObject(entry);
        expect(loadExactSessionEntryReadOnly(destination)).toBeUndefined();
      },
    );
  });

  it.each([undefined, "missing"])(
    "keeps retained migration ownership separate from runtime selection with system owner %s",
    async (systemAgentId) => {
      await withOpenClawTestState(
        { label: "retained-install-owner", layout: "split", agentEnv: "clear" },
        async (state) => {
          const cfg: OpenClawConfig = {
            agents: {
              ownership: "explicit",
              defaults: systemAgentId ? { systemAgent: { agentId: systemAgentId } } : {},
              entries: { main: {}, worker: {} },
            },
          };
          retainLegacyDefaultAgentId(cfg, "worker");
          const resolution = resolveInstallAgentDir(cfg, {
            env: state.env,
            homedir: () => state.home,
          });

          expect(resolution.migrationTarget).toEqual(
            systemAgentId ? undefined : { dir: state.agentDir("worker"), owner: "worker" },
          );
          expect(resolution.optionalDirectory).toBeUndefined();
        },
      );
    },
  );

  it.each(
    [
      { name: "configured main directory", agentId: "main", custom: true, override: "none" },
      {
        name: "deferred main SQLite family",
        agentId: "main",
        custom: true,
        override: "none",
        sqlite: true,
      },
      { name: "non-main default", agentId: "worker", custom: false, override: "none" },
      { name: "configured non-main directory", agentId: "worker", custom: true, override: "none" },
      { name: "explicit legacy directory", agentId: "worker", custom: true, override: "legacy" },
      { name: "explicit other directory", agentId: "worker", custom: true, override: "other" },
      {
        name: "explicit tilde legacy directory",
        agentId: "worker",
        custom: true,
        override: "tilde",
      },
    ].flatMap((testCase) => [false, true].map((malformed) => ({ testCase, malformed }))),
  )(
    "shares the install directory between SDK and Doctor: $testCase.name (malformed: $malformed)",
    async ({ testCase, malformed }) => {
      await withOpenClawTestState(
        { label: "install-agent-dir", layout: "split", agentEnv: "clear" },
        async (state) => {
          const legacyDir = path.join(state.home, ".openclaw", "agent");
          const configuredDir = testCase.custom
            ? state.path("configured-agent")
            : state.agentDir(testCase.agentId);
          const overrideDir =
            testCase.override === "none"
              ? undefined
              : testCase.override === "other"
                ? state.path("selected-agent")
                : legacyDir;
          const targetDir = overrideDir ?? (malformed ? state.agentDir("main") : configuredDir);
          const agentConfig = {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: testCase.agentId } },
            entries: {
              spare: {},
              [testCase.agentId]: testCase.custom ? { agentDir: "${SDK_FIXTURE_AGENT_DIR}" } : {},
            },
          };
          await state.writeConfig({
            agents: { $include: "agents.json" },
            env: { vars: { SDK_FIXTURE_AGENT_DIR: configuredDir } },
            plugins: { enabled: false },
          });
          fs.writeFileSync(
            path.join(path.dirname(state.configPath), "agents.json"),
            JSON.stringify(agentConfig),
          );
          if (malformed) {
            fs.writeFileSync(state.configPath, "{broken config");
          }
          const binary = process.platform === "win32" ? "fd.exe" : "fd";
          fs.mkdirSync(path.join(legacyDir, "bin"), { recursive: true });
          fs.writeFileSync(path.join(legacyDir, "bin", binary), "legacy binary");
          fs.writeFileSync(path.join(legacyDir, "settings.json"), "SDK settings");
          const legacyDatabase = path.join(legacyDir, "openclaw-agent.sqlite");
          if (testCase.sqlite) {
            openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: legacyDatabase });
            closeOpenClawAgentDatabasesForTest();
          }
          if (targetDir !== legacyDir) {
            fs.mkdirSync(path.join(targetDir, "bin"), { recursive: true });
            fs.writeFileSync(path.join(targetDir, "bin", binary), "current binary");
          }
          await withEnvAsync(
            {
              OPENCLAW_AGENT_DIR: testCase.override === "tilde" ? "~/.openclaw/agent" : overrideDir,
              OPENCLAW_HOME: state.path("alternate-home"),
              OPENCLAW_OFFLINE: "1",
              SDK_FIXTURE_AGENT_DIR: undefined,
            },
            async () => {
              const before = snapshotFiles(state.root);
              expect(getAgentDir()).toBe(overrideDir ?? legacyDir);
              expect(snapshotFiles(state.root)).toEqual(before);
              expect(process.env.SDK_FIXTURE_AGENT_DIR).toBeUndefined();
              const { ensureTool } = await import("../agents/utils/tools-manager.js");
              const resolution = readCurrentConfigForResolution();
              const { config: cfg, env } = resolution;
              expect(Boolean(resolution.configDiagnostics)).toBe(malformed);
              const detected = await detectLegacyStateMigrations({
                cfg,
                env,
                homedir: () => state.home,
                legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
              });
              // Doctor's invalid-config gate is separate from its selected directory repair.
              const migration = malformed
                ? await migrateLegacyAgentDir(detected, () => 1234)
                : (
                    await autoMigrateLegacyState({
                      cfg,
                      env,
                      homedir: () => state.home,
                      doctorOnlyStateMigrations: true,
                      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
                    })
                  ).stepReceipts.find((receipt) => receipt.id === "agent-dir");
              expect(migration).toBeDefined();
              if (testCase.sqlite) {
                expect(migration).toMatchObject({
                  outcome: "deferred",
                  sqliteFamilies: [
                    {
                      database: legacyDatabase,
                      files: expect.arrayContaining([legacyDatabase]),
                      destination: path.join(targetDir, "openclaw-agent.sqlite"),
                      outcome: "deferred",
                      reason: "sqlite-family",
                    },
                  ],
                });
                expect(fs.existsSync(legacyDatabase)).toBe(true);
                expect(fs.existsSync(path.join(targetDir, "openclaw-agent.sqlite"))).toBe(false);
                expect(
                  fs.existsSync(path.join(targetDir, ".legacy-agent-dir-migration.json")),
                ).toBe(false);
              }

              const activeDir = testCase.sqlite ? legacyDir : targetDir;
              expect(getAgentDir()).toBe(activeDir);
              expect(
                resolveInstallAgentDir(cfg, { env, homedir: () => state.home }).directory.dir,
              ).toBe(activeDir);
              expect(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf8")).toBe(
                "SDK settings",
              );
              expect(detected.agentDir.targetDir).toBe(targetDir);
              await expect(ensureTool("fd", true)).resolves.toBe(
                path.join(activeDir, "bin", binary),
              );
              expect(fs.readFileSync(path.join(targetDir, "bin", binary), "utf8")).toBe(
                targetDir === legacyDir ? "legacy binary" : "current binary",
              );
              expect(snapshotFiles(state.root)[path.relative(state.root, state.configPath)]).toBe(
                before[path.relative(state.root, state.configPath)],
              );
              expect(process.env.SDK_FIXTURE_AGENT_DIR).toBeUndefined();
            },
          );
        },
      );
    },
  );

  it.each(["before detection", "after detection"])(
    "keeps rehearsal SDK sources confined when an ancestor symlink escapes %s",
    async (timing) => {
      const fixture = await makeFixture();
      const externalParent = path.join(fixture.homeDir, ".openclaw");
      const externalBinary = path.join(externalParent, "agent/bin/fd");
      fs.mkdirSync(path.dirname(externalBinary), { recursive: true });
      fs.writeFileSync(externalBinary, "uncopied SDK binary");
      const copiedParent = path.join(fixture.stateDir, ".openclaw");
      const symlinkKind = process.platform === "win32" ? "junction" : "dir";
      if (timing === "before detection") {
        fs.symlinkSync(externalParent, copiedParent, symlinkKind);
      } else {
        fs.mkdirSync(path.join(copiedParent, "agent/bin"), { recursive: true });
        fs.writeFileSync(path.join(copiedParent, "agent/bin/fd"), "copied SDK binary");
      }
      const env = {
        ...fixture.env,
        ...buildUpdateRehearsalPathEnv(fixture.stateDir),
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
      };
      const detected = await detectLegacyStateMigrations({
        cfg: { agents: { entries: { main: {} } }, plugins: { enabled: false } },
        env,
        homedir: () => fixture.stateDir,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      if (timing === "after detection") {
        fs.renameSync(copiedParent, path.join(fixture.stateDir, "saved-sdk-home"));
        fs.symlinkSync(externalParent, copiedParent, symlinkKind);
      }

      const result = await migrateLegacyAgentDir(detected, () => 1234);

      expect(fs.existsSync(externalBinary)).toBe(true);
      expect(fs.readFileSync(externalBinary, "utf8")).toBe("uncopied SDK binary");
      expect([...detected.warnings, ...result.warnings].length).toBeGreaterThan(0);
      const canonicalDir = path.join(fixture.stateDir, "agents/main/agent");
      expect(fs.existsSync(path.join(canonicalDir, ".legacy-agent-dir-migration.json"))).toBe(
        false,
      );
      expect(
        resolveInstallAgentDir(
          {},
          {
            env,
            homedir: () => fixture.stateDir,
          },
        ).directory.dir,
      ).toBe(canonicalDir);
    },
  );

  it("binds WAL-backed shared-auth and meeting-transcript inputs as SQLite", async () => {
    const fixture = await makeFixture();
    const cfg: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    const agentDatabasePath = path.join(
      fixture.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    const stateDatabasePath = resolveOpenClawStateSqlitePath(fixture.env);
    openOpenClawStateDatabase({ env: fixture.env });
    openOpenClawAgentDatabase({
      agentId: "main",
      env: fixture.env,
      path: agentDatabasePath,
    });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const agentDatabase = new DatabaseSync(agentDatabasePath);
    const stateDatabase = new DatabaseSync(stateDatabasePath);
    let plan: LegacyStateMigrationPlan | undefined;
    try {
      agentDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      agentDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      agentDatabase
        .prepare(
          "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
        )
        .run(
          "primary",
          JSON.stringify({
            version: 1,
            profiles: {
              "openai:wal": { type: "api_key", provider: "openai", key: "wal-key" },
            },
          }),
          1,
        );
      stateDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      stateDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const historicalSlug = `meeting-${"x".repeat(2200)}`;
      stateDatabase
        .prepare(
          `INSERT INTO meeting_transcript_sessions
             (session_id, started_at, selector, export_key, session_slug, provider_id,
              source_json, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "wal-meeting",
          "2026-09-03T00:00:00.000Z",
          `2026-09-03/${historicalSlug}`,
          `2026-09-03/${historicalSlug}`,
          historicalSlug,
          "manual-transcript",
          JSON.stringify({ providerId: "manual-transcript", channelId: "room" }),
          1,
          1,
        );
      expect(fs.existsSync(`${agentDatabasePath}-wal`)).toBe(true);
      expect(fs.existsSync(`${stateDatabasePath}-wal`)).toBe(true);

      plan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: {
          homeDir: fixture.homeDir,
          configPath: fixture.configPath,
          stateDir: fixture.stateDir,
        },
        env: fixture.env,
      });
    } finally {
      agentDatabase.close();
      stateDatabase.close();
    }
    if (!plan) {
      throw new Error("expected WAL-backed migration plan");
    }
    const sharedAuthPlan = plan.steps.find((step) => step.id === "shared-auth-store");
    const meetingPlan = plan.steps.find((step) => step.id === "meeting-transcripts");
    expect(sharedAuthPlan).toMatchObject({
      requiredness: "conditional",
      source: [{ kind: "sqlite", path: agentDatabasePath }],
    });
    expect(meetingPlan).toMatchObject({ requiredness: "required" });
    expect(meetingPlan?.source).toContainEqual({ kind: "sqlite", path: stateDatabasePath });

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "shared-auth-store")).toMatchObject(
      {
        outcome: "completed",
        source: sharedAuthPlan?.source,
        requiredness: "conditional",
      },
    );
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "meeting-transcripts"),
    ).toMatchObject({
      outcome: "completed",
      source: meetingPlan?.source,
    });
  });

  it("plans managed-worktree owners that remain after state-schema repair", async () => {
    const fixture = await makeFixture();
    const stateDatabase = openOpenClawStateDatabase({ env: fixture.env });
    stateDatabase.db
      .prepare(`
        INSERT INTO worktrees (
          id, repo_fingerprint, repo_root, path, branch, base_ref, owner_kind,
          created_at, last_active_at, provisioned_paths_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(
        "legacy-after-schema",
        "legacy-fingerprint",
        fixture.root,
        path.join(fixture.stateDir, "worktrees", "legacy-after-schema"),
        "openclaw/legacy-after-schema",
        "HEAD",
        "session",
        1,
        1,
      );
    const stateDatabasePath = stateDatabase.path;
    closeOpenClawStateDatabaseForTest();
    const legacy = new DatabaseSync(stateDatabasePath);
    try {
      legacy.exec("PRAGMA user_version = 1;");
    } finally {
      legacy.close();
    }

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });

    expect(plan.steps[0]).toMatchObject({ id: "state-schema", requiredness: "required" });
    expect(plan.steps.find((step) => step.id === "managed-worktrees")).toMatchObject({
      source: [
        { kind: "sqlite", path: stateDatabasePath },
        { kind: "owner", id: "core:managed-worktree:legacy-after-schema" },
      ],
      requiredness: "required",
    });
  });
});
