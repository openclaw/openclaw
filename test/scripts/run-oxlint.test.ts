import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOxlintShards,
  filterOxlintShards,
  parseShardRunnerArgs,
  createExtensionOxlintShards,
  resolveShardKillGraceMs,
  resolveShardHeartbeatMs,
  resolveShardTimeoutMs,
  resolveOxlintShardConcurrency,
  resolveWindowsExtensionChunkSize,
  runShard,
  selectCoreOxlintStripe,
  selectExtensionOxlintStripe,
  shouldPrepareExtensionPackageBoundaryArtifactsForShards,
  shouldRunOxlintShardsSerial,
} from "../../scripts/run-oxlint-shards.mts";
import {
  filterSparseMissingOxlintTargets,
  shouldPrepareExtensionPackageBoundaryArtifacts,
} from "../../scripts/run-oxlint.mts";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { withinTest } from "../helpers/promise.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

async function fixtureEventBeforeSettlement(
  file: string,
  operation: PromiseLike<unknown>,
  message = `timeout waiting for ${file}`,
) {
  // Record writes precede notification; the independent receipt pipe may drain after completion.
  const recorded = () => existsSync(file) && readFileSync(file, "utf8").length > 0;
  const settled = Promise.resolve(operation).then(
    () => {
      if (!recorded()) {
        throw new Error(message);
      }
    },
    (error: unknown) => {
      if (!recorded()) {
        throw error;
      }
    },
  );
  await Promise.race([receipts.waitFor(file, "ready"), settled]);
}
const CONSTRAINED_HOST = { totalMemoryBytes: 8 * 1024 ** 3, logicalCpuCount: 4 };
const ROOMY_HOST = { totalMemoryBytes: 64 * 1024 ** 3, logicalCpuCount: 16 };
const RUN_OXLINT_SHARDS_URL = pathToFileURL(
  join(process.cwd(), "scripts/run-oxlint-shards.mts"),
).href;

function resolveSplitCoreConcurrency(env: NodeJS.ProcessEnv, hostResources = ROOMY_HOST): number {
  return resolveOxlintShardConcurrency({ env, platform: "linux", hostResources, splitCore: true });
}

function writeModule(target: string, lines: string[]): void {
  writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
}

function runFixtureShard(runner: string, env: NodeJS.ProcessEnv) {
  return runShard({
    env: {
      ...process.env,
      OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "0",
      OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "0",
      ...env,
    },
    extraArgs: [],
    runner,
    shard: { name: "fixture", args: [] },
  });
}

async function rescueChild(file: string, signal: AbortSignal) {
  const pid = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  if (Number.isSafeInteger(pid) && pid > 1 && isProcessAlive(pid)) {
    process.kill(pid, "SIGKILL");
    await waitForDead(pid, signal);
  }
}

async function runParentTerminationScenario(signal: AbortSignal) {
  const tempDir = createTempDir("openclaw-oxlint-signal-");
  const runner = join(tempDir, "signal-runner.mjs");
  const harness = join(tempDir, "signal-harness.mjs");
  const readyFile = join(tempDir, "ready");
  writeModule(runner, [
    "import { writeFileSync } from 'node:fs';",
    fixtureReceiptClientSource(receipts.endpoint),
    "setInterval(() => {}, 1000);",
    "writeFileSync(process.env.READY_FILE, String(process.pid));",
    "sendReceipt(process.env.READY_FILE, 'ready');",
  ]);

  // Execute cancellation in a subprocess because runShard installs process-level signal handlers.
  writeModule(harness, [
    `import { runShard } from ${JSON.stringify(RUN_OXLINT_SHARDS_URL)};`,
    "const shardEnv = { ...process.env, OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: '0', OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: '0' };",
    "shardEnv.OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS = '25';",
    "process.exitCode = await runShard({ env: shardEnv, extraArgs: [], runner: process.env.RUNNER_FILE, shard: { name: 'signal-test', args: [] } });",
  ]);

  const scenarioEnv: NodeJS.ProcessEnv = {
    ...process.env,
    READY_FILE: readyFile,
    RUNNER_FILE: runner,
  };
  const child = spawn(process.execPath, [harness], {
    env: scenarioEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.resume();
  try {
    await withinTest(fixtureEventBeforeSettlement(readyFile, closed), signal);
    child.kill("SIGTERM");
    const [status, exitSignal] = await withinTest(closed, signal);
    expect(isProcessAlive(Number(readFileSync(readyFile, "utf8")))).toBe(false);
    return { status, signal: exitSignal, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await closed;
    await rescueChild(readyFile, signal);
  }
}

function oxlintShard(
  name: string,
  config: "core" | "extensions" | "scripts",
  ...targets: string[]
) {
  const projects = {
    core: "config/tsconfig/oxlint.core.json",
    extensions: "extensions/tsconfig.json",
    scripts: "config/tsconfig/oxlint.scripts.json",
  };
  return { name, args: ["--tsconfig", projects[config], ...targets] };
}

const PLUGIN_FIXTURE_DIRECTORIES = "zeta alpha beta gamma delta epsilon eta theta iota".split(" ");

function createSourceTree(root: "src" | "extensions", directories: string[], files: string[]) {
  const cwd = createTempDir("openclaw-oxlint-");
  for (const directory of directories) {
    mkdirSync(join(cwd, root, directory), { recursive: true });
  }
  for (const file of files) {
    writeFileSync(join(cwd, root, file), "");
  }
  return cwd;
}

function directoryEntries(directories: string[], files: string[] = []) {
  return [
    ...directories.map((name) => ({ name, isDirectory: () => true, isFile: () => false })),
    ...files.map((name) => ({ name, isDirectory: () => false, isFile: () => true })),
  ] as never;
}

function selectedShards(group: string, options: Parameters<typeof createOxlintShards>[0]) {
  return filterOxlintShards(createOxlintShards({ cwd: "/repo", ...options }), new Set([group]));
}

describe("run-oxlint", () => {
  it.each([
    [[], true],
    [["--tsconfig", "extensions/tsconfig.json", "extensions/telegram/src/index.ts"], true],
    [["--tsconfig=config/tsconfig/oxlint.core.json", "--tsconfig=extensions/tsconfig.json"], true],
    [["--tsconfig", "tsconfig.ui.json", "ui/src/main.ts"], false],
    [["--tsconfig=tsconfig.ui.json", "--tsconfig=config/tsconfig/oxlint.core.json"], false],
    [["--help"], false],
  ] satisfies Array<[string[], boolean]>)(
    "prepares extension boundaries for %j: %s",
    (args, prepare) => {
      expect(shouldPrepareExtensionPackageBoundaryArtifacts(args)).toBe(prepare);
    },
  );

  it("serializes throttled oxlint shards", () => {
    expect(
      shouldRunOxlintShardsSerial({
        env: { CI: "true", OPENCLAW_LOCAL_CHECK_MODE: "throttled" },
        platform: "linux",
        hostResources: CONSTRAINED_HOST,
      }),
    ).toBe(true);
  });

  it.each([
    ["constrained CI", { CI: "true" }, CONSTRAINED_HOST, 1],
    [
      "remote changed gate",
      { OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "1", OPENCLAW_LOCAL_CHECK_MODE: "throttled" },
      ROOMY_HOST,
      4,
    ],
    ["explicit override", { CI: "true", OPENCLAW_OXLINT_SHARD_CONCURRENCY: "2" }, ROOMY_HOST, 2],
  ] as const)("resolves split-core concurrency for %s", (_name, env, host, count) => {
    expect(resolveSplitCoreConcurrency(env, host)).toBe(count);
  });

  it("rejects malformed oxlint shard concurrency overrides", () => {
    expect(() =>
      resolveSplitCoreConcurrency({
        CI: "true",
        OPENCLAW_OXLINT_SHARD_CONCURRENCY: "2x",
      }),
    ).toThrow("OPENCLAW_OXLINT_SHARD_CONCURRENCY must be a positive integer; got: 2x");
  });

  it.each([
    ["HEARTBEAT", resolveShardHeartbeatMs, 30_000, "5000ms"],
    ["TIMEOUT", resolveShardTimeoutMs, 900_000, "1e3"],
    ["KILL_GRACE", resolveShardKillGraceMs, 5_000, "-1"],
  ] as const)(
    "validates the shard %s duration and default",
    (name, resolve, defaultMs, invalid) => {
      const key = `OPENCLAW_OXLINT_SHARD_${name}_MS`;
      expect([resolve({}), resolve({ [key]: "0" }), resolve({ [key]: "5000" })]).toEqual([
        defaultMs,
        0,
        5000,
      ]);
      expect(() => resolve({ [key]: invalid })).toThrow(
        `${key} must be a non-negative integer; got: ${invalid}`,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "maps a joined compiler timeout to exit 124",
    async ({ signal }) => {
      const tempDir = createTempDir("openclaw-oxlint-timeout-group-");
      const runner = join(tempDir, "timeout-runner.mjs");
      const childPidPath = join(tempDir, "child.pid");
      writeModule(runner, [
        "import fs from 'node:fs';",
        fixtureReceiptClientSource(receipts.endpoint),
        "setInterval(() => {}, 1000);",
        "fs.writeFileSync(process.env.CHILD_PID_PATH + '.tmp', String(process.pid));",
        "fs.renameSync(process.env.CHILD_PID_PATH + '.tmp', process.env.CHILD_PID_PATH);",
        "sendReceipt(process.env.CHILD_PID_PATH, 'ready');",
      ]);

      // The watchdog must test teardown, not win a race against child startup.
      let completion!: Promise<number>;
      const releaseAndWait = startProcessWatchdogFixture(() =>
        expect(
          (completion = runFixtureShard(runner, {
            CHILD_PID_PATH: childPidPath,
            OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: "25",
            OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "250",
          })),
        ).resolves.toBe(124),
      );
      try {
        await withinTest(
          fixtureEventBeforeSettlement(
            childPidPath,
            completion,
            `timeout waiting for pid in ${childPidPath}`,
          ),
          signal,
        );
        const childPid = Number(readFileSync(childPidPath, "utf8"));
        expect(isProcessAlive(childPid)).toBe(true);
        await withinTest(releaseAndWait(), signal);
        expect(isProcessAlive(childPid)).toBe(false);
      } finally {
        try {
          await releaseAndWait();
        } finally {
          await rescueChild(childPidPath, signal);
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves parent termination as exit 143",
    async ({ signal }) => {
      const result = await runParentTerminationScenario(signal);
      expect({ status: result.status, signal: result.signal }, result.stderr).toEqual({
        status: 143,
        signal: null,
      });
    },
  );

  it.each([
    { name: "unknown capacity", memoryCapacityBytes: null },
    { name: "Windows", platform: "win32" },
    {
      name: "explicit serial",
      env: { CI: "true", OPENCLAW_OXLINT_SHARDS_SERIAL: "1" },
    },
  ] as const)("preserves complete plugin coverage with $name batches", (scenario) => {
    const directories = Array.from(
      { length: 17 },
      (_, index) => `plugin-${String(index).padStart(2, "0")}`,
    );
    const shards = selectedShards("extensions", {
      env: { CI: "true" },
      platform: "linux",
      ...scenario,
      hostResources: {
        totalMemoryBytes: 16 * 1024 ** 3,
        logicalCpuCount: 4,
        memoryCapacityBytes:
          "memoryCapacityBytes" in scenario ? scenario.memoryCapacityBytes : 15 * 1024 ** 3,
      },
      readDir: (target) =>
        target.endsWith("/extensions")
          ? directoryEntries(directories.toReversed(), ["root.test.ts", "notes.md"])
          : [],
    });
    expect(shards.map((shard) => shard.args.slice(2).length)).toEqual([1, 8, 8, 1]);
    expect(shards.flatMap((shard) => shard.args.slice(2))).toEqual([
      "extensions/root.test.ts",
      ...directories.map((directory) => `extensions/${directory}`),
    ]);
    expect(shouldPrepareExtensionPackageBoundaryArtifactsForShards(shards)).toBe(true);
  });

  it("keeps the unsplit plugin workload for explicit fast mode", () => {
    const shards = selectedShards("extensions", {
      cwd: createSourceTree("extensions", PLUGIN_FIXTURE_DIRECTORIES, ["root.test.ts", "notes.md"]),
      env: { OPENCLAW_LOCAL_CHECK_MODE: "fast", OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE: "1" },
      platform: "linux",
      hostResources: { totalMemoryBytes: 16 * 1024 ** 3, logicalCpuCount: 4 },
    });
    expect(shards).toEqual([oxlintShard("extensions", "extensions", "extensions")]);
  });

  it("splits core oxlint shards when requested", () => {
    const shards = createOxlintShards({
      cwd: "/repo",
      splitCore: true,
      readDir: (target) =>
        target.endsWith("/src")
          ? directoryEntries(["alpha"], ["zeta.ts", "omega.ts", "notes.md"])
          : [],
    });

    expect(shards.slice(0, 4)).toEqual([
      oxlintShard("core:src:alpha", "core", "src/alpha"),
      oxlintShard("core:src:root", "core", "src/omega.ts", "src/zeta.ts"),
      oxlintShard("core:ui", "core", "ui"),
      oxlintShard("core:packages", "core", "packages"),
    ]);
  });

  it("preserves the published updater's automatic full-lint plan on constrained Linux CI", () => {
    const env = { CI: "true" };
    const platform = "linux";
    const hostResources = CONSTRAINED_HOST;
    const directories = ["agents", "alpha", "beta", "gateway", "infra", "zeta"];
    const cwd = createSourceTree("src", directories, ["root.ts"]);
    const shards = selectedShards("core", {
      cwd,
      env,
      platform,
      hostResources,
    });

    expect(shards.map((shard) => shard.args.slice(2))).toEqual([
      ["src/agents", "src/zeta"],
      ["src/alpha", "src/root.ts"],
      ["src/beta", "ui"],
      ["src/gateway", "packages"],
      ["src/infra"],
    ]);
    expect(shards.every((shard) => shard.args[1] === "config/tsconfig/oxlint.core.json")).toBe(
      true,
    );
    expect(shouldRunOxlintShardsSerial({ env, platform, hostResources })).toBe(true);
  });

  it.each([
    {
      args: ["--only=core", "--split-core", "--core-stripe=2/3", "--max-warnings", "0"],
      expected: {
        only: new Set(["core"]),
        coreStripe: { index: 2, total: 3 },
        extensionStripe: undefined,
        splitCore: true,
        oxlintArgs: ["--max-warnings", "0"],
      },
    },
    {
      args: ["--only", "extensions", "--extension-stripe", "4/6"],
      expected: {
        only: new Set(["extensions"]),
        extensionStripe: { index: 4, total: 6 },
        oxlintArgs: [],
      },
    },
  ])("parses runner flags without forwarding them: $args", ({ args, expected }) => {
    expect(parseShardRunnerArgs(args)).toMatchObject(expected);
  });

  it("isolates large core targets while preserving disjoint stripe coverage", () => {
    const shards = createOxlintShards({
      cwd: "/repo",
      splitCore: true,
      readDir: () => directoryEntries(["agents", "gateway", "infra", "misc"]),
    }).filter((shard) => shard.name.startsWith("core:"));
    const stripes = [1, 2, 3].map((index) =>
      selectCoreOxlintStripe(shards, { index, total: 3 }, { isolateLargeTargets: true }),
    );

    const programs = stripes.flat();
    for (const target of ["src/agents", "src/gateway", "src/infra", "ui"]) {
      const program = programs.find((shard) => shard.args.slice(2).includes(target));
      expect(program?.args).toEqual(["--tsconfig", "config/tsconfig/oxlint.core.json", target]);
    }
    const stripeTargets = programs.flatMap((stripe) => stripe.args.slice(2));
    const sourceTargets = shards.flatMap((shard) => shard.args.slice(2));
    expect(stripeTargets.toSorted()).toEqual(sourceTargets.toSorted());
    expect(new Set(stripeTargets)).toHaveProperty("size", sourceTargets.length);
    expect(selectCoreOxlintStripe(shards, { index: 7, total: 7 })).toEqual([]);
    expect(() =>
      selectCoreOxlintStripe(createOxlintShards({ cwd: "/repo" }), { index: 1, total: 2 }),
    ).toThrow("--core-stripe requires a non-empty core-only shard selection");
  });

  it("partitions explicit extension stripes on explicit parallel", () => {
    const entries = directoryEntries(
      Array.from({ length: 55 }, (_, index) => `plugin-${String(index).padStart(2, "0")}`),
      ["root.test.ts"],
    );
    const shards = selectedShards("extensions", {
      env: { OPENCLAW_OXLINT_SHARDS_SERIAL: "0" },
      hostResources: CONSTRAINED_HOST,
      platform: "linux",
      readDir: () => entries,
      splitExtensions: true,
    });
    const stripes = Array.from({ length: 6 }, (_, index) =>
      selectExtensionOxlintStripe(shards, { index: index + 1, total: 6 }),
    );

    const selected = stripes.flat();
    expect(selected.toSorted((left, right) => left.name.localeCompare(right.name))).toEqual(
      shards.toSorted((left, right) => left.name.localeCompare(right.name)),
    );
    expect(selectExtensionOxlintStripe(shards, { index: 9, total: 9 })).toEqual([]);
    expect(selectExtensionOxlintStripe([], { index: 1, total: 6 })).toEqual([]);
    expect(() =>
      selectExtensionOxlintStripe(createOxlintShards({ cwd: "/repo" }), {
        index: 1,
        total: 2,
      }),
    ).toThrow("--extension-stripe requires an extension-only shard selection");
  });

  it.runIf(process.platform !== "win32")(
    "partitions explicit extension stripes through the CLI on nonserial hosts",
    () => {
      const cwd = createSourceTree("extensions", PLUGIN_FIXTURE_DIRECTORIES, ["root.test.ts"]);
      mkdirSync(join(cwd, ".git"));
      const receivedArgsPath = join(cwd, "received-args.jsonl");
      mkdirSync(join(cwd, "scripts"));
      writeModule(join(cwd, "scripts", "run-oxlint.mts"), [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(receivedArgsPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      ]);

      for (let stripe = 1; stripe <= 6; stripe += 1) {
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(RUN_OXLINT_SHARDS_URL),
            "--only=extensions",
            `--extension-stripe=${stripe}/6`,
            "--threads=1",
            "--help",
          ],
          {
            cwd,
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_LOCAL_CHECK: "0",
              OPENCLAW_OXLINT_SHARDS_SERIAL: "0",
            },
            timeout: 5_000,
          },
        );
        expect(result.status, result.stderr).toBe(0);
      }

      const receivedArgs = readFileSync(receivedArgsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const targets = receivedArgs.flatMap((args) => {
        expect(args.slice(0, 2)).toEqual(["--tsconfig", "extensions/tsconfig.json"]);
        expect(args.slice(-2)).toEqual(["--threads=1", "--help"]);
        return args.slice(2, -2);
      });
      expect(targets.toSorted()).toEqual(
        [
          "extensions/root.test.ts",
          ...PLUGIN_FIXTURE_DIRECTORIES.map((directory) => `extensions/${directory}`),
        ].toSorted(),
      );
    },
  );

  it.each([
    { args: ["--core-stripe", "1/3"], error: /--core-stripe/u },
    { args: ["--extension-stripe=7/6"], error: /--extension-stripe/u },
  ])("rejects invalid stripe arguments: $args", ({ args, error }) => {
    expect(() => parseShardRunnerArgs(args)).toThrow(error);
  });

  it.each([["--only"], ["--only=wat"]])(
    "rejects invalid shard CLI input before starting work: %s",
    (...args) => {
      const tempDir = createTempDir("openclaw-oxlint-selector-");
      const result = spawnSync(process.execPath, [fileURLToPath(RUN_OXLINT_SHARDS_URL), ...args], {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_LOCAL_CHECK: "1",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("[oxlint:");
      expect(result.stderr).toMatch(/--only requires a shard name|Unknown oxlint shard selector/u);
      expect(result.stderr.trim().split("\n").at(-1)).toBe("[oxlint] FAILED (exit 1)");
    },
  );

  it("falls back to the full extension shard when Windows extension dirs are unavailable", () => {
    const shards = createExtensionOxlintShards({
      cwd: "/repo",
      platform: "win32",
      readDir: () => {
        throw new Error("missing extensions");
      },
    });

    expect(shards).toEqual([oxlintShard("extensions", "extensions", "extensions")]);
  });

  it("rejects invalid Windows oxlint extension chunk size overrides", () => {
    expect(resolveWindowsExtensionChunkSize({})).toBe(8);
    const key = "OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE";
    for (const value of ["0", "8 chunks"]) {
      expect(() => resolveWindowsExtensionChunkSize({ [key]: value })).toThrow(
        `${key} must be a positive integer; got: ${value}`,
      );
    }
  });

  it.each(["targets", "tsconfig"])("filters tracked %s missing from sparse checkouts", (kind) => {
    const config = "config/tsconfig/oxlint.core.json";
    const targets = kind === "targets";
    const missing = targets ? ["ui", "packages"] : [config];
    expect(
      filterSparseMissingOxlintTargets(
        ["--tsconfig", config, "src", ...(targets ? ["ui", "packages", "--threads=1"] : [])],
        {
          fileExists: (target: string) => target.endsWith("/src"),
          isSparseCheckoutEnabled: () => true,
          isTrackedPath: ({ target }: { target: string }) => missing.includes(target),
        },
      ),
    ).toEqual({
      args: targets ? ["--tsconfig", config, "src", "--threads=1"] : ["src"],
      hadExplicitTargets: true,
      remainingExplicitTargets: 1,
      skippedTargets: targets ? missing : [],
      skippedConfigs: targets ? [] : missing,
    });
  });
});
