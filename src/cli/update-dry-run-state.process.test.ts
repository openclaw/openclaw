import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
import type { LegacyStateMigrationPlan } from "../infra/state-migrations.types.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../infra/update-control-plane-sentinel.js";
import { getUpdateRun } from "../infra/update-run-ledger.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { writeFixtureJson } from "./cli-fixtures.test-support.js";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const blockedStep = { outcome: "deferred", refusal: { code: "blocked-by-prior-refusal" } };
const clearedChildEnv = Object.fromEntries(
  (
    "ALL_PROXY HTTP_PROXY HTTPS_PROXY NODE_ENV NODE_OPTIONS " +
    "OPENCLAW_DEBUG_PROXY_ENABLED OPENCLAW_DEBUG_PROXY_REQUIRE OPENCLAW_SUPERVISOR_MODE " +
    "VITEST VITEST_POOL_ID VITEST_WORKER_ID all_proxy http_proxy https_proxy"
  )
    .split(" ")
    .map((key) => [key, undefined]),
);

async function writeFixture(filename: string, contents: string | object) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, typeof contents === "string" ? contents : JSON.stringify(contents));
}

async function createStateFixture(prefix: string, config = "{}\n", stateName = "state") {
  const root = tempDirs.make(prefix);
  const configPath = path.join(root, "config", "openclaw.json");
  const stateDir = path.join(root, stateName);
  await fs.mkdir(stateDir, { recursive: true });
  await writeFixture(configPath, config);
  return { root, configPath, stateDir };
}

function runMigrationPlan(
  root: string,
  stateDir = path.join(root, "state"),
  extra: string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  return runUpdateProcess(
    root,
    [
      "update",
      "migration-plan",
      "--snapshot-home",
      root,
      "--snapshot-config",
      path.join(root, "config", "openclaw.json"),
      "--snapshot-state",
      stateDir,
      ...extra,
      "--json",
    ],
    env,
  );
}

function runPreview(root: string, command = "update") {
  return runUpdateProcess(root, [command, "--dry-run", "--no-restart", "--timeout", "1", "--json"]);
}

async function snapshotTree(root: string): Promise<string[]> {
  const snapshot: string[] = [];
  for (const { relativePath, dirent } of await listDirectoryTreeStrict(root)) {
    const absolutePath = path.join(root, relativePath);
    if (dirent.isDirectory()) {
      snapshot.push(`d ${relativePath}`);
    } else if (dirent.isSymbolicLink()) {
      snapshot.push(`l ${relativePath} ${await fs.readlink(absolutePath)}`);
    } else {
      snapshot.push(
        `f ${relativePath} ${createHash("sha256")
          .update(await fs.readFile(absolutePath))
          .digest("hex")}`,
      );
    }
  }
  return snapshot;
}

function runUpdateProcess(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  preload?: string,
) {
  const configPath = path.join(root, "config", "openclaw.json");
  const stateDir = path.join(root, "state");
  const entryPath = path.resolve("openclaw.mjs");
  return runCliProcessChild({
    nodeArgs: [...(preload ? ["--import", preload] : []), entryPath, ...args],
    env: {
      ...process.env,
      ...clearedChildEnv,
      HOME: root,
      USERPROFILE: root,
      NODE_DISABLE_COMPILE_CACHE: "1",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      NO_COLOR: "1",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_HIDE_BANNER: "1",
      OPENCLAW_HOME: root,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_STATE_DIR: stateDir,
      ...env,
    },
    maxBuffer: 4 * 1024 * 1024,
    timeoutMs: 60_000,
  });
}

async function expectUnrecordedPreview(root: string, before: string[]): Promise<void> {
  expect(await snapshotTree(root)).toEqual(before);

  const status = await runUpdateProcess(root, ["update", "status", "--timeout", "1", "--json"]);
  expect(status.code, status.stderr).toBe(0);
  const report = JSON.parse(status.stdout);
  expect(report.activeRun).toBeUndefined();
  expect(report.lastRun).toBeUndefined();
  expect(await snapshotTree(root)).toEqual(before);
}

async function expectImmutableRefusal(
  root: string,
  before: string[],
  result: Awaited<ReturnType<typeof runUpdateProcess>>,
  ...messages: RegExp[]
) {
  expect(result.signal).toBeNull();
  expect(result.code).not.toBe(0);
  for (const message of messages) {
    expect(`${result.stdout}\n${result.stderr}`).toMatch(message);
  }
  expect(await snapshotTree(root)).toEqual(before);
}

describe("update process state", () => {
  it("allows cleanup after an admitted updater dies without finishing its ledger", async () => {
    const root = tempDirs.make("openclaw-cleanup-orphan-");
    const configPath = path.join(root, "config", "openclaw.json");
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    };
    await writeFixture(configPath, { gateway: { mode: "local" } });
    const entry = path.join(root, "admit.mjs");
    const admissionModule = pathToFileURL(
      path.resolve("src/cli/update-cli/update-command-run.ts"),
    ).href;
    await fs.writeFile(
      entry,
      `import { admitUpdateCommandRun } from ${JSON.stringify(admissionModule)};
const run = await admitUpdateCommandRun({ opts: { dryRun: true }, root: ${JSON.stringify(path.resolve("."))} });
process.stdout.write(JSON.stringify({ runId: run.runId }) + "\\n");
process.stdin.resume();
`,
    );
    const admitted = await runCliProcessChild({
      nodeArgs: ["--import", path.resolve("scripts/tsx.mjs"), entry],
      env,
      interact: async (child) => {
        await once(child.stdout, "data");
        child.kill("SIGKILL");
      },
    });
    expect(admitted.signal, formatCliProcessFailure({ reason: "updater death", ...admitted })).toBe(
      "SIGKILL",
    );
    const { runId } = JSON.parse(admitted.stdout) as { runId: string };
    expect(getUpdateRun(runId, { env })).toMatchObject({ status: "running", finishedAtMs: null });

    const cleanup = await runUpdateProcess(root, ["update", "cleanup", "--yes", "--json"]);

    expect(JSON.parse(cleanup.stdout)).toMatchObject({
      status: "complete",
      artifacts: [],
      totals: { removedFiles: 0 },
    });
    expect(cleanup.code, cleanup.stderr).toBe(0);
    expect(getUpdateRun(runId, { env })).toMatchObject({ status: "running", finishedAtMs: null });
  });

  it.each([true, false])(
    "keeps cleanup preview/refusal byte-identical (dryRun=%s)",
    async (dryRun) => {
      const root = tempDirs.make("openclaw-cleanup-process-");
      const config = path.join(root, "config", "openclaw.json");
      const runs = path.join(root, "state", "session-sqlite-migration-runs");
      const cache = path.join(root, "cache");
      const temporary = path.join(root, "tmp");
      const logs = tempDirs.make("openclaw-cleanup-logs-");
      const loggingPreload = path.join(logs, "logging.mjs");
      // Diagnostics normally live outside the config/state/cache/scratch snapshot.
      await fs.writeFile(
        loggingPreload,
        `if (!process.versions.bun) await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/tsx.mjs")).href)});
const { setLoggerOverride } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/logging/logger.ts")).href)});
setLoggerOverride({ file: ${JSON.stringify(path.join(logs, "openclaw.log"))} });
`,
      );
      await fs.mkdir(runs, { recursive: true });
      await fs.mkdir(cache);
      await fs.mkdir(temporary);
      await writeFixture(config, "{ invalid-config");
      await fs.writeFile(path.join(runs, "unknown.json"), "{ invalid-manifest");
      const before = await snapshotTree(root);
      const result = await runUpdateProcess(
        root,
        dryRun ? ["update", "--json", "--dry-run", "cleanup"] : ["update", "cleanup", "--json"],
        { XDG_CACHE_HOME: cache, TMPDIR: temporary },
        loggingPreload,
      );
      expect(result.code, result.stderr).toBe(dryRun ? 0 : 1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: dryRun ? "preview" : "refused" });
      expect(await snapshotTree(root)).toEqual(before);
    },
  );

  it.each([
    { name: "malformed", command: "update", config: "{ definitely-not-json\n" },
    {
      name: "migration-pending",
      command: "--update",
      config:
        '{ "heartbeat": { "model": "anthropic/claude-3-5-haiku-20241022", "every": "30m" } }\n',
    },
  ])("keeps $name config and state immutable during preview", async ({ name, command, config }) => {
    const { root, stateDir } = await createStateFixture(`openclaw-update-${name}-`, config);
    if (command === "--update") {
      await writeFixture(
        path.join(stateDir, "tasks", "runs.sqlite.migrated"),
        "legacy migration marker\n",
      );
      await writeFixture(path.join(stateDir, "tasks", "runs.sqlite-wal"), "legacy WAL marker\n");
    }
    const treeBefore = await snapshotTree(root);
    const result = await runPreview(root, command);
    expect(result.code, result.stderr).toBe(0);
    const preview = JSON.parse(result.stdout);
    expect(preview).toMatchObject({
      runId: expect.any(String),
      dryRun: true,
      ...(command === "update" ? { actions: expect.arrayContaining([expect.any(String)]) } : {}),
    });
    await expectUnrecordedPreview(root, treeBefore);
  });

  it.each([false, true])(
    "describes Doctor migrations but refuses without staged candidate identity (unknownPlugin=%s)",
    async (unknownPlugin) => {
      const { root, stateDir } = await createStateFixture(
        "openclaw-update-migration-plan-",
        unknownPlugin ? '{ "plugins": { "entries": { "candidate": {} } } }\n' : "{}\n",
      );
      const execPath = path.join(stateDir, "exec-approvals.json");
      const tuiPath = path.join(stateDir, "tui", "last-session.json");
      await writeFixture(execPath, {
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss" },
      });
      await writeFixture(tuiPath, {
        terminal: { sessionKey: "agent:main:tui:plan", updatedAt: 1 },
      });
      const before = await snapshotTree(root);

      const result = await runMigrationPlan(root);

      expect(result.code, result.stderr).toBe(1);
      const plan = JSON.parse(result.stdout) as LegacyStateMigrationPlan;
      expect(plan).toMatchObject({
        mutationAllowed: false,
        outcome: "refused",
        refusal: { code: "candidate-artifact-digest-required" },
        candidate: {
          root: path.resolve("."),
          version: expect.any(String),
          artifact: {
            outcome: "deferred",
            refusal: { code: "candidate-artifact-digest-required" },
          },
        },
        snapshot: {
          configDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          stateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
      });
      const stateDatabase = {
        kind: "sqlite",
        path: path.join(stateDir, "state", "openclaw.sqlite"),
      } as const;
      for (const [id, source] of [
        ["tui-last-session", [{ kind: "path", path: tuiPath }]],
        ["exec-approvals", [{ kind: "path", path: execPath }, stateDatabase]],
      ] as const) {
        expect(plan.steps.find((step) => step.id === id)).toMatchObject({
          outcome: unknownPlugin ? "deferred" : "planned",
          requiredness: "required",
          source,
          target: [stateDatabase],
          ...(unknownPlugin ? { refusal: { code: "blocked-by-prior-refusal" } } : {}),
        });
      }
      expect(plan.steps.findIndex((step) => step.id === "tui-last-session")).toBeLessThan(
        plan.steps.findIndex((step) => step.id === "exec-approvals"),
      );
      expect(plan.steps.find((step) => step.id === "plugin-doctor-state")).toMatchObject(
        blockedStep,
      );
      if (unknownPlugin) {
        const preparationIndex = plan.steps.findIndex(
          (step) => step.id === "plugin-migration-preparation",
        );
        expect(preparationIndex).toBeGreaterThanOrEqual(0);
        expect(plan.steps[preparationIndex]).toMatchObject({
          outcome: "deferred",
          source: expect.arrayContaining([{ kind: "owner", id: "plugin:candidate" }]),
          refusal: { code: "plugin-planning-deferred" },
        });
        for (const step of plan.steps.slice(preparationIndex + 1)) {
          expect(step).toMatchObject(blockedStep);
        }
      }
      expect(await snapshotTree(root)).toEqual(before);
    },
  );

  it("preserves snapshot path bytes and rejects blank snapshot paths", async () => {
    const { root, stateDir } = await createStateFixture(
      "openclaw-update-migration-plan-paths-",
      "{}\n",
      " copied state ",
    );
    const before = await snapshotTree(root);

    const valid = await runMigrationPlan(root, stateDir, [], { OPENCLAW_STATE_DIR: stateDir });
    expect(valid.code, valid.stderr).toBe(1);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      outcome: "refused",
      snapshot: { stateDir },
    });

    const blank = await runMigrationPlan(root, " \t ", [], { OPENCLAW_STATE_DIR: " \t " });
    expect(blank.code).toBe(1);
    expect(blank.stderr).toContain("--snapshot-state must not be blank");
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("refuses configured session stores outside the copied state snapshot", async () => {
    const { root, configPath, stateDir } = await createStateFixture(
      "openclaw-update-migration-plan-session-root-",
    );
    const externalStore = path.join(root, "external", "sessions.json");
    await writeFixture(externalStore, {});

    await writeFixture(configPath, { session: { store: externalStore } });
    const externalBefore = await snapshotTree(root);
    const external = await runMigrationPlan(root);
    expect(external.code, external.stderr).toBe(1);
    const externalPlan = JSON.parse(external.stdout) as LegacyStateMigrationPlan;
    expect(externalPlan).toMatchObject({
      outcome: "refused",
      refusal: { code: "session-target-outside-snapshot" },
    });
    expect(externalPlan.steps[3]).toMatchObject({
      id: "agent-migration-targets",
      source: expect.arrayContaining([{ kind: "path", path: externalStore }]),
      target: [],
      outcome: "deferred",
      refusal: { code: "session-target-outside-snapshot" },
    });
    expect(externalPlan.steps.slice(0, 4).map((step) => step.id)).toEqual([
      "state-schema",
      "retired-core-state",
      "config-machine-state",
      "agent-migration-targets",
    ]);
    for (const step of externalPlan.steps.slice(4)) {
      expect(step).toMatchObject(blockedStep);
    }
    expect(await snapshotTree(root)).toEqual(externalBefore);

    const copiedStore = path.join(stateDir, "sessions.json");
    await writeFixture(copiedStore, {});
    await writeFixture(configPath, { session: { store: copiedStore } });
    const copiedBefore = await snapshotTree(root);
    const copied = await runMigrationPlan(root);
    expect(copied.code, copied.stderr).toBe(1);
    const copiedPlan = JSON.parse(copied.stdout) as LegacyStateMigrationPlan;
    expect(copiedPlan).toMatchObject({
      refusal: { code: "candidate-artifact-digest-required" },
      steps: expect.arrayContaining([expect.objectContaining({ id: "orphan-session-keys" })]),
    });
    expect(externalPlan.steps.map((step) => step.id)).toEqual(
      copiedPlan.steps.map((step) => step.id),
    );
    expect(await snapshotTree(root)).toEqual(copiedBefore);
  });

  it("rejects caller-supplied snapshot identity without touching the copy", async () => {
    const { root } = await createStateFixture("openclaw-update-migration-plan-identity-");
    const before = await snapshotTree(root);

    const result = await runMigrationPlan(root, undefined, [
      "--config-digest",
      "sha256:caller-claim",
    ]);

    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('does not recognize option "--config-digest"');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it("refuses a copied state path that is not a directory", async () => {
    const { root } = await createStateFixture("openclaw-update-migration-plan-unbound-");
    const stateDir = path.join(root, "copied-state-file");
    await fs.writeFile(stateDir, "not a state directory\n");
    const before = await snapshotTree(root);

    const result = await runMigrationPlan(root, stateDir);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mutationAllowed: false,
      outcome: "refused",
      refusal: { code: "snapshot-identity-unavailable" },
      snapshot: { configDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) },
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it.each(["update", "repair"])(
    "keeps rejected %s arguments from touching legacy state",
    async (command) => {
      const root = tempDirs.make("openclaw-update-legacy-state-");
      const configPath = path.join(root, "config", "openclaw.json");
      const sessionsDir = path.join(root, "state", "sessions");
      const sessionId = "legacy-会議-session";
      await writeFixture(configPath, { gateway: { mode: "local" } });
      await writeFixture(path.join(sessionsDir, "sessions.json"), {
        "agent:main:discord:direct:user": {
          sessionId,
          sessionFile: path.join(sessionsDir, `${sessionId}.jsonl`),
          updatedAt: 1,
        },
      });
      await writeFixture(path.join(sessionsDir, `${sessionId}.jsonl`), {
        type: "session",
        id: sessionId,
      });
      const before = await snapshotTree(root);

      const result = await runUpdateProcess(root, [
        "update",
        ...(command === "repair" ? ["repair"] : []),
        "--timeout",
        "invalid",
        ...(command === "update" ? ["--no-restart"] : []),
        "--json",
      ]);

      await expectImmutableRefusal(root, before, result, /--timeout must be a positive integer/iu);
    },
  );

  it("keeps an orphaned SQLite journal immutable when a managed handoff is refused", async () => {
    const root = tempDirs.make("openclaw-update-refused-handoff-");
    const configPath = path.join(root, "config", "openclaw.json");
    const stateDir = path.join(root, "state");
    const metaPath = path.join(root, "handoff.json");
    await writeFixture(configPath, { gateway: { mode: "local" } });
    await writeFixture(path.join(stateDir, "state", "openclaw.sqlite-journal"), "orphan journal\n");
    await writeFixture(metaPath, { version: 1, meta: { root: path.join(root, "wrong-install") } });
    const before = await snapshotTree(root);

    const result = await runUpdateProcess(root, ["update", "--no-restart", "--json"], {
      [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
    });

    await expectImmutableRefusal(root, before, result, /Managed update handoff root mismatch/iu);
  });

  it.each(["update", "repair", "cleanup"])(
    "fences the mutable %s path before observation or action",
    async (command) => {
      const root = tempDirs.make("openclaw-update-owned-state-");
      const configPath = path.join(root, "config", "openclaw.json");
      const stateDir = path.join(root, "state");
      await writeFixture(configPath, { gateway: { mode: "local" } });
      const externalEnv = {
        ...process.env,
        HOME: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_SUPERVISOR_MODE: "external",
      };
      claimOpenClawStateOwnership("gateway-supervisor", { env: externalEnv });
      openOpenClawStateDatabase({ env: externalEnv });
      closeOpenClawStateDatabaseForTest();
      const before = await snapshotTree(root);

      const refused = await runUpdateProcess(
        root,
        command === "cleanup"
          ? ["update", "cleanup", "--yes", "--json"]
          : [
              "update",
              ...(command === "repair" ? ["repair"] : ["--no-restart"]),
              "--timeout",
              "1",
              "--json",
            ],
      );

      await expectImmutableRefusal(
        root,
        before,
        refused,
        /gateway-supervisor/u,
        /OPENCLAW_SUPERVISOR_MODE=external/u,
      );
    },
  );
});

it.each([
  { entry: "cli", signal: false, plugin: false },
  { entry: "dedicated", signal: false, plugin: true },
  { entry: "dedicated", signal: true, plugin: true },
])(
  "exits the $entry node worker with held-open stdin (signal=$signal, plugin=$plugin)",
  async (scenario) => {
    const root = tempDirs.make("openclaw-worker-exit-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const marker = path.join(root, "plugin-child-closed");
    const pluginDir = path.join(root, "worker-plugin");
    if (scenario.plugin) {
      await fs.mkdir(pluginDir);
      await writeFixtureJson(path.join(pluginDir, "openclaw.plugin.json"), {
        id: "worker-exit-fixture",
        configSchema: { type: "object", properties: {} },
      });
      await fs.writeFile(
        path.join(pluginDir, "index.cjs"),
        [
          'const { spawn } = require("node:child_process");',
          'const { once } = require("node:events");',
          'const { writeFileSync } = require("node:fs");',
          'module.exports = { id: "worker-exit-fixture", register(api) {',
          '  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "pipe", "pipe"] });',
          '  const closed = once(child, "close");',
          "  api.lifecycle.onDispose(async () => {",
          "    child.stdin.end();",
          "    await closed;",
          "    writeFileSync(" + JSON.stringify(marker) + ', "closed");',
          "  });",
          "} };",
        ].join("\n"),
      );
    }
    await writeFixtureJson(configPath, {
      nodeHost: { skills: { enabled: false } },
      ...(scenario.plugin
        ? {
            plugins: {
              allow: ["worker-exit-fixture"],
              load: { paths: [path.join(pluginDir, "index.cjs")] },
              slots: { memory: "none" },
            },
          }
        : {}),
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;
    const result = await runCliProcessChild({
      nodeArgs: [
        path.resolve(scenario.entry === "cli" ? "openclaw.mjs" : "dist/mac-node-worker.js"),
        "node",
        "worker",
      ],
      env,
      interact: async (child) => {
        let stdout = "";
        let stderr = "";
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        await new Promise<void>((resolve, reject) => {
          const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            reject(new Error(`worker exited before ready: ${code ?? signal}`));
          };
          const onData = (chunk: string) => {
            stdout += chunk;
            if (stdout.includes('"type":"ready"')) {
              child.stdout.off("data", onData);
              child.off("exit", onExit);
              resolve();
            }
          };
          child.stdout.on("data", onData);
          child.once("exit", onExit);
        });
        if (scenario.signal) {
          child.kill("SIGTERM");
        } else {
          child.stdin.write('{"type":"stop"}\n');
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(
              new Error(
                formatCliProcessFailure({
                  reason: "worker stayed alive after stop while stdin remained open",
                  stdout,
                  stderr,
                }),
              ),
            );
          }, 2_500);
          timer.unref();
          void once(child, "exit").then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
    });

    expect(result.code).toBe(scenario.signal ? 143 : 0);
    expect(result.signal).toBeNull();
    if (scenario.plugin) {
      expect(await fs.readFile(marker, "utf8")).toBe("closed");
    }
  },
);
