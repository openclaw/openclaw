import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { getAgentDir } from "../agents/config.js";
import { resolveInstallAgentDir } from "../agents/install-agent-dir.js";
import { readCurrentConfigForResolution } from "../config/io.runtime.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { deriveMeetingTranscriptSessionColumns } from "../transcripts/store-columns.js";
import { meetingTranscriptDb } from "../transcripts/store-sqlite.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import { snapshotFiles } from "./state-migrations.caller-mode.test-helpers.js";
import { autoMigrateLegacyState, detectLegacyStateMigrations } from "./state-migrations.doctor.js";
import { resolveLegacyStateMigrationOwner } from "./state-migrations.legacy-owner.js";
import { migrateLegacyAgentDir } from "./state-migrations.legacy-sessions.js";
import {
  byId,
  createMigrationFixture,
  writeFixtureFile as writeFile,
} from "./state-migrations.shard-fixture.test-support.js";
import type { LegacyStateMigrationPlan } from "./state-migrations.types.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";

const tempDirs = createTrackedTempDirs();

function migrationOptions(cfg: OpenClawConfig, env: NodeJS.ProcessEnv, home: string) {
  return { cfg, env, homedir: () => home, legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES };
}

function withState(
  run: Parameters<typeof withOpenClawTestState>[1],
  layout: "split" | "home" = "split",
) {
  return withOpenClawTestState({ layout, agentEnv: "clear" }, run);
}

async function makeFixture() {
  const root = await tempDirs.make("openclaw-doctor-caller-mode-");
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
  return createMigrationFixture(root, {
    config: { plugins: { entries: { "candidate-plugin": { enabled: true } } } },
    bundledPluginsDir: bundledRoot,
  });
}

const installDefaults = { custom: true, override: "none", sqlite: false, malformed: false };

function installCase(
  name: string,
  agentId: string,
  overrides: Partial<typeof installDefaults> = {},
) {
  return { name, agentId, ...installDefaults, ...overrides };
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

it("reports legacy-main session repairs without migrating when other detectors are empty", async () => {
  await withState(async (state) => {
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

    const result = await autoMigrateLegacyState(migrationOptions(cfg, state.env, state.home));

    expect(result.changes).not.toContain("Migrated legacy main session claim agent:worker:chat.");
    expect(result.notices).toContainEqual(expect.stringContaining("openclaw doctor --fix"));
    expect(loadExactSessionEntryReadOnly(source)?.entry).toMatchObject(entry);
    expect(loadExactSessionEntryReadOnly(destination)).toBeUndefined();
  });
});

it.each([undefined, "missing"])(
  "keeps raw migration ownership separate from runtime selection with system owner %s",
  async (systemAgentId) => {
    await withState(async (state) => {
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: systemAgentId ? { systemAgent: { agentId: systemAgentId } } : {},
          entries: { main: {}, worker: {} },
        },
      };
      const runtime = { env: state.env, homedir: () => state.home };
      const resolution = resolveInstallAgentDir(cfg, runtime);
      const locatorConfig: OpenClawConfigWithLegacyRoster = {
        agents: { list: [{ id: "main" }, { id: "worker", default: true }] },
      };
      const migration = resolveLegacyStateMigrationOwner({
        cfg,
        locatorConfig,
        ...runtime,
      });

      expect(migration.migrationTarget).toEqual({
        dir: state.agentDir("worker"),
        owner: "worker",
      });
      expect(migration.sessionMigrationAgentId).toBe("worker");
      expect(resolution.migrationTarget).toBeUndefined();
      expect(resolution.optionalDirectory).toBeUndefined();
    });
  },
);

it.each([
  installCase("deferred main SQLite family", "main", { sqlite: true }),
  installCase("configured non-main directory", "worker"),
  installCase("non-main default", "worker", { custom: false }),
  installCase("malformed default config", "main", { malformed: true }),
  installCase("explicit tilde legacy directory in a named profile", "worker", {
    override: "tilde",
    malformed: true,
  }),
])(
  "shares the install directory between SDK and Doctor: $name (malformed: $malformed)",
  async (testCase) => {
    const { malformed } = testCase;
    await withState(
      async (state) => {
        const legacyDir = path.join(state.home, ".openclaw", "agent");
        const configuredDir = testCase.custom
          ? state.path("configured-agent")
          : state.agentDir(testCase.agentId);
        const overrideDir = testCase.override === "none" ? undefined : legacyDir;
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
        writeFile(path.join(legacyDir, "bin", binary), "legacy binary");
        writeFile(path.join(legacyDir, "settings.json"), "SDK settings");
        const legacyDatabase = path.join(legacyDir, "openclaw-agent.sqlite");
        if (testCase.sqlite) {
          openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: legacyDatabase });
          closeOpenClawAgentDatabasesForTest();
        }
        if (targetDir !== legacyDir) {
          writeFile(path.join(targetDir, "bin", binary), "current binary");
        }
        await withEnvAsync(
          {
            OPENCLAW_AGENT_DIR: testCase.override === "tilde" ? "~/.openclaw/agent" : overrideDir,
            OPENCLAW_PROFILE: testCase.override === "tilde" ? "isolated" : undefined,
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
            const options = migrationOptions(cfg, env, state.home);
            const detected = await detectLegacyStateMigrations(options);
            // Doctor's invalid-config gate is separate from its selected directory repair.
            const migration = malformed
              ? await migrateLegacyAgentDir(detected, () => 1234)
              : (
                  await autoMigrateLegacyState({
                    ...options,
                    doctorOnlyStateMigrations: true,
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
              expect(fs.existsSync(path.join(targetDir, ".legacy-agent-dir-migration.json"))).toBe(
                false,
              );
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
            await expect(ensureTool("fd")).resolves.toBe(path.join(activeDir, "bin", binary));
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
      testCase.override === "tilde" ? "split" : "home",
    );
  },
);

it.each(["before detection", "after detection"])(
  "keeps rehearsal state-root sources confined when an ancestor symlink escapes %s",
  async (timing) => {
    const fixture = await makeFixture();
    const externalParent = path.join(fixture.homeDir, ".openclaw", "agent");
    const externalBinary = path.join(externalParent, "bin/fd");
    writeFile(externalBinary, "uncopied SDK binary");
    const copiedParent = path.join(fixture.stateDir, "agent");
    const symlinkKind = process.platform === "win32" ? "junction" : "dir";
    if (timing === "before detection") {
      fs.symlinkSync(externalParent, copiedParent, symlinkKind);
    } else {
      writeFile(path.join(copiedParent, "bin/fd"), "copied SDK binary");
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
    const detected = await detectLegacyStateMigrations(
      migrationOptions(
        { agents: { entries: { main: {} } }, plugins: { enabled: false } },
        env,
        fixture.stateDir,
      ),
    );
    if (timing === "after detection") {
      fs.renameSync(copiedParent, path.join(fixture.stateDir, "saved-sdk-home"));
      fs.symlinkSync(externalParent, copiedParent, symlinkKind);
    }

    const result = await migrateLegacyAgentDir(detected, () => 1234);

    expect(fs.existsSync(externalBinary)).toBe(true);
    expect(fs.readFileSync(externalBinary, "utf8")).toBe("uncopied SDK binary");
    expect([...detected.warnings, ...result.warnings].length).toBeGreaterThan(0);
    const canonicalDir = path.join(fixture.stateDir, "agents/main/agent");
    expect(fs.existsSync(path.join(canonicalDir, ".legacy-agent-dir-migration.json"))).toBe(false);
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
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
  const agentDatabasePath = path.join(fixture.stateDir, "agents/main/agent/openclaw-agent.sqlite");
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
  let plan: LegacyStateMigrationPlan;
  try {
    for (const database of [agentDatabase, stateDatabase]) {
      database.exec(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE);",
      );
    }
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
    const historicalSlug = `meeting-${"x".repeat(2200)}`;
    const sourceJson = JSON.stringify({ providerId: "manual-transcript", channelId: "room" });
    executeSqliteQuerySync(
      stateDatabase,
      meetingTranscriptDb(stateDatabase)
        .insertInto("meeting_transcript_sessions")
        .values({
          session_id: "wal-meeting",
          started_at: "2026-09-03T00:00:00.000Z",
          selector: `2026-09-03/${historicalSlug}`,
          export_key: `2026-09-03/${historicalSlug}`,
          session_slug: historicalSlug,
          provider_id: "manual-transcript",
          source_json: sourceJson,
          ...deriveMeetingTranscriptSessionColumns(sourceJson, null),
          created_at_ms: 1,
          updated_at_ms: 1,
        }),
    );
    expect(fs.existsSync(`${agentDatabasePath}-wal`)).toBe(true);
    expect(fs.existsSync(`${stateDatabasePath}-wal`)).toBe(true);

    plan = await fixture.plan();
  } finally {
    agentDatabase.close();
    stateDatabase.close();
  }
  const sharedAuthPlan = byId(plan.steps, "shared-auth-store");
  const meetingPlan = byId(plan.steps, "meeting-transcripts");
  expect(sharedAuthPlan).toMatchObject({
    requiredness: "conditional",
    source: [{ kind: "sqlite", path: agentDatabasePath }],
  });
  expect(meetingPlan).toMatchObject({ requiredness: "required" });
  expect(meetingPlan?.source).toContainEqual({ kind: "sqlite", path: stateDatabasePath });

  const result = await fixture.migrate(cfg);
  expect(byId(result.stepReceipts, "shared-auth-store")).toMatchObject({
    outcome: "completed",
    source: sharedAuthPlan?.source,
    requiredness: "conditional",
  });
  expect(byId(result.stepReceipts, "meeting-transcripts")).toMatchObject({
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

  const plan = await fixture.plan();

  expect(plan.steps[0]).toMatchObject({ id: "state-schema", requiredness: "required" });
  expect(byId(plan.steps, "managed-worktrees")).toMatchObject({
    source: [
      { kind: "sqlite", path: stateDatabasePath },
      { kind: "owner", id: "core:managed-worktree:legacy-after-schema" },
    ],
    requiredness: "required",
  });
});
