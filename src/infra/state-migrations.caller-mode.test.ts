import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  byId,
  createMigrationFixture,
  writeFixtureFile,
} from "./state-migrations.shard-fixture.test-support.js";

const tempDirs = createTrackedTempDirs();
const sqliteSuffixes = ["", "-wal", "-shm"];

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function makeFixture() {
  const root = await tempDirs.make("openclaw-doctor-caller-mode-");
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  for (const candidateRoot of [root, path.join(root, "candidate")]) {
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.symlinkSync(path.resolve("extensions"), path.join(candidateRoot, "extensions"), symlinkType);
  }
  return createMigrationFixture(root, {
    copied: false,
    bundledPluginsDir: path.resolve("extensions"),
    config: { plugins: { entries: { "candidate-plugin": { enabled: true } } } },
  });
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

it("derives bundled migration authority from the supplied candidate root", async () => {
  const fixture = await makeFixture();
  const candidateRoot = path.join(fixture.root, "isolated-candidate");
  const pluginRoot = path.join(candidateRoot, "extensions/candidate-only");
  fs.mkdirSync(pluginRoot, { recursive: true });
  for (const [name, content] of Object.entries({
    "package.json": {
      name: "@openclaw/candidate-only",
      version: "0.0.0-test",
      openclaw: { extensions: ["./index.js"] },
    },
    "openclaw.plugin.json": {
      id: "candidate-only",
      configSchema: {},
      doctorContract: { stateMigrations: [{ id: "candidate-state" }] },
    },
  })) {
    fs.writeFileSync(path.join(pluginRoot, name), `${JSON.stringify(content)}\n`);
  }
  fs.writeFileSync(path.join(pluginRoot, "index.js"), "export default {};\n");

  const before = snapshotFiles(fixture.root);
  const pluginLoader = vi
    .spyOn(pluginSetupModule, "getPluginSetupModuleLoader")
    .mockImplementation(() => {
      throw new Error("copied planning must not load plugins");
    });
  const plan = await fixture.plan({
    candidate: { root: candidateRoot, version: "test" },
  });

  const pluginStep = byId(plan.steps, "plugin-doctor-state");
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

  const first = await fixture.plan();
  expect(first.warnings).toEqual([]);
  expect(first.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

  fs.writeFileSync(ordinarySharedMemoryPath, "changed ordinary snapshot content\n");
  const second = await fixture.plan();
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

  const first = await fixture.plan();
  expect(first.warnings).toEqual([]);
  const configIncludedPaths = [
    ...new Set([includePath, intermediatePath].flatMap((file) => [file, fs.realpathSync(file)])),
  ].toSorted();
  const configSources = [fixture.configPath, ...configIncludedPaths].map((inputPath) => ({
    kind: "path" as const,
    path: inputPath,
  }));
  const configStepIds = [
    "config-machine-state",
    "agent-migration-targets",
    "plugin-migration-preparation",
    "orphan-session-keys",
    "migration-detection",
  ];
  const agentTargets = (agentId: string) => [
    {
      kind: "path",
      path: path.join(fixture.stateDir, "agents", agentId, "sessions/sessions.json"),
    },
    { kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) },
  ];
  for (const stepId of configStepIds) {
    expect.soft(byId(first.steps, stepId)?.source).toEqual(expect.arrayContaining(configSources));
  }
  expect.soft(byId(first.steps, "acp-session-metadata")?.target).toEqual(agentTargets("atlas"));
  const firstConfigDigest = first.snapshot.configDigest;
  if (!firstConfigDigest) {
    throw new Error("expected the copied config inputs to have a bound digest");
  }

  fs.writeFileSync(includePath, `${JSON.stringify(configFor("beacon"))}\n`);
  const stale = await fixture.plan({
    snapshot: {
      ...createCallerModeSnapshot(fixture),
      configDigest: firstConfigDigest,
    },
  });
  expect.soft(stale).toMatchObject({
    outcome: "refused",
    refusal: { code: "snapshot-identity-mismatch" },
    steps: [],
  });

  const second = await fixture.plan();
  expect.soft(second.snapshot.configDigest).not.toBe(firstConfigDigest);
  expect.soft(byId(second.steps, "acp-session-metadata")?.target).toEqual(agentTargets("beacon"));

  const execution = await fixture.migrate(configFor("beacon"), {
    configIncludedPaths,
  });
  for (const stepId of configStepIds) {
    expect
      .soft(byId(execution.stepReceipts, stepId)?.source)
      .toEqual(byId(second.steps, stepId)?.source);
  }
});

it.each(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const)(
  "excludes copied %s agent inputs without overriding live shared-auth authority",
  async (overrideKey) => {
    const fixture = await makeFixture();
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    openOpenClawStateDatabase({ env: fixture.env });
    const legacyAgentDir = path.join(fixture.stateDir, "agent");
    const legacySessionStorePath = path.join(fixture.stateDir, "sessions/sessions.json");
    for (const [file, value] of [
      [path.join(legacyAgentDir, "settings.json"), {}],
      [legacySessionStorePath, { main: { sessionId: "legacy-main", updatedAt: 1 } }],
    ] as const) {
      writeFixtureFile(file, `${JSON.stringify(value)}\n`);
    }
    const externalAgentDir = path.join(fixture.root, `custom-${overrideKey.toLowerCase()}`);
    const externalDatabasePath = path.join(externalAgentDir, "openclaw-agent.sqlite");
    fs.mkdirSync(externalAgentDir, { recursive: true });
    for (const suffix of sqliteSuffixes) {
      fs.writeFileSync(`${externalDatabasePath}${suffix}`, `external${suffix}\n`);
    }
    const env: NodeJS.ProcessEnv = {
      ...fixture.env,
      OPENCLAW_AGENT_DIR: undefined,
      PI_CODING_AGENT_DIR: undefined,
      [overrideKey]: externalAgentDir,
    };
    const plan = await fixture.plan({ env });
    for (const suffix of sqliteSuffixes) {
      expect(fs.readFileSync(`${externalDatabasePath}${suffix}`, "utf8")).toBe(
        `external${suffix}\n`,
      );
      fs.writeFileSync(`${externalDatabasePath}${suffix}`, `changed${suffix}\n`);
    }
    const repeatedPlan = await fixture.plan({ env });

    for (const suffix of sqliteSuffixes) {
      expect(fs.readFileSync(`${externalDatabasePath}${suffix}`, "utf8")).toBe(
        `changed${suffix}\n`,
      );
    }
    const externalAfterPlanning = snapshotFiles(externalAgentDir);
    let firstLiveRefusal: { id: string; files: Record<string, string> } | undefined;

    const result = await fixture.migrate(cfg, {
      env,
      onStepReceipt: (receipt) => {
        if (receipt.outcome === "refused" && firstLiveRefusal === undefined) {
          firstLiveRefusal = { id: receipt.id, files: snapshotFiles(externalAgentDir) };
        }
      },
    });

    if (overrideKey === "OPENCLAW_AGENT_DIR") {
      // This key also selects the shipped live shared-auth source. Its malformed
      // database refuses live discovery; the copied plan never authorized it.
      expect(byId(result.stepReceipts, "migration-detection")).toMatchObject({
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
      const plannedSource = byId(plan.steps, stepId)?.source;
      if (overrideKey === "PI_CODING_AGENT_DIR") {
        expect(plannedSource).toEqual(byId(result.stepReceipts, stepId)?.source);
      }
      for (const suffix of sqliteSuffixes) {
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
      expect(byId(plan.steps, stepId)).toBeUndefined();
      expect(byId(result.stepReceipts, stepId)).toBeUndefined();
    }
    if (overrideKey === "OPENCLAW_AGENT_DIR") {
      expect(byId(plan.steps, "agent-dir")).toBeDefined();
      expect(byId(result.stepReceipts, "agent-dir")).toMatchObject({
        outcome: "refused",
        refusal: { code: "blocked-by-prior-refusal" },
      });
    } else {
      expect(byId(plan.steps, "agent-dir")).toBeUndefined();
      expect(byId(result.stepReceipts, "agent-dir")).toBeUndefined();
    }
    expect(fs.existsSync(legacyAgentDir)).toBe(true);
    expect(fs.existsSync(legacySessionStorePath)).toBe(true);
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
        sqliteSuffixes.map((suffix) => {
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
    const plan = await fixture.plan();
    expect(snapshotExternalArtifacts()).toEqual(externalArtifactsBeforePlan);
    const plannedDiscovery = byId(plan.steps, "agent-migration-targets");
    expect(plannedDiscovery).toMatchObject({
      outcome: "deferred",
      refusal: { code: "session-target-outside-snapshot" },
    });
    expect(plannedDiscovery?.source).toContainEqual({
      kind: "path",
      path: externalDatabasePath,
    });
    const discoveryIndex = plan.steps.findIndex((step) => step.id === "agent-migration-targets");
    for (const step of plan.steps.slice(discoveryIndex + 1)) {
      expect(step).toMatchObject({
        outcome: "deferred",
        refusal: { code: "blocked-by-prior-refusal" },
      });
    }

    database.exec("INSERT INTO external_probe(value) VALUES ('wal-change')");
    const repeatedPlan = await fixture.plan();
    expect(repeatedPlan.planDigest).toBe(plan.planDigest);
    expect(repeatedPlan.snapshot.stateDigest).toBe(plan.snapshot.stateDigest);
    expect(externalQueries).toEqual([]);
    const externalArtifactsBeforeExecution = snapshotExternalArtifacts();

    const result = await fixture.migrate(cfg);
    const executionDiscovery = byId(result.stepReceipts, "agent-migration-targets");
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
