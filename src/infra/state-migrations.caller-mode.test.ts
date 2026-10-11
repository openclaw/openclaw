import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import * as pluginSetupModule from "../plugins/plugin-setup-module.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  createCallerModeSnapshot,
  expectBlockedTailInPlanOrder,
  snapshotFiles,
} from "./state-migrations.caller-mode.test-helpers.js";
import {
  autoMigrateLegacyState,
  planLegacyStateMigrationsReadOnly,
} from "./state-migrations.doctor.js";
import type { LegacyStateMigrationPlan } from "./state-migrations.types.js";

const tempDirs = createTrackedTempDirs();

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function candidateAt(
  root: string,
  version = "test",
): Pick<LegacyStateMigrationPlan["candidate"], "root" | "version"> {
  return { root, version };
}

function linkBundledCandidateRoot(candidateRoot: string): void {
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.symlinkSync(
    path.resolve("extensions"),
    path.join(candidateRoot, "extensions"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

function writeCandidateMigrationManifest(params: {
  candidateRoot: string;
  pluginId: string;
  migrationId: string;
}): void {
  const pluginRoot = path.join(params.candidateRoot, "extensions", params.pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    `${JSON.stringify({
      name: `@openclaw/${params.pluginId}`,
      version: "0.0.0-test",
      openclaw: { extensions: ["./index.js"] },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: params.pluginId,
      configSchema: {},
      doctorContract: { stateMigrations: [{ id: params.migrationId }] },
    })}\n`,
  );
  fs.writeFileSync(path.join(pluginRoot, "index.js"), "export default {};\n");
}

function writeAgentScopedLegacySources(stateDir: string): {
  legacyAgentDir: string;
  legacySessionStorePath: string;
} {
  const legacyAgentDir = path.join(stateDir, "agent");
  const legacySessionStorePath = path.join(stateDir, "sessions", "sessions.json");
  fs.mkdirSync(legacyAgentDir, { recursive: true });
  fs.mkdirSync(path.dirname(legacySessionStorePath), { recursive: true });
  fs.writeFileSync(path.join(legacyAgentDir, "settings.json"), "{}\n");
  fs.writeFileSync(
    legacySessionStorePath,
    `${JSON.stringify({ main: { sessionId: "legacy-main", updatedAt: 1 } })}\n`,
  );
  return { legacyAgentDir, legacySessionStorePath };
}

async function makeFixture() {
  const root = await tempDirs.make("openclaw-doctor-caller-mode-");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "copied-state");
  const configPath = path.join(root, "copied-openclaw.json");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  linkBundledCandidateRoot(root);
  linkBundledCandidateRoot(path.join(root, "candidate"));
  const cfg: OpenClawConfig = {
    plugins: { entries: { "candidate-plugin": { enabled: true } } },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(cfg)}\n`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  };
  return { root, homeDir, stateDir, configPath, env };
}

function planFixture(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  return planLegacyStateMigrationsReadOnly({
    mode: "doctor",
    candidate: candidateAt(fixture.root),
    snapshot: createCallerModeSnapshot(fixture),
    env: fixture.env,
  });
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

describe("legacy state migration caller mode", () => {
  it("derives bundled migration authority from the supplied candidate root", async () => {
    const fixture = await makeFixture();
    const candidateRoot = path.join(fixture.root, "isolated-candidate");
    writeCandidateMigrationManifest({
      candidateRoot,
      pluginId: "candidate-only",
      migrationId: "candidate-state",
    });

    const before = snapshotFiles(fixture.root);
    const pluginLoader = vi
      .spyOn(pluginSetupModule, "getPluginSetupModuleLoader")
      .mockImplementation(() => {
        throw new Error("copied planning must not load plugins");
      });
    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(candidateRoot),
      snapshot: createCallerModeSnapshot(fixture),
      env: fixture.env,
    });

    const pluginStep = plan.steps.find((step) => step.id === "plugin-doctor-state");
    expect(pluginStep).toMatchObject({
      source: expect.arrayContaining([
        { kind: "owner", id: "plugin:candidate-only:candidate-state" },
      ]),
      target: expect.arrayContaining([{ kind: "owner", id: "plugin:candidate-only:doctor-state" }]),
    });
    expect(pluginStep?.source).not.toContainEqual(
      expect.objectContaining({ id: expect.stringContaining("plugin:matrix:") }),
    );
    expect(pluginLoader).not.toHaveBeenCalled();
    expect(snapshotFiles(fixture.root)).toEqual(before);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(fixture.env))).toBe(false);
  });

  it("binds an ordinary -shm file when its unsuffixed sibling is a directory", async () => {
    const fixture = await makeFixture();
    const ordinarySharedMemoryPath = path.join(fixture.stateDir, "cache-shm");
    fs.mkdirSync(path.join(fixture.stateDir, "cache"));
    fs.writeFileSync(ordinarySharedMemoryPath, "ordinary snapshot content\n");

    const first = await planFixture(fixture);
    expect(first.warnings).toEqual([]);
    expect(first.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    fs.writeFileSync(ordinarySharedMemoryPath, "changed ordinary snapshot content\n");
    const second = await planFixture(fixture);
    expect(second.snapshot.stateDigest).not.toBe(first.snapshot.stateDigest);
  });

  it("binds plan targets and identity to every resolved copied config input", async () => {
    const fixture = await makeFixture();
    const intermediatePath = path.join(fixture.root, "planner-base.json");
    const includePath = path.join(fixture.root, "planner-agents.json");
    const configFor = (agentId: string): OpenClawConfig => ({
      agents: { ownership: "explicit", entries: { [agentId]: {} } },
    });
    fs.writeFileSync(fixture.configPath, '{"$include":"./planner-base.json"}\n');
    fs.writeFileSync(intermediatePath, '{"$include":"./planner-agents.json"}\n');
    fs.writeFileSync(includePath, `${JSON.stringify(configFor("atlas"))}\n`);

    const first = await planFixture(fixture);
    expect(first.warnings).toEqual([]);
    const firstAgentStep = first.steps.find((step) => step.id === "acp-session-metadata");
    const configIncludedPaths = [
      ...new Set([
        includePath,
        intermediatePath,
        fs.realpathSync(includePath),
        fs.realpathSync(intermediatePath),
      ]),
    ].toSorted();
    const configSources = [fixture.configPath, ...configIncludedPaths].map((inputPath) => ({
      kind: "path" as const,
      path: inputPath,
    }));
    for (const stepId of [
      "config-machine-state",
      "agent-migration-targets",
      "plugin-migration-preparation",
      "orphan-session-keys",
      "migration-detection",
    ]) {
      expect
        .soft(first.steps.find((step) => step.id === stepId)?.source)
        .toEqual(expect.arrayContaining(configSources));
    }
    expect.soft(firstAgentStep?.target).toEqual([
      {
        kind: "path",
        path: path.join(fixture.stateDir, "agents", "atlas", "sessions", "sessions.json"),
      },
      { kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) },
    ]);
    const firstConfigDigest = first.snapshot.configDigest;
    if (!firstConfigDigest) {
      throw new Error("expected the copied config inputs to have a bound digest");
    }

    fs.writeFileSync(includePath, `${JSON.stringify(configFor("beacon"))}\n`);
    const stale = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        configDigest: firstConfigDigest,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });
    expect.soft(stale).toMatchObject({
      outcome: "refused",
      refusal: { code: "snapshot-identity-mismatch" },
      steps: [],
    });

    const second = await planFixture(fixture);
    const secondAgentStep = second.steps.find((step) => step.id === "acp-session-metadata");
    expect.soft(second.snapshot.configDigest).not.toBe(firstConfigDigest);
    expect.soft(secondAgentStep?.target).toEqual([
      {
        kind: "path",
        path: path.join(fixture.stateDir, "agents", "beacon", "sessions", "sessions.json"),
      },
      { kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) },
    ]);

    const execution = await autoMigrateLegacyState({
      cfg: configFor("beacon"),
      configIncludedPaths,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    for (const stepId of [
      "config-machine-state",
      "agent-migration-targets",
      "plugin-migration-preparation",
      "orphan-session-keys",
      "migration-detection",
    ]) {
      expect
        .soft(execution.stepReceipts.find((receipt) => receipt.id === stepId)?.source)
        .toEqual(second.steps.find((step) => step.id === stepId)?.source);
    }
  });

  it.each(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const)(
    "excludes copied %s agent inputs without overriding live shared-auth authority",
    async (overrideKey) => {
      const fixture = await makeFixture();
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
      openOpenClawStateDatabase({ env: fixture.env });
      const sources = writeAgentScopedLegacySources(fixture.stateDir);
      const externalAgentDir = path.join(fixture.root, `custom-${overrideKey.toLowerCase()}`);
      const externalDatabasePath = path.join(externalAgentDir, "openclaw-agent.sqlite");
      fs.mkdirSync(externalAgentDir, { recursive: true });
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.writeFileSync(`${externalDatabasePath}${suffix}`, `external${suffix}\n`);
      }
      const env: NodeJS.ProcessEnv = {
        ...fixture.env,
        OPENCLAW_AGENT_DIR: undefined,
        PI_CODING_AGENT_DIR: undefined,
        [overrideKey]: externalAgentDir,
      };
      const plan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: createCallerModeSnapshot(fixture),
        env,
      });
      for (const suffix of ["", "-wal", "-shm"]) {
        expect(fs.readFileSync(`${externalDatabasePath}${suffix}`, "utf8")).toBe(
          `external${suffix}\n`,
        );
        fs.writeFileSync(`${externalDatabasePath}${suffix}`, `changed${suffix}\n`);
      }
      const repeatedPlan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: createCallerModeSnapshot(fixture),
        env,
      });

      for (const suffix of ["", "-wal", "-shm"]) {
        expect(fs.readFileSync(`${externalDatabasePath}${suffix}`, "utf8")).toBe(
          `changed${suffix}\n`,
        );
      }
      const externalAfterPlanning = snapshotFiles(externalAgentDir);
      let firstLiveRefusal: { id: string; files: Record<string, string> } | undefined;

      const result = await autoMigrateLegacyState({
        cfg,
        doctorOnlyStateMigrations: true,
        env,
        homedir: () => fixture.homeDir,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        onStepReceipt: (receipt) => {
          if (receipt.outcome === "refused" && firstLiveRefusal === undefined) {
            firstLiveRefusal = { id: receipt.id, files: snapshotFiles(externalAgentDir) };
          }
        },
      });

      if (overrideKey === "OPENCLAW_AGENT_DIR") {
        // This key also selects the shipped live shared-auth source. Its malformed
        // database refuses live discovery; the copied plan never authorized it.
        expect(
          result.stepReceipts.find((receipt) => receipt.id === "migration-detection"),
        ).toMatchObject({
          outcome: "refused",
          requiredness: "required",
          refusal: { code: "step-threw" },
          warnings: [expect.stringContaining(externalDatabasePath)],
        });
        expectBlockedTailInPlanOrder({
          plan,
          receipts: result.stepReceipts,
          blockerId: "migration-detection",
        });
        expect(result.postSessionPluginMigration).toBeUndefined();
        expect(result.skipped).toBe(false);
        expect(firstLiveRefusal?.id).toBe("migration-detection");
        expect(snapshotFiles(externalAgentDir)).toEqual(firstLiveRefusal?.files);
      } else {
        expect(result.postSessionPluginMigration?.step.id).toBe("plugin-doctor-post-session-state");
        expect([
          ...result.stepReceipts.map((receipt) => receipt.id),
          result.postSessionPluginMigration?.step.id,
        ]).toEqual(plan.steps.map((step) => step.id));
        expect(result.skipped).toBe(true);
        expect(firstLiveRefusal).toBeUndefined();
        expect(snapshotFiles(externalAgentDir)).toEqual(externalAfterPlanning);
      }
      expect(repeatedPlan.snapshot.stateDigest).toBe(plan.snapshot.stateDigest);
      expect(repeatedPlan.planDigest).toBe(plan.planDigest);
      for (const stepId of ["media-persistence", "transcript-directives", "shared-auth-store"]) {
        const plannedSource = plan.steps.find((step) => step.id === stepId)?.source;
        if (overrideKey === "PI_CODING_AGENT_DIR") {
          expect(plannedSource).toEqual(
            result.stepReceipts.find((receipt) => receipt.id === stepId)?.source,
          );
        }
        for (const suffix of ["", "-wal", "-shm"]) {
          expect(plannedSource).not.toContainEqual(
            expect.objectContaining({ path: `${externalDatabasePath}${suffix}` }),
          );
        }
        expect(
          plannedSource?.some(
            (endpoint) => endpoint.kind !== "owner" && endpoint.path.startsWith(externalAgentDir),
          ),
        ).toBe(false);
      }
      for (const stepId of ["sessions", "acp-session-metadata"]) {
        expect(plan.steps.find((step) => step.id === stepId)).toBeUndefined();
        expect(result.stepReceipts.find((receipt) => receipt.id === stepId)).toBeUndefined();
      }
      if (overrideKey === "OPENCLAW_AGENT_DIR") {
        expect(plan.steps.find((step) => step.id === "agent-dir")).toBeDefined();
        expect(result.stepReceipts.find((receipt) => receipt.id === "agent-dir")).toMatchObject({
          outcome: "refused",
          refusal: { code: "blocked-by-prior-refusal" },
        });
      } else {
        expect(plan.steps.find((step) => step.id === "agent-dir")).toBeUndefined();
        expect(result.stepReceipts.find((receipt) => receipt.id === "agent-dir")).toBeUndefined();
      }
      expect(fs.existsSync(sources.legacyAgentDir)).toBe(true);
      expect(fs.existsSync(sources.legacySessionStorePath)).toBe(true);
    },
  );

  it("keeps an unbound configured agent database unopened during copied-state planning", async () => {
    const fixture = await makeFixture();
    const externalDatabasePath = path.join(fixture.root, "external", "sessions.sqlite");
    fs.mkdirSync(path.dirname(externalDatabasePath), { recursive: true });
    const database = new DatabaseSync(externalDatabasePath);
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE external_probe (value TEXT NOT NULL);
        INSERT INTO external_probe(value) VALUES ('initial');
      `);
      const cfg: OpenClawConfig = { session: { store: externalDatabasePath } };
      fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
      const snapshotExternalArtifacts = () =>
        Object.fromEntries(
          ["", "-wal", "-shm"].map((suffix) => {
            const pathname = `${externalDatabasePath}${suffix}`;
            const bytes = fs.existsSync(pathname) ? fs.readFileSync(pathname) : undefined;
            if (bytes && suffix === "-shm") {
              bytes.fill(0, 96, 120);
              bytes.fill(0, 128, 132);
            }
            return [suffix || "database", bytes ? sha256(bytes) : undefined];
          }),
        );
      const externalArtifactsBeforePlan = snapshotExternalArtifacts();
      expect(externalArtifactsBeforePlan["-wal"]).toBeDefined();
      expect(externalArtifactsBeforePlan["-shm"]).toBeDefined();
      // Preserve the native method so the spy can inspect each opened database before delegating.
      // oxlint-disable-next-line typescript/unbound-method
      const originalPrepare = DatabaseSync.prototype.prepare;
      const externalQueries: string[] = [];
      vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        const databases = originalPrepare.call(this, "PRAGMA database_list").all() as Array<{
          file?: unknown;
        }>;
        if (
          databases.some(
            (entry) =>
              typeof entry.file === "string" && path.resolve(entry.file) === externalDatabasePath,
          )
        ) {
          externalQueries.push(sql);
        }
        return originalPrepare.call(this, sql);
      });
      const plan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: createCallerModeSnapshot(fixture),
        env: fixture.env,
      });
      expect(snapshotExternalArtifacts()).toEqual(externalArtifactsBeforePlan);
      const plannedDiscovery = plan.steps.find((step) => step.id === "agent-migration-targets");
      expect(plannedDiscovery).toMatchObject({
        outcome: "deferred",
        refusal: { code: "session-target-outside-snapshot" },
      });
      expect(plannedDiscovery?.source).toContainEqual({
        kind: "path",
        path: externalDatabasePath,
      });
      const discoveryIndex = plan.steps.findIndex((step) => step.id === "agent-migration-targets");
      expect(plan.steps.slice(discoveryIndex + 1)).toEqual(
        plan.steps.slice(discoveryIndex + 1).map((step) =>
          expect.objectContaining({
            id: step.id,
            outcome: "deferred",
            refusal: expect.objectContaining({ code: "blocked-by-prior-refusal" }),
          }),
        ),
      );

      database.exec("INSERT INTO external_probe(value) VALUES ('wal-change')");
      const repeatedPlan = await planLegacyStateMigrationsReadOnly({
        mode: "doctor",
        candidate: candidateAt(fixture.root),
        snapshot: createCallerModeSnapshot(fixture),
        env: fixture.env,
      });
      expect(repeatedPlan.planDigest).toBe(plan.planDigest);
      expect(repeatedPlan.snapshot.stateDigest).toBe(plan.snapshot.stateDigest);
      expect(externalQueries).toEqual([]);
      const externalArtifactsBeforeExecution = snapshotExternalArtifacts();

      const result = await autoMigrateLegacyState({
        cfg,
        doctorOnlyStateMigrations: true,
        env: fixture.env,
        homedir: () => fixture.homeDir,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      const executionDiscovery = result.stepReceipts.find(
        (receipt) => receipt.id === "agent-migration-targets",
      );
      expect(executionDiscovery).toMatchObject({
        outcome: "skipped",
        changes: [],
        warnings: [],
      });
      expect(executionDiscovery?.refusal).toBeUndefined();
      expect(externalQueries.length).toBeGreaterThan(0);
      expect(snapshotExternalArtifacts()).toEqual(externalArtifactsBeforeExecution);
    } finally {
      database.close();
    }
  });
  it("keeps agent-scoped plan and receipt items for the standard state root", async () => {
    const fixture = await makeFixture();
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    writeAgentScopedLegacySources(fixture.stateDir);
    const env: NodeJS.ProcessEnv = {
      ...fixture.env,
      OPENCLAW_AGENT_DIR: undefined,
      PI_CODING_AGENT_DIR: undefined,
    };
    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: candidateAt(fixture.root),
      snapshot: createCallerModeSnapshot(fixture),
      env,
    });

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect([
      ...result.stepReceipts.map((receipt) => receipt.id),
      result.postSessionPluginMigration?.step.id,
    ]).toEqual(plan.steps.map((step) => step.id));
    const standardAgentDatabasePath = path.join(
      fixture.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    expect(plan.steps.find((step) => step.id === "shared-auth-store")?.source).toEqual([
      { kind: "sqlite", path: standardAgentDatabasePath },
    ]);
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "shared-auth-store")?.source,
    ).toEqual(plan.steps.find((step) => step.id === "shared-auth-store")?.source);
    const plannedAcp = plan.steps.find((step) => step.id === "acp-session-metadata");
    expect(plannedAcp?.source).not.toContainEqual({
      kind: "sqlite",
      path: standardAgentDatabasePath,
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "acp-session-metadata")?.source,
    ).toEqual(plannedAcp?.source);
    for (const stepId of ["media-persistence", "transcript-directives"]) {
      expect(plan.steps.find((step) => step.id === stepId)?.source).toContainEqual({
        kind: "sqlite",
        path: standardAgentDatabasePath,
      });
      expect(result.stepReceipts.find((receipt) => receipt.id === stepId)?.source).toEqual(
        plan.steps.find((step) => step.id === stepId)?.source,
      );
    }
    const stateDatabasePath = resolveOpenClawStateSqlitePath(env);
    expect(plan.steps.find((step) => step.id === "meeting-transcripts")?.source).toContainEqual({
      kind: "sqlite",
      path: stateDatabasePath,
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "meeting-transcripts")?.source,
    ).toEqual(plan.steps.find((step) => step.id === "meeting-transcripts")?.source);
    for (const stepId of ["sessions", "acp-session-metadata", "agent-dir"]) {
      expect(plan.steps.find((step) => step.id === stepId)).toBeDefined();
      expect(result.stepReceipts.find((receipt) => receipt.id === stepId)).toBeDefined();
    }
  });
});
