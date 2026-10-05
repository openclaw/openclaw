import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  EMPTY_LEGACY_SESSION_SURFACES,
  type PreparedLegacySessionSurfaces,
} from "../plugins/legacy-session-surfaces.types.js";
import * as pluginSetupModule from "../plugins/plugin-setup-module.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  createCallerModeExecutionFixture,
  createCallerModeSnapshot,
  expectBlockedTailInPlanOrder,
  expectPlanReceiptDescriptorsToMatch,
  writeLegacyStateSchemaV1,
} from "./state-migrations.caller-mode.test-helpers.js";
import {
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  planLegacyStateMigrationsReadOnly,
  runLegacyStateMigrations,
} from "./state-migrations.doctor.js";
import { createLegacyDatabaseFixture } from "./state-migrations.media-persistence.test-support.js";
import {
  readLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import {
  resetAutoMigrateLegacyStateDirForTest,
  resolveLegacyProfileWorkspaceMigrationPaths,
} from "./state-migrations.state-dir.js";

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/advanced")>()),
}));

const tempDirs = createTrackedTempDirs();

function writeLegacyDoctorSources(stateDir: string): { execPath: string } {
  const execPath = path.join(stateDir, "exec-approvals.json");
  fs.writeFileSync(
    execPath,
    `${JSON.stringify({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss" },
      agents: { main: { allowlist: [{ pattern: "/usr/bin/rg" }] } },
    })}\n`,
  );
  return { execPath };
}

function writeLegacyDoctorAndTuiSources(
  stateDir: string,
  tuiValue: unknown,
): { execPath: string; tuiPath: string } {
  const { execPath } = writeLegacyDoctorSources(stateDir);
  const tuiPath = path.join(stateDir, "tui", "last-session.json");
  fs.mkdirSync(path.dirname(tuiPath), { recursive: true });
  fs.writeFileSync(tuiPath, `${JSON.stringify(tuiValue)}\n`);
  return { execPath, tuiPath };
}

function snapshotSqliteArtifacts(databasePath: string): Record<string, string | undefined> {
  return Object.fromEntries(
    ["", "-wal", "-shm"].map((suffix) => {
      const pathname = `${databasePath}${suffix}`;
      return [
        suffix || "database",
        fs.existsSync(pathname)
          ? createHash("sha256").update(fs.readFileSync(pathname)).digest("hex")
          : undefined,
      ];
    }),
  );
}

async function makeFixture() {
  const root = await tempDirs.make("openclaw-doctor-caller-execution-");
  return createCallerModeExecutionFixture(root);
}

function writeAliasedSessionStore(params: {
  fixture: Awaited<ReturnType<typeof makeFixture>>;
  store: Record<string, unknown>;
}): { cfg: OpenClawConfig; configuredStorePath: string; standardStorePath: string } {
  const standardStorePath = path.join(
    params.fixture.stateDir,
    "agents",
    "main",
    "sessions",
    "sessions.json",
  );
  const configuredStorePath = path.join(params.fixture.stateDir, "configured-sessions.json");
  fs.mkdirSync(path.dirname(standardStorePath), { recursive: true });
  fs.writeFileSync(standardStorePath, `${JSON.stringify(params.store)}\n`);
  fs.linkSync(standardStorePath, configuredStorePath);
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    session: { store: configuredStorePath },
  };
  fs.writeFileSync(params.fixture.configPath, `${JSON.stringify(cfg)}\n`);
  return { cfg, configuredStorePath, standardStorePath };
}

function planFixture(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  return planLegacyStateMigrationsReadOnly({
    mode: "doctor",
    candidate: { root: fixture.root, version: "test" },
    snapshot: createCallerModeSnapshot(fixture),
    env: fixture.env,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetAutoMigrateLegacyStateDirForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("legacy state migration caller execution", () => {
  it.each(["automatic", "doctor", "direct", "detected-directory", "detected-config"] as const)(
    "refuses retired OAuth sidecars before %s schema preparation on every attempt",
    async (mode) => {
      const fixture = await makeFixture();
      delete fixture.env.OPENCLAW_OAUTH_DIR;
      const oauthDir = path.join(fixture.stateDir, "configured-oauth");
      const cfg: OpenClawConfig = { env: { vars: { OPENCLAW_OAUTH_DIR: oauthDir } } };
      fs.writeFileSync(fixture.configPath, JSON.stringify(cfg));
      const detected =
        mode === "direct" || mode === "detected-directory" || mode === "detected-config"
          ? await detectLegacyStateMigrations({
              cfg,
              mode: "doctor",
              env:
                mode === "detected-directory"
                  ? { ...fixture.env, OPENCLAW_OAUTH_DIR: oauthDir }
                  : fixture.env,
              homedir: () => fixture.homeDir,
              doctorOnlyStateMigrations: true,
              legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
            })
          : undefined;
      const sidecarPath = path.join(oauthDir, "auth-profiles", `${"b".repeat(32)}.json`);
      const sidecarBytes = "retired encrypted bytes\n";
      fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
      fs.writeFileSync(sidecarPath, sidecarBytes);
      const authStorePath = path.join(fixture.stateDir, "agents/main/agent/auth-profiles.json");
      fs.mkdirSync(path.dirname(authStorePath), { recursive: true });
      fs.writeFileSync(
        authStorePath,
        JSON.stringify({
          profiles: {
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              oauthRef: {
                source: "openclaw-credentials",
                provider: "openai-codex",
                id: "b".repeat(32),
              },
            },
          },
        }),
      );
      const stateDatabasePath = resolveOpenClawStateSqlitePath(fixture.env);
      writeLegacyStateSchemaV1(stateDatabasePath);
      const before = snapshotSqliteArtifacts(stateDatabasePath);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const migration = detected
          ? runLegacyStateMigrations({
              detected,
              ...(mode === "detected-directory" || mode === "detected-config"
                ? {}
                : { config: cfg, env: fixture.env }),
              doctorOnlyStateMigrations: true,
              legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
            })
          : autoMigrateLegacyState({
              cfg,
              env: fixture.env,
              homedir: () => fixture.homeDir,
              doctorOnlyStateMigrations: mode === "doctor",
              legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
            });
        await expect(migration).rejects.toThrow("Upgrade through OpenClaw 2026.9.7");
        expect(snapshotSqliteArtifacts(stateDatabasePath)).toEqual(before);
        expect(fs.readFileSync(sidecarPath, "utf8")).toBe(sidecarBytes);
      }
    },
  );

  it("executes and receipts Doctor-owned exec and TUI migrations from the same mode", async () => {
    const fixture = await makeFixture();
    const cfg = {
      meta: { lastTouchedAt: "2026-09-02T00:00:00.000Z" },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    const { execPath, tuiPath } = writeLegacyDoctorAndTuiSources(fixture.stateDir, {
      terminal: { sessionKey: "agent:main:tui:execute", updatedAt: 100 },
    });
    const deviceAuthPath = path.join(fixture.stateDir, "identity", "device-auth.json");
    fs.mkdirSync(path.dirname(deviceAuthPath), { recursive: true });
    fs.writeFileSync(
      deviceAuthPath,
      `${JSON.stringify({
        version: 1,
        deviceId: "candidate-device",
        tokens: {
          operator: {
            token: "candidate-token",
            role: "operator",
            scopes: ["operator.read"],
            updatedAtMs: 10,
          },
        },
      })}\n`,
    );
    const stateDatabasePath = resolveOpenClawStateSqlitePath(fixture.env);
    writeLegacyStateSchemaV1(stateDatabasePath);
    const plan = await planFixture(fixture);

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(result.mode).toBe("doctor");
    expect(result.warnings).toEqual([]);
    const executedPlan = {
      ...plan,
      steps: plan.steps.filter((step) => step.id !== "plugin-doctor-post-session-state"),
    };
    expectPlanReceiptDescriptorsToMatch({ plan: executedPlan, receipts: result.stepReceipts });
    expect(plan.steps.findIndex((step) => step.id === "device-auth")).toBeLessThan(
      plan.steps.findIndex((step) => step.id === "tui-last-session"),
    );
    expect(plan.steps[0]).toMatchObject({
      id: "state-schema",
      phase: "shared",
      source: [{ kind: "sqlite", path: stateDatabasePath }],
      target: [{ kind: "sqlite", path: stateDatabasePath }],
      requiredness: "required",
      reversibility: "checkpoint-required",
      outcome: "planned",
    });
    expect(result.stepReceipts[0]).toMatchObject({
      id: "state-schema",
      source: [{ kind: "sqlite", path: stateDatabasePath }],
      target: [{ kind: "sqlite", path: stateDatabasePath }],
      outcome: "completed",
      warnings: [],
    });
    expect(plan.steps.find((step) => step.id === "config-machine-state")).toMatchObject({
      source: [{ kind: "path", path: fixture.configPath }],
      target: [{ kind: "sqlite", path: stateDatabasePath }],
      requiredness: "conditional",
      outcome: "planned",
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "config-machine-state"),
    ).toMatchObject({
      source: [{ kind: "path", path: fixture.configPath }],
      target: [{ kind: "sqlite", path: stateDatabasePath }],
      outcome: "completed",
      warnings: [],
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "device-auth")).toMatchObject({
      source: [{ kind: "path", path: deviceAuthPath }],
      outcome: "completed",
      warnings: [],
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "exec-approvals")).toMatchObject({
      source: [
        { kind: "path", path: execPath },
        { kind: "sqlite", path: stateDatabasePath },
      ],
      outcome: "completed",
      warnings: [],
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "tui-last-session")).toMatchObject({
      source: [{ kind: "path", path: tuiPath }],
      outcome: "completed",
      warnings: [],
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "legacy-main-session-keys"),
    ).toBeUndefined();
    expect(fs.existsSync(execPath)).toBe(false);
    expect(fs.existsSync(tuiPath)).toBe(false);
    expect(
      readLegacyMigrationReceipt(
        resolveLegacyMigrationSourceKey("exec-approvals-json", execPath),
        fixture.env,
      ),
    ).not.toBeNull();
  });

  it("relocates the legacy state root before running Doctor-owned migrations", async () => {
    const root = await tempDirs.make("openclaw-doctor-state-root-");
    const legacyStateDir = path.join(root, ".clawdbot");
    const stateDir = path.join(root, ".openclaw");
    fs.mkdirSync(legacyStateDir, { recursive: true });
    const { execPath } = writeLegacyDoctorSources(legacyStateDir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    };
    delete env.OPENCLAW_STATE_DIR;
    delete env.OPENCLAW_HOME;
    delete env.OPENCLAW_CONFIG_PATH;

    const result = await autoMigrateLegacyState({
      cfg: {},
      doctorOnlyStateMigrations: true,
      env,
      homedir: () => root,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(result.stepReceipts[0]).toMatchObject({
      id: "state-dir",
      source: [{ kind: "path", path: legacyStateDir }],
      target: [{ kind: "path", path: stateDir }],
      outcome: "completed",
    });
    expect(fs.existsSync(legacyStateDir)).toBe(false);
    expect(fs.existsSync(execPath)).toBe(false);
    expect(result.stepReceipts.find((receipt) => receipt.id === "exec-approvals")).toMatchObject({
      source: [
        { kind: "path", path: path.join(stateDir, "exec-approvals.json") },
        { kind: "sqlite", path: path.join(stateDir, "state", "openclaw.sqlite") },
      ],
      outcome: "completed",
    });
    expect(
      readLegacyMigrationReceipt(
        resolveLegacyMigrationSourceKey(
          "exec-approvals-json",
          path.join(stateDir, "exec-approvals.json"),
        ),
        { ...env, OPENCLAW_STATE_DIR: stateDir },
      ),
    ).not.toBeNull();
  });

  it("plans pending state-root relocation before every copied-state migration", async () => {
    const root = await tempDirs.make("openclaw-doctor-state-root-plan-");
    const legacyStateDir = path.join(root, ".clawdbot");
    const stateDir = path.join(root, ".openclaw");
    const configPath = path.join(legacyStateDir, "openclaw.json");
    fs.mkdirSync(legacyStateDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n");
    writeLegacyDoctorSources(legacyStateDir);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root };
    delete env.OPENCLAW_STATE_DIR;
    delete env.OPENCLAW_HOME;
    delete env.OPENCLAW_CONFIG_PATH;

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: { root, version: "test" },
      snapshot: { homeDir: root, configPath, stateDir: legacyStateDir },
      env,
    });

    expect(plan.steps[0]).toMatchObject({
      id: "state-dir",
      source: [{ kind: "path", path: legacyStateDir }],
      target: [{ kind: "path", path: stateDir }],
      outcome: "deferred",
      refusal: { code: "state-dir-planning-deferred" },
    });
    expect(
      plan.steps.slice(1).map((step) => ({ outcome: step.outcome, code: step.refusal?.code })),
    ).toEqual(
      plan.steps.slice(1).map(() => ({
        outcome: "deferred",
        code: "blocked-by-prior-refusal",
      })),
    );
    expect(plan.steps.find((step) => step.id === "exec-approvals")?.source).toEqual([
      { kind: "path", path: path.join(stateDir, "exec-approvals.json") },
      { kind: "sqlite", path: path.join(stateDir, "state", "openclaw.sqlite") },
    ]);
    expect(fs.existsSync(legacyStateDir)).toBe(true);
    expect(fs.existsSync(stateDir)).toBe(false);

    for (const selector of [
      { OPENCLAW_STATE_DIR: legacyStateDir },
      { OPENCLAW_HOME: root },
      { OPENCLAW_CONFIG_PATH: configPath },
    ]) {
      const explicitPlan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: { root, version: "test" },
        snapshot: { homeDir: root, configPath, stateDir: legacyStateDir },
        env: { ...env, ...selector },
      });
      expect(explicitPlan.steps[0]?.id).toBe("state-schema");
    }
  });

  it("refuses later migrations when the legacy state root cannot be relocated", async () => {
    const root = await tempDirs.make("openclaw-doctor-state-root-refusal-");
    const legacyStateDir = path.join(root, ".clawdbot");
    const stateDir = path.join(root, ".openclaw");
    fs.mkdirSync(legacyStateDir, { recursive: true });

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root };
    delete env.OPENCLAW_STATE_DIR;
    delete env.OPENCLAW_HOME;
    delete env.OPENCLAW_CONFIG_PATH;
    const sourcePath = path.join(root, "wal-source.sqlite");
    const source = new DatabaseSync(sourcePath);
    const databasePath = resolveOpenClawStateSqlitePath({
      ...env,
      OPENCLAW_STATE_DIR: legacyStateDir,
    });
    try {
      source.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE state_dir_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO state_dir_probe(value) VALUES ('copied-state');
      `);
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.copyFileSync(sourcePath, databasePath);
      fs.copyFileSync(`${sourcePath}-wal`, `${databasePath}-wal`);
    } finally {
      source.close();
    }
    const databaseArtifactsBefore = snapshotSqliteArtifacts(databasePath);
    const publish = fsSafeAdvanced.retainEntryForPublication;
    vi.spyOn(fsSafeAdvanced, "retainEntryForPublication").mockImplementation((options) => {
      if (options.source.basename === ".clawdbot") {
        fs.mkdirSync(stateDir);
      }
      return publish(options);
    });
    const { execPath } = writeLegacyDoctorSources(legacyStateDir);
    // Preserve the native method so the spy can inspect each opened database before delegating.
    // oxlint-disable-next-line typescript/unbound-method
    const originalPrepare = DatabaseSync.prototype.prepare;
    const postRefusalQueries: string[] = [];
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      const databases = originalPrepare.call(this, "PRAGMA database_list").all() as Array<{
        file?: unknown;
      }>;
      if (
        databases.some(
          (entry) => typeof entry.file === "string" && path.resolve(entry.file) === databasePath,
        )
      ) {
        postRefusalQueries.push(sql);
      }
      return originalPrepare.call(this, sql);
    });

    const result = await autoMigrateLegacyState({
      cfg: {},
      doctorOnlyStateMigrations: true,
      env,
      homedir: () => root,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(result.stepReceipts[0]).toMatchObject({
      id: "state-dir",
      source: [{ kind: "path", path: legacyStateDir }],
      target: [{ kind: "path", path: stateDir }],
      outcome: "refused",
      refusal: { code: "step-threw", message: expect.any(String) },
    });
    expect(result.stepReceipts.slice(1)).toEqual(
      result.stepReceipts.slice(1).map((receipt) =>
        expect.objectContaining({
          id: receipt.id,
          outcome: "refused",
          refusal: expect.objectContaining({ code: "blocked-by-prior-refusal" }),
        }),
      ),
    );
    expect(result.stepReceipts.some((receipt) => receipt.id === "exec-approvals")).toBe(true);
    expect(result.warnings.join("\n")).toContain("legacy rename");
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(fs.existsSync(execPath)).toBe(true);
    expect(postRefusalQueries).toEqual([]);
    expect(snapshotSqliteArtifacts(databasePath)).toEqual(databaseArtifactsBefore);
  });

  it("receipts a blocking conditional media warning before its ordered tail", async () => {
    const fixture = await makeFixture();
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          heartbeat: { agentId: "healthy" },
          systemAgent: { agentId: "healthy" },
        },
        entries: { healthy: {}, broken: {} },
      },
      talk: { agentId: "healthy" },
    };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    createLegacyDatabaseFixture({
      agentId: "healthy",
      env: fixture.env,
      eventsBySession: {},
    });
    const brokenDatabasePath = path.join(
      fixture.stateDir,
      "agents",
      "broken",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(brokenDatabasePath), { recursive: true });
    fs.writeFileSync(brokenDatabasePath, "not sqlite");
    const { execPath } = writeLegacyDoctorSources(fixture.stateDir);
    const plan = await planFixture(fixture);

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(result.stepReceipts.find((receipt) => receipt.id === "media-persistence")).toMatchObject(
      {
        requiredness: "conditional",
        outcome: "refused",
        changes: [expect.stringContaining("Upgraded agent database schema")],
        warnings: [expect.stringContaining(brokenDatabasePath)],
        refusal: { code: "step-refused" },
      },
    );
    expectBlockedTailInPlanOrder({
      plan,
      receipts: result.stepReceipts,
      blockerId: "media-persistence",
    });
    expect(fs.existsSync(execPath)).toBe(true);
  });

  it("reports a completed profile move when plugin preparation refuses", async () => {
    const fixture = await makeFixture();
    fixture.env.OPENCLAW_PROFILE = "work";
    const paths = resolveLegacyProfileWorkspaceMigrationPaths({
      env: fixture.env,
      homedir: () => fixture.homeDir,
    });
    if (!paths) {
      throw new Error("named profile did not resolve migration paths");
    }
    fs.mkdirSync(paths.source, { recursive: true });
    fs.writeFileSync(path.join(paths.source, "AGENTS.md"), "profile workspace");
    const plan = await planFixture(fixture);
    const legacySessionSurfaces: PreparedLegacySessionSurfaces = Object.defineProperty(
      { surfaces: [], failures: [] },
      "failures",
      {
        get() {
          throw new Error("synthetic plugin preparation failure");
        },
      },
    );

    const result = await autoMigrateLegacyState({
      cfg: {},
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces,
    });

    const profileChange = `Profile workspace: ${paths.source} → ${paths.target}`;
    expect(result.migrated).toBe(true);
    expect(result.changes).toContain(profileChange);
    expect(result.stepReceipts.find((receipt) => receipt.id === "profile-workspace")).toMatchObject(
      {
        outcome: "completed",
        changes: [profileChange],
      },
    );
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "plugin-migration-preparation"),
    ).toMatchObject({
      id: "plugin-migration-preparation",
      outcome: "refused",
      refusal: { code: "step-threw" },
    });
    expectBlockedTailInPlanOrder({
      plan,
      receipts: result.stepReceipts,
      blockerId: "plugin-migration-preparation",
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "agent-dir")).toMatchObject({
      outcome: "refused",
      refusal: { code: "blocked-by-prior-refusal" },
    });
    expect(fs.existsSync(paths.source)).toBe(false);
    expect(fs.readFileSync(path.join(paths.target, "AGENTS.md"), "utf8")).toBe("profile workspace");
  });

  it("receipts the full plan when state-schema refuses before other preludes", async () => {
    const fixture = await makeFixture();
    const config: OpenClawConfig = {
      plugins: { entries: { "candidate-plugin": { enabled: true } } },
    };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(config)}\n`);
    const { execPath } = writeLegacyDoctorSources(fixture.stateDir);
    const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE audit_events (broken TEXT);");
    database.close();
    const plan = await planFixture(fixture);
    const pluginLoader = vi
      .spyOn(pluginSetupModule, "getPluginSetupModuleLoader")
      .mockImplementation(() => {
        throw new Error("blocked-plan closure must not load plugins");
      });

    const result = await autoMigrateLegacyState({
      cfg: config,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expectBlockedTailInPlanOrder({
      plan,
      receipts: result.stepReceipts,
      blockerId: "state-schema",
    });
    expect(result.stepReceipts[0]).toMatchObject({ id: "state-schema", outcome: "refused" });
    expect(result.stepReceipts.find((receipt) => receipt.id === "exec-approvals")).toMatchObject({
      outcome: "refused",
      refusal: { code: "blocked-by-prior-refusal" },
    });
    expect(pluginLoader).not.toHaveBeenCalled();
    expect(fs.existsSync(execPath)).toBe(true);
  });

  it("preserves SQLite artifacts while closing the tail after a schema refusal", async () => {
    const fixture = await makeFixture();
    const sourcePath = path.join(fixture.root, "wal-source.sqlite");
    const source = new DatabaseSync(sourcePath);
    try {
      source.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE agent_databases (broken TEXT);
        INSERT INTO agent_databases VALUES ('legacy');
      `);
      const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.copyFileSync(sourcePath, databasePath);
      fs.copyFileSync(`${sourcePath}-wal`, `${databasePath}-wal`);
      let artifactsAfterRefusal: ReturnType<typeof snapshotSqliteArtifacts> | undefined;

      const result = await autoMigrateLegacyState({
        cfg: {},
        doctorOnlyStateMigrations: true,
        env: fixture.env,
        homedir: () => fixture.homeDir,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        onStepReceipt: (receipt) => {
          if (receipt.id === "state-schema" && receipt.outcome === "refused") {
            artifactsAfterRefusal = snapshotSqliteArtifacts(databasePath);
          }
        },
      });

      expect(artifactsAfterRefusal).toBeDefined();
      expect(snapshotSqliteArtifacts(databasePath)).toEqual(artifactsAfterRefusal);
      expect(result.stepReceipts.at(-1)).toMatchObject({
        outcome: "refused",
        refusal: { code: "blocked-by-prior-refusal" },
      });
    } finally {
      source.close();
    }
  });

  it("blocks later Doctor repairs after a conditional profile refusal", async () => {
    const fixture = await makeFixture();
    fixture.env.OPENCLAW_PROFILE = "work";
    const paths = resolveLegacyProfileWorkspaceMigrationPaths({
      env: fixture.env,
      homedir: () => fixture.homeDir,
    });
    if (!paths) {
      throw new Error("named profile did not resolve migration paths");
    }
    fs.mkdirSync(paths.source, { recursive: true });
    fs.mkdirSync(paths.target, { recursive: true });
    const { execPath } = writeLegacyDoctorSources(fixture.stateDir);
    const plan = await planFixture(fixture);

    const result = await autoMigrateLegacyState({
      cfg: {},
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(result.stepReceipts.find((receipt) => receipt.id === "profile-workspace")).toMatchObject(
      {
        requiredness: "conditional",
        outcome: "refused",
      },
    );
    expectBlockedTailInPlanOrder({
      plan,
      receipts: result.stepReceipts,
      blockerId: "profile-workspace",
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "exec-approvals")).toMatchObject({
      source: [],
      target: [],
      requiredness: "conditional",
      outcome: "refused",
      refusal: { code: "blocked-by-prior-refusal" },
    });
    expect(fs.existsSync(execPath)).toBe(true);
    expect(fs.existsSync(paths.source)).toBe(true);
    expect(fs.existsSync(paths.target)).toBe(true);
  });

  it("blocks later Doctor repairs after a conditional orphan-session refusal", async () => {
    const fixture = await makeFixture();
    const { cfg } = writeAliasedSessionStore({
      fixture,
      store: { main: { sessionId: "legacy-main", updatedAt: 1 } },
    });
    const { execPath } = writeLegacyDoctorSources(fixture.stateDir);
    const plan = await planFixture(fixture);

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(
      result.stepReceipts.find((receipt) => receipt.id === "orphan-session-keys"),
    ).toMatchObject({
      requiredness: "conditional",
      outcome: "refused",
    });
    expectBlockedTailInPlanOrder({
      plan,
      receipts: result.stepReceipts,
      blockerId: "orphan-session-keys",
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "exec-approvals")).toMatchObject({
      outcome: "refused",
      refusal: { code: "blocked-by-prior-refusal" },
    });
    expect(fs.existsSync(execPath)).toBe(true);
  });

  it("blocks later Doctor repairs after a conditional ACP metadata refusal", async () => {
    const fixture = await makeFixture();
    const { cfg } = writeAliasedSessionStore({
      fixture,
      store: {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: 1,
          acp: {
            backend: "test",
            agent: "main",
            runtimeSessionName: "legacy-runtime",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 1,
          },
        },
      },
    });
    const legacyAgentDir = path.join(fixture.stateDir, "agent");
    fs.mkdirSync(legacyAgentDir, { recursive: true });
    fs.writeFileSync(path.join(legacyAgentDir, "settings.json"), "{}\n");
    const plan = await planFixture(fixture);

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(
      result.stepReceipts.find((receipt) => receipt.id === "acp-session-metadata"),
    ).toMatchObject({ requiredness: "conditional", outcome: "refused" });
    expectBlockedTailInPlanOrder({
      plan,
      receipts: result.stepReceipts,
      blockerId: "acp-session-metadata",
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "agent-dir")).toMatchObject({
      outcome: "refused",
      refusal: { code: "blocked-by-prior-refusal" },
    });
    expect(fs.existsSync(legacyAgentDir)).toBe(true);
  });

  it("halts direct Doctor execution after an unanticipated state-schema refusal", async () => {
    const fixture = await makeFixture();
    const configHealthPath = path.join(fixture.stateDir, "logs", "config-health.json");
    const sourceBytes = `${JSON.stringify({
      entries: {
        [path.join(fixture.stateDir, "openclaw.json")]: {
          lastObservedSuspiciousSignature: "leave-me",
        },
      },
    })}\n`;
    fs.mkdirSync(path.dirname(configHealthPath), { recursive: true });
    fs.writeFileSync(configHealthPath, sourceBytes);
    const detected = await detectLegacyStateMigrations({
      cfg: {},
      mode: "doctor",
      env: fixture.env,
      homedir: () => fixture.homeDir,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(detected.stateSchema.hasLegacy).toBe(false);
    const stateDatabasePath = resolveOpenClawStateSqlitePath(fixture.env);
    fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
    const database = new DatabaseSync(stateDatabasePath);
    try {
      database.exec("PRAGMA user_version = 999;");
    } finally {
      database.close();
    }

    const result = await runLegacyStateMigrations({
      detected,
      config: {},
      env: fixture.env,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(result.stepReceipts[0]?.id).toBe("state-schema");
    expect(result.stepReceipts[0]).toMatchObject({ outcome: "refused" });
    expect(result.stepReceipts.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config-health",
          outcome: "refused",
          refusal: expect.objectContaining({ code: "blocked-by-prior-refusal" }),
        }),
      ]),
    );
    expect(result.warnings.join("\n")).toContain("uses newer schema version 999");
    expect(fs.readFileSync(configHealthPath, "utf8")).toBe(sourceBytes);
  });
});
