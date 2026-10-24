import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedLegacySessionSurfaces } from "../plugins/legacy-session-surfaces.types.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import type { LegacyStateMigrationStepReceipt } from "./state-migrations.types.js";

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/advanced")>()),
}));

async function loadFixtureGraph() {
  return {
    surfaces: await import("../plugins/legacy-session-surfaces.types.js"),
    agentDb: await import("../state/openclaw-agent-db.js"),
    contract: await import("../state/openclaw-state-db-contract.js"),
    stateDatabase: await import("../state/openclaw-state-db.js"),
    paths: await import("../state/openclaw-state-db.paths.js"),
    schema: await import("../state/openclaw-state-schema.test-support.js"),
    sqlite: await import("./sqlite-readonly-worker.js"),
    helpers: await import("./state-migrations.caller-mode.test-helpers.js"),
    doctor: await import("./state-migrations.doctor.js"),
    media: await import("./state-migrations.media-persistence.js"),
    receipts: await import("./state-migrations.receipts.js"),
    stateDir: await import("./state-migrations.state-dir.js"),
  };
}
let modules = await loadFixtureGraph();
const tempDirs = createTrackedTempDirs();

async function reloadStateDirFixtureGraph() {
  await modules.agentDb.closeOpenClawAgentDatabasesAsync();
  await modules.stateDatabase.closeOpenClawStateDatabaseAsync();
  vi.resetModules();
  modules = await loadFixtureGraph();
}

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
  return modules.helpers.createCallerModeExecutionFixture(root);
}

function detectFixture(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  cfg: OpenClawConfig = {},
  env = fixture.env,
) {
  return modules.doctor.detectLegacyStateMigrations({
    ...doctorOptions(fixture, { cfg, env }),
    mode: "doctor",
  });
}

function copyWalFixture(root: string, databasePath: string, schema: string) {
  const sourcePath = path.join(root, "wal-source.sqlite");
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; ${schema}`);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.copyFileSync(sourcePath, databasePath);
    fs.copyFileSync(`${sourcePath}-wal`, `${databasePath}-wal`);
    return source;
  } catch (error) {
    source.close();
    throw error;
  }
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

async function makeStateRootFixture(prefix: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const root = await tempDirs.make(prefix);
  const legacyStateDir = path.join(root, ".clawdbot");
  const stateDir = path.join(root, ".openclaw");
  fs.mkdirSync(legacyStateDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, ...extraEnv };
  delete env.OPENCLAW_STATE_DIR;
  delete env.OPENCLAW_HOME;
  delete env.OPENCLAW_CONFIG_PATH;
  return { root, legacyStateDir, stateDir, env };
}

function doctorOptions(
  fixture: { env: NodeJS.ProcessEnv; homeDir: string },
  overrides: Partial<Parameters<typeof modules.doctor.autoMigrateLegacyState>[0]> = {},
) {
  return {
    cfg: {},
    doctorOnlyStateMigrations: true,
    env: fixture.env,
    homedir: () => fixture.homeDir,
    legacySessionSurfaces: modules.surfaces.EMPTY_LEGACY_SESSION_SURFACES,
    ...overrides,
  };
}

function planFixture(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  return modules.doctor.planLegacyStateMigrationsReadOnly({
    mode: "doctor",
    candidate: { root: fixture.root, version: "test" },
    snapshot: modules.helpers.createCallerModeSnapshot(fixture),
    env: fixture.env,
  });
}

afterEach(async () => {
  await modules.agentDb.closeOpenClawAgentDatabasesAsync();
  await modules.stateDatabase.closeOpenClawStateDatabaseAsync();
  modules.agentDb.closeOpenClawAgentDatabasesForTest();
  modules.stateDatabase.closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

describe("legacy state migration caller execution", () => {
  it.each([
    { caller: "preflight", failure: "interruption" },
    { caller: "preflight", failure: "independent error" },
    { caller: "direct", failure: "interruption" },
    { caller: "direct", failure: "independent error" },
  ] as const)(
    "settles $caller receipts before forwarding $failure during cancellation",
    async ({ caller, failure }) => {
      const fixture = await makeFixture();
      // These receipt checks need no bundled plugins; both discovery routes use this root.
      const extensions = path.join(fixture.root, "extensions");
      fs.unlinkSync(extensions);
      fs.mkdirSync(extensions);
      fixture.env.OPENCLAW_BUNDLED_PLUGINS_DIR = extensions;
      const { execPath } = writeLegacyDoctorSources(fixture.stateDir);
      const plan = caller === "preflight" ? await planFixture(fixture) : undefined;
      const detected = caller === "direct" ? await detectFixture(fixture) : undefined;
      const controller = new AbortController();
      const interruption = new Error("Doctor interrupted by SIGINT");
      const error = failure === "interruption" ? interruption : new Error("SQLite repair failed");
      const fail = () => {
        controller.abort(interruption);
        throw error;
      };
      const owner = detected
        ? vi
            .spyOn(modules.stateDatabase, "prepareOpenClawStateDatabaseSchema")
            .mockImplementationOnce(fail)
        : vi.spyOn(modules.media, "migrateLegacyMediaPersistence").mockImplementationOnce(fail);
      const receipts: LegacyStateMigrationStepReceipt[] = [];
      const scope = modules.sqlite.createSqliteReadOnlyWorkerScope({
        signal: controller.signal,
        deadlineOwnedByCaller: false,
      });
      try {
        const options = {
          env: fixture.env,
          doctorOnlyStateMigrations: true,
          legacySessionSurfaces: modules.surfaces.EMPTY_LEGACY_SESSION_SURFACES,
          onStepReceipt: (receipt: LegacyStateMigrationStepReceipt) => receipts.push(receipt),
        };
        const operation = scope.run(() =>
          detected
            ? modules.doctor.runLegacyStateMigrations({ ...options, detected, config: {} })
            : modules.doctor.autoMigrateLegacyState({
                ...options,
                cfg: {},
                homedir: () => fixture.homeDir,
              }),
        );
        if (failure === "interruption") {
          await expect(operation).rejects.toBe(interruption);
        } else {
          await expect(operation).resolves.toMatchObject({ warnings: [error.message] });
        }
      } finally {
        await scope.close();
      }
      expect(owner).toHaveBeenCalledOnce();
      const blockerId = detected ? "state-schema" : "media-persistence";
      expect(receipts.find((receipt) => receipt.id === blockerId)).toMatchObject({
        outcome: "refused",
        refusal: { code: "step-threw", message: error.message },
      });
      if (plan) {
        modules.helpers.expectBlockedTailInPlanOrder({ plan, receipts, blockerId });
      }
      expect(receipts.find((receipt) => receipt.id === "exec-approvals")).toMatchObject({
        outcome: "refused",
        refusal: { code: "blocked-by-prior-refusal" },
      });
      expect(fs.existsSync(execPath)).toBe(true);
    },
  );

  it.each(["automatic", "doctor", "direct", "detected-directory", "detected-config"] as const)(
    "keeps schema repair Doctor-owned and preserves OAuth sidecars through %s",
    async (mode) => {
      const fixture = await makeFixture();
      delete fixture.env.OPENCLAW_OAUTH_DIR;
      const oauthDir = path.join(fixture.stateDir, "configured-oauth");
      const cfg: OpenClawConfig = { env: { vars: { OPENCLAW_OAUTH_DIR: oauthDir } } };
      fs.writeFileSync(fixture.configPath, JSON.stringify(cfg));
      const detected =
        mode === "direct" || mode === "detected-directory" || mode === "detected-config"
          ? await detectFixture(
              fixture,
              cfg,
              mode === "detected-directory"
                ? { ...fixture.env, OPENCLAW_OAUTH_DIR: oauthDir }
                : fixture.env,
            )
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
      const stateDatabasePath = modules.paths.resolveOpenClawStateSqlitePath(fixture.env);
      modules.helpers.writeLegacyStateSchemaV1(stateDatabasePath);
      const sourceBytes = fs.readFileSync(authStorePath);
      const migrate = () =>
        detected
          ? modules.doctor.runLegacyStateMigrations({
              detected,
              ...(mode === "detected-directory" || mode === "detected-config"
                ? {}
                : { config: cfg, env: fixture.env }),
              legacySessionSurfaces: modules.surfaces.EMPTY_LEGACY_SESSION_SURFACES,
            })
          : modules.doctor.autoMigrateLegacyState({
              cfg,
              env: fixture.env,
              homedir: () => fixture.homeDir,
              doctorOnlyStateMigrations: mode === "doctor",
              legacySessionSurfaces: modules.surfaces.EMPTY_LEGACY_SESSION_SURFACES,
            });
      const migration =
        mode === "automatic"
          ? migrate()
          : modules.schema.withStateMigrationBackupForTest({ env: fixture.env }, migrate);
      if (mode === "automatic") {
        await expect(migration).rejects.toThrow("startup migrations did not complete cleanly");
      } else {
        await migration;
        using database = new DatabaseSync(stateDatabasePath, { readOnly: true });
        expect(database.prepare("PRAGMA user_version").get()).toEqual({
          user_version: modules.contract.OPENCLAW_STATE_SCHEMA_VERSION,
        });
      }
      expect(fs.readFileSync(authStorePath)).toEqual(sourceBytes);
      expect(fs.readFileSync(sidecarPath, "utf8")).toBe(sidecarBytes);
    },
  );

  it("executes and receipts Doctor-owned exec and TUI migrations from the same mode", async () => {
    const fixture = await makeFixture();
    const { execPath, tuiPath } = writeLegacyDoctorAndTuiSources(fixture.stateDir, {
      terminal: { sessionKey: "agent:main:tui:execute", updatedAt: 100 },
    });
    const result = await modules.doctor.autoMigrateLegacyState(doctorOptions(fixture));
    expect(result.mode).toBe("doctor");
    for (const id of ["exec-approvals", "tui-last-session"]) {
      expect(result.stepReceipts.find((receipt) => receipt.id === id)).toMatchObject({
        outcome: "completed",
        warnings: [],
      });
    }
    expect(fs.existsSync(execPath)).toBe(false);
    expect(fs.existsSync(tuiPath)).toBe(false);
    expect(
      modules.receipts.readLegacyMigrationReceipt(
        modules.receipts.resolveLegacyMigrationSourceKey("exec-approvals-json", execPath),
        fixture.env,
      ),
    ).not.toBeNull();
  });

  it("relocates the legacy state root before running Doctor-owned migrations", async () => {
    await reloadStateDirFixtureGraph();
    const { root, legacyStateDir, stateDir, env } = await makeStateRootFixture(
      "openclaw-doctor-state-root-",
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
    );
    const { execPath } = writeLegacyDoctorSources(legacyStateDir);

    const result = await modules.doctor.autoMigrateLegacyState(
      doctorOptions({ env, homeDir: root }),
    );
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
      modules.receipts.readLegacyMigrationReceipt(
        modules.receipts.resolveLegacyMigrationSourceKey(
          "exec-approvals-json",
          path.join(stateDir, "exec-approvals.json"),
        ),
        { ...env, OPENCLAW_STATE_DIR: stateDir },
      ),
    ).not.toBeNull();
  });

  it("plans pending state-root relocation before every copied-state migration", async () => {
    const { root, legacyStateDir, stateDir, env } = await makeStateRootFixture(
      "openclaw-doctor-state-root-plan-",
    );
    const configPath = path.join(legacyStateDir, "openclaw.json");
    fs.writeFileSync(configPath, "{}\n");
    writeLegacyDoctorSources(legacyStateDir);

    const plan = await modules.doctor.planLegacyStateMigrationsReadOnly({
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
    for (const step of plan.steps.slice(1)) {
      expect([step.outcome, step.refusal?.code]).toEqual(["deferred", "blocked-by-prior-refusal"]);
    }
    expect(plan.steps.find((step) => step.id === "exec-approvals")?.source).toEqual([
      { kind: "path", path: path.join(stateDir, "exec-approvals.json") },
      { kind: "sqlite", path: path.join(stateDir, "state", "openclaw.sqlite") },
    ]);
    expect(fs.existsSync(legacyStateDir)).toBe(true);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it("refuses later migrations when the legacy state root cannot be relocated", async () => {
    await reloadStateDirFixtureGraph();
    const { root, legacyStateDir, stateDir, env } = await makeStateRootFixture(
      "openclaw-doctor-state-root-refusal-",
    );
    const databasePath = modules.paths.resolveOpenClawStateSqlitePath({
      ...env,
      OPENCLAW_STATE_DIR: legacyStateDir,
    });
    const source = copyWalFixture(
      root,
      databasePath,
      `
        CREATE TABLE state_dir_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO state_dir_probe(value) VALUES ('copied-state');
      `,
    );
    source.close();
    const databaseArtifactsBefore = snapshotSqliteArtifacts(databasePath);
    const publish = fsSafeAdvanced.retainEntryForPublication;
    vi.spyOn(fsSafeAdvanced, "retainEntryForPublication").mockImplementation((options) => {
      if (options.source.basename === ".clawdbot") {
        fs.mkdirSync(stateDir);
      }
      return publish(options);
    });
    const { execPath } = writeLegacyDoctorSources(legacyStateDir);
    const result = await modules.doctor.autoMigrateLegacyState(
      doctorOptions({ env, homeDir: root }),
    );

    expect(result.stepReceipts[0]).toMatchObject({
      id: "state-dir",
      source: [{ kind: "path", path: legacyStateDir }],
      target: [{ kind: "path", path: stateDir }],
      outcome: "refused",
      refusal: { code: "step-threw", message: expect.any(String) },
    });
    for (const receipt of result.stepReceipts.slice(1)) {
      expect([receipt.outcome, receipt.refusal?.code]).toEqual([
        "refused",
        "blocked-by-prior-refusal",
      ]);
    }
    expect(result.stepReceipts.some((receipt) => receipt.id === "exec-approvals")).toBe(true);
    expect(result.warnings.join("\n")).toContain("legacy rename");
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(fs.existsSync(execPath)).toBe(true);
    expect(snapshotSqliteArtifacts(databasePath)).toEqual(databaseArtifactsBefore);
  });

  it("reports a completed profile move when plugin preparation refuses", async () => {
    const fixture = await makeFixture();
    fixture.env.OPENCLAW_PROFILE = "work";
    const paths = modules.stateDir.resolveLegacyProfileWorkspaceMigrationPaths({
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

    const result = await modules.doctor.autoMigrateLegacyState(
      doctorOptions(fixture, { legacySessionSurfaces }),
    );

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
    modules.helpers.expectBlockedTailInPlanOrder({
      plan,
      receipts: result.stepReceipts,
      blockerId: "plugin-migration-preparation",
    });
    expect(fs.existsSync(paths.source)).toBe(false);
    expect(fs.readFileSync(path.join(paths.target, "AGENTS.md"), "utf8")).toBe("profile workspace");
  });

  it("preserves SQLite artifacts while closing the tail after a schema refusal", async () => {
    const fixture = await makeFixture();
    const databasePath = modules.paths.resolveOpenClawStateSqlitePath(fixture.env);
    const source = copyWalFixture(
      fixture.root,
      databasePath,
      `
        CREATE TABLE agent_databases (broken TEXT);
        INSERT INTO agent_databases VALUES ('legacy');
      `,
    );
    try {
      let artifactsAfterRefusal: ReturnType<typeof snapshotSqliteArtifacts> | undefined;

      const result = await modules.doctor.autoMigrateLegacyState({
        ...doctorOptions(fixture),
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

  it.each(["profile-workspace", "orphan-session-keys", "acp-session-metadata"] as const)(
    "blocks later Doctor repairs after a conditional %s refusal",
    async (blockerId) => {
      const fixture = await makeFixture();
      let cfg: OpenClawConfig = {};
      const preserved: string[] = [];
      if (blockerId === "profile-workspace") {
        fixture.env.OPENCLAW_PROFILE = "work";
        const paths = modules.stateDir.resolveLegacyProfileWorkspaceMigrationPaths({
          env: fixture.env,
          homedir: () => fixture.homeDir,
        });
        if (!paths) {
          throw new Error("named profile did not resolve migration paths");
        }
        preserved.push(paths.source, paths.target);
        for (const directory of preserved) {
          fs.mkdirSync(directory, { recursive: true });
        }
      } else {
        ({ cfg } = writeAliasedSessionStore({
          fixture,
          store:
            blockerId === "orphan-session-keys"
              ? { main: { sessionId: "legacy-main", updatedAt: 1 } }
              : {
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
        }));
      }
      const nextId = blockerId === "acp-session-metadata" ? "agent-dir" : "exec-approvals";
      if (nextId === "agent-dir") {
        const directory = path.join(fixture.stateDir, "agent");
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "settings.json"), "{}\n");
        preserved.push(directory);
      } else {
        preserved.push(writeLegacyDoctorSources(fixture.stateDir).execPath);
      }
      const plan = await planFixture(fixture);
      const result = await modules.doctor.autoMigrateLegacyState(doctorOptions(fixture, { cfg }));
      expect(result.stepReceipts.find((receipt) => receipt.id === blockerId)).toMatchObject({
        requiredness: "conditional",
        outcome: "refused",
      });
      modules.helpers.expectBlockedTailInPlanOrder({
        plan,
        receipts: result.stepReceipts,
        blockerId,
      });
      expect(result.stepReceipts.find((receipt) => receipt.id === nextId)).toMatchObject({
        outcome: "refused",
        refusal: { code: "blocked-by-prior-refusal" },
        ...(blockerId === "profile-workspace"
          ? { source: [], target: [], requiredness: "conditional" }
          : {}),
      });
      for (const file of preserved) {
        expect(fs.existsSync(file)).toBe(true);
      }
    },
  );
});
