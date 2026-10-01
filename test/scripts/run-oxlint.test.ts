// Run Oxlint tests cover run oxlint script behavior.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveRepoToolBinPath } from "../../scripts/lib/local-check-runtime.mts";
import { waitForManagedProcessGroupExit } from "../../scripts/lib/managed-child-process.mts";
import {
  createOxlintShards,
  createOxlintFileScope,
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
  splitCoreOxlintSelections,
  selectExtensionOxlintStripe,
  shouldPrepareExtensionPackageBoundaryArtifactsForShards,
  shouldRunOxlintShardsSerial,
} from "../../scripts/run-oxlint-shards.mts";
import {
  filterSparseMissingOxlintTargets,
  shouldPrepareExtensionPackageBoundaryArtifacts,
} from "../../scripts/run-oxlint.mts";
import {
  waitForChildClose,
  waitForDead,
  waitForFile,
  waitForPidFile,
} from "../helpers/process-wait.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const CONSTRAINED_HOST = { totalMemoryBytes: 8 * 1024 ** 3, logicalCpuCount: 4 };
const ROOMY_HOST = { totalMemoryBytes: 64 * 1024 ** 3, logicalCpuCount: 16 };
const RUN_OXLINT_SHARDS_URL = pathToFileURL(
  join(process.cwd(), "scripts/run-oxlint-shards.mts"),
).href;
type SignalScenario = "forward" | "group" | "ignore";
type SuccessfulLeaderDescendantMode = "drain" | "persist";

function shouldSerializeShards(env: NodeJS.ProcessEnv, hostResources = CONSTRAINED_HOST): boolean {
  return shouldRunOxlintShardsSerial({ env, platform: "linux", hostResources });
}

function resolveSplitCoreConcurrency(env: NodeJS.ProcessEnv, hostResources = ROOMY_HOST): number {
  return resolveOxlintShardConcurrency({ env, platform: "linux", hostResources, splitCore: true });
}

function writeModule(target: string, lines: string[]): void {
  writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
}

function createSignalRunner(mode: SignalScenario, target: string): void {
  if (mode === "group") {
    const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    // An empty PID read becomes 0, so failure cleanup would kill its own process
    // group. Publish complete PID bytes before the harness can observe the file.
    writeModule(target, [
      "import { spawn } from 'node:child_process';",
      "import { renameSync, writeFileSync } from 'node:fs';",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      "writeFileSync(process.env.CHILD_PID_PATH + '.tmp', String(child.pid));",
      "renameSync(process.env.CHILD_PID_PATH + '.tmp', process.env.CHILD_PID_PATH);",
      "writeFileSync(process.env.READY_FILE, String(process.pid));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ]);
    return;
  }

  const markerEnv = mode === "forward" ? "SIGNALED_FILE" : "IGNORED_FILE";
  writeModule(target, [
    "import { writeFileSync } from 'node:fs';",
    "process.on('SIGTERM', () => {",
    `  writeFileSync(process.env.${markerEnv}, 'SIGTERM');`,
    ...(mode === "forward" ? ["  process.exit(0);"] : []),
    "});",
    "writeFileSync(process.env.READY_FILE, String(process.pid));",
    "setInterval(() => {}, 1000);",
  ]);
}

function createSuccessfulLeaderRunner(mode: SuccessfulLeaderDescendantMode, target: string): void {
  const childScript = [
    "const { existsSync, renameSync, writeFileSync } = require('node:fs');",
    "const publish = (target, value) => { writeFileSync(target + '.tmp', value); renameSync(target + '.tmp', target); };",
    "publish(process.env.CHILD_PID_PATH, String(process.pid));",
    ...(mode === "drain"
      ? [
          "process.on('disconnect', () => publish(process.env.DRAINING_FILE, 'ready'));",
          "setInterval(() => { if (existsSync(process.env.RELEASE_FILE)) process.exit(0); }, 5);",
        ]
      : ["process.on('disconnect', () => {});", "setInterval(() => {}, 1000);"]),
    "publish(process.env.READY_FILE, 'ready');",
    "process.send?.('ready');",
  ].join("\n");
  writeModule(target, [
    "import { spawn } from 'node:child_process';",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
    "child.once('message', () => process.exit(0));",
    "child.once('error', () => process.exit(2));",
  ]);
}

async function runSuccessfulLeaderDescendantScenario(
  mode: SuccessfulLeaderDescendantMode,
): Promise<number> {
  const tempDir = createTempDir(`openclaw-oxlint-success-${mode}-`);
  const runner = join(tempDir, "success-runner.mjs");
  const childPidPath = join(tempDir, "child.pid");
  const readyFile = join(tempDir, "ready");
  const drainingFile = join(tempDir, "draining");
  const releaseFile = join(tempDir, "release");
  let childPid = 0;
  createSuccessfulLeaderRunner(mode, runner);

  const completion = runShard({
    env: {
      ...process.env,
      CHILD_PID_PATH: childPidPath,
      DRAINING_FILE: drainingFile,
      READY_FILE: readyFile,
      RELEASE_FILE: releaseFile,
      OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "0",
      OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: "1000",
      OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "0",
    },
    extraArgs: [],
    runner,
    shard: { name: `success-${mode}-test`, args: [] },
  });
  try {
    childPid = await waitForPidFile(childPidPath, 15_000);
    await waitForFile(readyFile, 15_000);
    expect(isProcessAlive(childPid)).toBe(true);
    if (mode === "drain") {
      await waitForFile(drainingFile, 15_000);
      writeFileSync(releaseFile, "release", "utf8");
    }
    const status = await completion;
    await waitForDead(childPid, 2_000);
    return status;
  } finally {
    await completion.catch(() => undefined);
    if (!childPid && existsSync(childPidPath)) {
      childPid = Number(readFileSync(childPidPath, "utf8"));
    }
    if (childPid && isProcessAlive(childPid)) {
      process.kill(childPid, "SIGKILL");
      await waitForDead(childPid, 2_000);
    }
  }
}

function runParentTerminationScenario(mode: SignalScenario) {
  const groupScenario = mode === "group";
  const tempDir = createTempDir(
    groupScenario ? "openclaw-oxlint-parent-group-" : "openclaw-oxlint-signal-",
  );
  const runner = join(tempDir, "signal-runner.mjs");
  const harness = join(tempDir, "signal-harness.mjs");
  const readyFile = join(tempDir, "ready");
  const markerFile = groupScenario
    ? undefined
    : join(tempDir, mode === "forward" ? "signaled" : "ignored");
  const childPidPath = groupScenario ? join(tempDir, "child.pid") : undefined;
  createSignalRunner(mode, runner);

  // Execute cancellation in a subprocess because runShard installs process-level signal handlers.
  writeModule(harness, [
    "import { existsSync, readFileSync } from 'node:fs';",
    `import { runShard } from ${JSON.stringify(RUN_OXLINT_SHARDS_URL)};`,
    "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const groupScenario = process.env.SCENARIO === 'group';",
    "const waitFor = async (predicate) => { const attempts = groupScenario ? 500 : 100; const delay = groupScenario ? 5 : 10; for (let attempt = 0; attempt < attempts; attempt += 1) { if (predicate()) return true; await sleep(delay); } return false; };",
    "const shardEnv = { ...process.env, OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: '0', OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: '0' };",
    "if (process.env.SCENARIO === 'ignore') shardEnv.OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS = '250';",
    "if (groupScenario) shardEnv.OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS = '25';",
    "const promise = runShard({ env: shardEnv, extraArgs: [], runner: process.env.RUNNER_FILE, shard: { name: groupScenario ? 'signal-group-test' : 'signal-test', args: [] } });",
    "const waitPath = groupScenario ? process.env.CHILD_PID_PATH : process.env.READY_FILE;",
    "if (!(await waitFor(() => existsSync(waitPath)))) process.exit(2);",
    "const childPid = groupScenario ? Number(readFileSync(process.env.CHILD_PID_PATH, 'utf8')) : 0;",
    "process.kill(process.pid, 'SIGTERM'); const status = await promise;",
    "if (process.env.MARKER_FILE && !existsSync(process.env.MARKER_FILE)) process.exit(3);",
    "if (groupScenario && !(await waitFor(() => { try { process.kill(childPid, 0); return false; } catch { return true; } }))) { process.kill(childPid, 'SIGKILL'); process.exit(5); }",
    "process.exit(status === 143 ? 0 : 4);",
  ]);

  const markerEnv = mode === "forward" ? "SIGNALED_FILE" : "IGNORED_FILE";
  const scenarioEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CHILD_PID_PATH: childPidPath,
    MARKER_FILE: markerFile,
    READY_FILE: readyFile,
    RUNNER_FILE: runner,
    SCENARIO: mode,
    ...(markerFile ? { [markerEnv]: markerFile } : {}),
  };
  return spawnSync(process.execPath, [harness], {
    encoding: "utf8",
    env: scenarioEnv,
    timeout: 5_000,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolvePoll) => {
      setTimeout(resolvePoll, 5);
    });
  }
  throw new Error("condition was not met before timeout");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

const PLUGIN_FIXTURE_DIRECTORIES = [
  "zeta",
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "eta",
  "theta",
  "iota",
];

function createPluginShardFixture(
  env: NodeJS.ProcessEnv,
  memoryGiB: number,
  platform: NodeJS.Platform = "linux",
) {
  const cwd = createTempDir("openclaw-oxlint-memory-");
  for (const directory of PLUGIN_FIXTURE_DIRECTORIES) {
    mkdirSync(join(cwd, "extensions", directory), { recursive: true });
  }
  writeFileSync(join(cwd, "extensions", "root.test.ts"), "");
  writeFileSync(join(cwd, "extensions", "notes.md"), "");
  return filterOxlintShards(
    createOxlintShards({
      cwd,
      env: { ...env, OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE: "1" },
      platform,
      hostResources: { totalMemoryBytes: memoryGiB * 1024 ** 3, logicalCpuCount: 4 },
    }),
    new Set(["extensions"]),
  );
}

describe("run-oxlint", () => {
  it("prepares extension package boundary artifacts for normal lint runs", () => {
    expect(shouldPrepareExtensionPackageBoundaryArtifacts([])).toBe(true);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["src/index.ts"])).toBe(true);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--type-aware"])).toBe(true);
    expect(
      shouldPrepareExtensionPackageBoundaryArtifacts([
        "--tsconfig",
        "extensions/tsconfig.json",
        "extensions/telegram/src/index.ts",
      ]),
    ).toBe(true);
    expect(
      shouldPrepareExtensionPackageBoundaryArtifacts([
        "--tsconfig=config/tsconfig/oxlint.core.json",
        "--tsconfig=extensions/tsconfig.json",
      ]),
    ).toBe(true);
  });

  it.each([
    ["--tsconfig", "config/tsconfig/oxlint.core.json", "src/index.ts"],
    ["--tsconfig=config/tsconfig/oxlint.core.json", "src/index.ts"],
    ["--tsconfig", "config/tsconfig/oxlint.scripts.json", "scripts/check-changed.mts"],
    ["--tsconfig", "test/tsconfig/tsconfig.test.root.json", "test/scripts/changed-lanes.test.ts"],
  ])("skips extension artifacts for an exact source-backed config: %s", (...args) => {
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(args)).toBe(false);
  });

  it("skips artifact preparation for metadata-only oxlint commands", () => {
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--help"])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--version"])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--print-config"])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifacts(["--rules"])).toBe(false);
  });

  it("prepares shard artifacts only when a selected config consumes them", () => {
    const core = oxlintShard("core", "core", "src");
    const scripts = oxlintShard("scripts", "scripts", "scripts");
    const extensions = oxlintShard("extensions", "extensions", "extensions");

    expect(shouldPrepareExtensionPackageBoundaryArtifactsForShards([core, scripts])).toBe(false);
    expect(shouldPrepareExtensionPackageBoundaryArtifactsForShards([core, extensions])).toBe(true);
  });

  it("serializes broad oxlint shards on constrained local hosts", () => {
    expect(shouldSerializeShards({})).toBe(true);
  });

  it("serializes broad oxlint shards on constrained CI hosts", () => {
    expect(shouldSerializeShards({ CI: "true" })).toBe(true);
    expect(shouldSerializeShards({ CI: "true", OPENCLAW_LOCAL_CHECK_MODE: "throttled" })).toBe(
      true,
    );
  });

  it("keeps oxlint shards parallel on dedicated CI runner classes", () => {
    // Blacksmith's 16 vCPU class carries 32GB; the local-Mac 48GB threshold
    // must not force CI serial (measured: serial shards cost 89s vs ~47s).
    expect(
      shouldSerializeShards(
        { CI: "true" },
        { totalMemoryBytes: 32 * 1024 ** 3, logicalCpuCount: 16 },
      ),
    ).toBe(false);
    expect(
      shouldSerializeShards(
        { CI: "true" },
        { totalMemoryBytes: 16 * 1024 ** 3, logicalCpuCount: 8 },
      ),
    ).toBe(true);
  });

  it("keeps oxlint shards parallel for roomy CI and explicit full-speed runs", () => {
    expect(shouldSerializeShards({ CI: "true" }, ROOMY_HOST)).toBe(false);
    expect(shouldSerializeShards({ OPENCLAW_LOCAL_CHECK_MODE: "full" })).toBe(false);
  });

  it("honors explicit oxlint shard serial overrides", () => {
    expect(
      shouldSerializeShards({ OPENCLAW_OXLINT_SHARDS_SERIAL: "1", CI: "true" }, ROOMY_HOST),
    ).toBe(true);
    expect(shouldSerializeShards({ OPENCLAW_OXLINT_SHARDS_SERIAL: "0" }, ROOMY_HOST)).toBe(false);
  });

  it("bounds split-core shard parallelism on roomy CI hosts", () => {
    expect(resolveSplitCoreConcurrency({ CI: "true" })).toBe(4);
  });

  it.each([
    { extraArgs: [], bounded: true },
    { extraArgs: ["scripts/unmeasured.mts"], bounded: false },
  ])("passes batch admission to every child (bounded=$bounded)", ({ extraArgs, bounded }) => {
    const cwd = createTempDir("openclaw-oxlint-batch-budget-");
    // The batch must acquire its own fixture lock, not an ancestor checkout lock.
    mkdirSync(join(cwd, ".git"));
    for (const directory of ["src/a", "src/b", "scripts"]) {
      mkdirSync(join(cwd, directory), { recursive: true });
    }
    writeModule(join(cwd, "scripts/run-oxlint.mts"), [
      "import { writeFileSync } from 'node:fs';",
      "const target = process.argv.find((arg) => arg === 'src/a' || arg === 'src/b');",
      "writeFileSync(target + '/budget.json', JSON.stringify({ concurrency: process.env.OPENCLAW_OXLINT_BATCH_CONCURRENCY, bounded: process.env.OPENCLAW_OXLINT_BOUNDED_SHARD_ARGS === JSON.stringify(process.argv.slice(2)) }));",
    ]);
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { main } from ${JSON.stringify(RUN_OXLINT_SHARDS_URL)}; await main(['--only=core:src:a', '--only=core:src:b', '--split-core', ...${JSON.stringify(extraArgs)}]);`,
      ],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_OXLINT_SHARDS_SERIAL: "0",
          OPENCLAW_OXLINT_SHARD_CONCURRENCY: "2",
          OPENCLAW_OXLINT_BATCH_CONCURRENCY: "1",
          OPENCLAW_OXLINT_BOUNDED_SHARD_ARGS: "inherited-unbounded-command",
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    for (const target of ["a", "b"]) {
      expect(JSON.parse(readFileSync(join(cwd, "src", target, "budget.json"), "utf8"))).toEqual({
        concurrency: "2",
        bounded,
      });
    }
  });

  it.each([false, true, "stripe"])(
    "retains the canonical budget after file selection (splitCore=%s)",
    (splitCore) => {
      const cwd = createTempDir("openclaw-oxlint-file-budget-");
      mkdirSync(join(cwd, ".git"));
      for (const directory of ["agents", "b", "c", "d", "e", "gateway"]) {
        mkdirSync(join(cwd, "src", directory), { recursive: true });
      }
      mkdirSync(join(cwd, "scripts"));
      const files = ["src/agents/selected.ts", "src/gateway/selected.ts"];
      writeFileSync(join(cwd, ".gitignore"), "**/selected.ts\n");
      for (const file of files) {
        writeFileSync(join(cwd, file), "export {};\n");
      }
      writeModule(join(cwd, "scripts/run-oxlint.mts"), [
        "import { appendFileSync } from 'node:fs';",
        "appendFileSync('budgets.jsonl', JSON.stringify({ bounded: process.env.OPENCLAW_OXLINT_BOUNDED_SHARD_ARGS === JSON.stringify(process.argv.slice(2)), files: process.argv.slice(4) }) + '\\n');",
      ]);
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import os from 'node:os';
           import { syncBuiltinESMExports } from 'node:module';
           os.totalmem = () => 8 * 1024 ** 3;
           os.availableParallelism = () => 4;
           syncBuiltinESMExports();
           const { main } = await import(${JSON.stringify(RUN_OXLINT_SHARDS_URL)});
           await main(['--only=core', ...${JSON.stringify(splitCore ? ["--split-core", ...(splitCore === "stripe" ? ["--core-stripe=1/1"] : [])] : [])}, '--files-json', ${JSON.stringify(JSON.stringify(files))}]);`,
        ],
        {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            CI: "true",
            OPENCLAW_LOCAL_CHECK: "0",
            OPENCLAW_OXLINT_SHARDS_SERIAL: "1",
            OPENCLAW_OXLINT_SHARD_CONCURRENCY: "1",
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const budgets: Array<{ bounded: boolean; files: string[] }> = readFileSync(
        join(cwd, "budgets.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(budgets.map(({ bounded }) => bounded)).toEqual(splitCore ? [true, true] : [false]);
      expect(budgets.flatMap((budget) => budget.files).toSorted()).toEqual(files);
    },
  );

  it("keeps split-core shard runs serial on constrained hosts", () => {
    expect(resolveSplitCoreConcurrency({ CI: "true" }, CONSTRAINED_HOST)).toBe(1);
  });

  it("does not let local throttled mode serialize remote changed gates", () => {
    expect(
      resolveSplitCoreConcurrency({
        OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "1",
        OPENCLAW_LOCAL_CHECK_MODE: "throttled",
      }),
    ).toBe(4);
  });

  it("honors explicit oxlint shard concurrency overrides", () => {
    expect(
      resolveSplitCoreConcurrency({ CI: "true", OPENCLAW_OXLINT_SHARD_CONCURRENCY: "2" }),
    ).toBe(2);

    expect(() =>
      resolveSplitCoreConcurrency({
        CI: "true",
        OPENCLAW_OXLINT_SHARD_CONCURRENCY: "2x",
      }),
    ).toThrow("OPENCLAW_OXLINT_SHARD_CONCURRENCY must be a positive integer; got: 2x");
  });

  it("keeps explicitly split extension stripes serial on roomy hosts", () => {
    expect(
      resolveOxlintShardConcurrency({
        env: { CI: "true", OPENCLAW_OXLINT_SHARD_CONCURRENCY: "2" },
        platform: "linux",
        hostResources: ROOMY_HOST,
        splitExtensions: true,
      }),
    ).toBe(1);
  });

  it("uses a bounded oxlint shard heartbeat by default", () => {
    expect(resolveShardHeartbeatMs({})).toBe(30_000);
    expect(resolveShardHeartbeatMs({ OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "0" })).toBe(0);
    expect(resolveShardHeartbeatMs({ OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "5000" })).toBe(5000);
    expect(() => resolveShardHeartbeatMs({ OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "5000ms" })).toThrow(
      "OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS must be a non-negative integer; got: 5000ms",
    );
  });

  it("uses a bounded oxlint shard timeout by default", () => {
    expect(resolveShardTimeoutMs({})).toBe(900_000);
    expect(resolveShardTimeoutMs({ OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "0" })).toBe(0);
    expect(resolveShardTimeoutMs({ OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(() => resolveShardTimeoutMs({ OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "1e3" })).toThrow(
      "OPENCLAW_OXLINT_SHARD_TIMEOUT_MS must be a non-negative integer; got: 1e3",
    );
    expect(resolveShardKillGraceMs({})).toBe(5_000);
    expect(resolveShardKillGraceMs({ OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: "0" })).toBe(0);
    expect(() => resolveShardKillGraceMs({ OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: "-1" })).toThrow(
      "OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS must be a non-negative integer; got: -1",
    );
  });

  it("fails a stuck oxlint shard instead of waiting forever", async () => {
    const tempDir = createTempDir("openclaw-oxlint-shard-");
    const runner = join(tempDir, "hang-runner.mjs");
    writeFileSync(runner, "setInterval(() => {}, 1000);\n", "utf8");

    const status = await runShard({
      env: {
        ...process.env,
        OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "0",
        OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "25",
        OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: "25",
      },
      extraArgs: [],
      runner,
      shard: { name: "timeout-test", args: [] },
    });

    expect(status).toBe(124);
  });

  it.runIf(process.platform !== "win32")(
    "kills timed-out shard process groups when the leader exits first",
    async () => {
      const tempDir = createTempDir("openclaw-oxlint-timeout-group-");
      const runner = join(tempDir, "timeout-runner.mjs");
      const childPidPath = join(tempDir, "child.pid");
      let childPid = 0;
      const childScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        "fs.writeFileSync(process.env.CHILD_PID_PATH + '.tmp', String(process.pid));",
        "fs.renameSync(process.env.CHILD_PID_PATH + '.tmp', process.env.CHILD_PID_PATH);",
      ].join("\n");
      writeModule(runner, [
        "import { spawn } from 'node:child_process';",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ]);

      // The watchdog must test teardown, not win a race against child startup.
      const releaseAndWait = startProcessWatchdogFixture(() =>
        expect(
          runShard({
            env: {
              ...process.env,
              CHILD_PID_PATH: childPidPath,
              OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "0",
              OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: "25",
              OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "250",
            },
            extraArgs: [],
            runner,
            shard: { name: "timeout-group-test", args: [] },
          }),
        ).resolves.toBe(124),
      );
      try {
        childPid = await waitForPidFile(childPidPath, 15_000);
        expect(isProcessAlive(childPid)).toBe(true);
        await releaseAndWait();
        await waitFor(() => !isProcessAlive(childPid), 15_000);
      } finally {
        try {
          await releaseAndWait();
        } finally {
          if (!childPid && existsSync(childPidPath)) {
            childPid = Number(readFileSync(childPidPath, "utf8"));
          }
          if (childPid && isProcessAlive(childPid)) {
            process.kill(childPid, "SIGKILL");
            await waitForDead(childPid, 2_000);
          }
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves a successful shard status when its process group drains during grace",
    async () => {
      await expect(runSuccessfulLeaderDescendantScenario("drain")).resolves.toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails a successful shard when its process group requires SIGKILL",
    async () => {
      await expect(runSuccessfulLeaderDescendantScenario("persist")).resolves.toBe(1);
    },
  );

  it.runIf(process.platform !== "win32")(
    "forwards parent termination to detached oxlint shard processes",
    () => {
      const result = runParentTerminationScenario("forward");

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
    },
  );

  it.runIf(process.platform !== "win32")(
    "force kills detached shard processes that ignore parent termination",
    () => {
      const result = runParentTerminationScenario("ignore");

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
    },
  );

  it.runIf(process.platform !== "win32")(
    "kills parent-terminated shard process groups when the leader exits first",
    () => {
      const result = runParentTerminationScenario("group");

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
    },
  );

  it("chunks extension oxlint shards on Windows", () => {
    const shards = createOxlintShards({
      cwd: "/repo",
      env: {
        OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE: "2",
      },
      platform: "win32",
      hostResources: ROOMY_HOST,
      readDir: () =>
        [
          { name: "zeta", isDirectory: () => true, isFile: () => false },
          { name: "ignored.txt", isDirectory: () => false, isFile: () => true },
          { name: "root.live.test.ts", isDirectory: () => false, isFile: () => true },
          { name: "notes.md", isDirectory: () => false, isFile: () => true },
          { name: "alpha", isDirectory: () => true, isFile: () => false },
          { name: "beta", isDirectory: () => true, isFile: () => false },
        ] as never,
    });

    expect(shards).toEqual([
      oxlintShard("core", "core", "src", "ui", "packages"),
      oxlintShard("extensions:root", "extensions", "extensions/root.live.test.ts"),
      oxlintShard("extensions:01", "extensions", "extensions/alpha", "extensions/beta"),
      oxlintShard("extensions:02", "extensions", "extensions/zeta"),
      oxlintShard("scripts", "scripts", "scripts"),
    ]);
  });

  it.each([
    { platform: "linux", env: { CI: "true" } },
    { platform: "darwin", env: {} },
  ] as const)(
    "bounds small-host plugin lint with complete coverage on $platform",
    ({ platform, env }) => {
      const shards = createPluginShardFixture(env, 16, platform);
      expect(shards.map((shard) => shard.args.slice(2).length)).toEqual([1, 8, 1]);
      expect(shards.flatMap((shard) => shard.args.slice(2))).toEqual([
        "extensions/root.test.ts",
        ...PLUGIN_FIXTURE_DIRECTORIES.toSorted().map((directory) => `extensions/${directory}`),
      ]);
      expect(shouldPrepareExtensionPackageBoundaryArtifactsForShards(shards)).toBe(true);
    },
  );

  it.each([
    { name: "Linux CI", env: { CI: "true" }, chunkSize: 16 },
    { name: "GitHub Actions", env: { GITHUB_ACTIONS: "true" }, chunkSize: 16 },
    { name: "three CPUs", logicalCpuCount: 3, chunkSize: 8 },
    { name: "below capacity threshold", memoryCapacityBytes: 15 * 1024 ** 3 - 1, chunkSize: 8 },
    { name: "ancestor memory cap", memoryCapacityBytes: 8 * 1024 ** 3, chunkSize: 8 },
    {
      name: "large host with ancestor cap",
      totalMemoryBytes: 31 * 1024 ** 3,
      logicalCpuCount: 8,
      memoryCapacityBytes: 7 * 1024 ** 3,
      chunkSize: 8,
    },
    {
      name: "large host with unknown capacity",
      totalMemoryBytes: 64 * 1024 ** 3,
      logicalCpuCount: 16,
      memoryCapacityBytes: null,
      chunkSize: 8,
    },
    { name: "unknown capacity", memoryCapacityBytes: null, chunkSize: 8 },
    { name: "local Linux", env: {}, chunkSize: 8 },
    { name: "macOS", platform: "darwin", chunkSize: 8 },
    { name: "Windows", platform: "win32", chunkSize: 8 },
    { name: "explicit stripes", splitExtensions: true, chunkSize: 8 },
    {
      name: "explicit serial",
      env: { CI: "true", OPENCLAW_OXLINT_SHARDS_SERIAL: "1" },
      chunkSize: 8,
    },
  ] as const)("preserves complete plugin coverage with $name batches", (scenario) => {
    const directories = Array.from(
      { length: 17 },
      (_, index) => `plugin-${String(index).padStart(2, "0")}`,
    );
    const shards = filterOxlintShards(
      createOxlintShards({
        cwd: "/repo",
        env: { CI: "true" },
        platform: "linux",
        ...scenario,
        hostResources: {
          totalMemoryBytes: scenario.totalMemoryBytes ?? 16 * 1024 ** 3,
          logicalCpuCount: scenario.logicalCpuCount ?? 4,
          memoryCapacityBytes:
            "memoryCapacityBytes" in scenario ? scenario.memoryCapacityBytes : 15 * 1024 ** 3,
        },
        readDir: (target) =>
          target.endsWith("/extensions")
            ? ([
                ...directories
                  .toReversed()
                  .map((name) => ({ name, isDirectory: () => true, isFile: () => false })),
                { name: "root.test.ts", isDirectory: () => false, isFile: () => true },
                { name: "notes.md", isDirectory: () => false, isFile: () => true },
              ] as never)
            : [],
      }),
      new Set(["extensions"]),
    );
    expect(shards.map((shard) => shard.args.slice(2).length)).toEqual(
      scenario.chunkSize === 16 ? [1, 16, 1] : [1, 8, 8, 1],
    );
    expect(shards.flatMap((shard) => shard.args.slice(2))).toEqual([
      "extensions/root.test.ts",
      ...directories.map((directory) => `extensions/${directory}`),
    ]);
    expect(shouldPrepareExtensionPackageBoundaryArtifactsForShards(shards)).toBe(true);
  });

  it.each([
    { name: "explicit full speed", memoryGiB: 16, env: { OPENCLAW_LOCAL_CHECK_MODE: "full" } },
    { name: "explicit fast mode", memoryGiB: 16, env: { OPENCLAW_LOCAL_CHECK_MODE: "fast" } },
    { name: "explicit parallel", memoryGiB: 16, env: { OPENCLAW_OXLINT_SHARDS_SERIAL: "0" } },
    { name: "large low-CPU CI", memoryGiB: 64, env: { CI: "true" } },
    { name: "large explicit serial", memoryGiB: 64, env: { OPENCLAW_OXLINT_SHARDS_SERIAL: "1" } },
    { name: "memory threshold", memoryGiB: 24, env: { CI: "true" } },
  ])("keeps the unsplit plugin workload for $name", ({ memoryGiB, env }) => {
    expect(createPluginShardFixture(env, memoryGiB)).toEqual([
      oxlintShard("extensions", "extensions", "extensions"),
    ]);
  });

  it("splits core oxlint shards when requested", () => {
    const shards = createOxlintShards({
      cwd: "/repo",
      splitCore: true,
      readDir: (target: string) => {
        if (target.endsWith("/src")) {
          return [
            { name: "zeta.ts", isDirectory: () => false, isFile: () => true },
            { name: "omega.ts", isDirectory: () => false, isFile: () => true },
            { name: "notes.md", isDirectory: () => false, isFile: () => true },
            { name: "alpha", isDirectory: () => true, isFile: () => false },
          ] as never;
        }
        return [];
      },
    });

    expect(shards.slice(0, 4)).toEqual([
      oxlintShard("core:src:alpha", "core", "src/alpha"),
      oxlintShard("core:src:root", "core", "src/omega.ts", "src/zeta.ts"),
      oxlintShard("core:ui", "core", "ui"),
      oxlintShard("core:packages", "core", "packages"),
    ]);
  });

  it.each(
    (
      [
        { platform: "linux", env: { CI: "true" } },
        { platform: "linux", env: {} },
        { platform: "linux", env: { GITHUB_ACTIONS: "true" } },
        { platform: "darwin", env: {} },
        { platform: "win32", env: {} },
      ] as const
    ).flatMap((scenario) => [
      { ...scenario, hostResources: CONSTRAINED_HOST },
      {
        ...scenario,
        hostResources: {
          totalMemoryBytes: 31 * 1024 ** 3,
          logicalCpuCount: 8,
          memoryCapacityBytes: 7 * 1024 ** 3,
        },
      },
    ]),
  )(
    "preserves the published updater's automatic full-lint plan on $platform with $env and $hostResources",
    ({ platform, env, hostResources }) => {
      const directories = ["agents", "alpha", "beta", "gateway", "infra", "zeta"];
      const cwd = createTempDir("openclaw-oxlint-core-memory-");
      for (const directory of directories) {
        mkdirSync(join(cwd, "src", directory), { recursive: true });
      }
      writeFileSync(join(cwd, "src", "root.ts"), "");
      const shards = filterOxlintShards(
        createOxlintShards({
          cwd,
          env,
          platform,
          hostResources,
        }),
        new Set(["core"]),
      );

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
      const targets = shards.flatMap((shard) => shard.args.slice(2));
      expect(targets.toSorted()).toEqual(
        [
          ...directories.map((directory) => `src/${directory}`),
          "src/root.ts",
          "ui",
          "packages",
        ].toSorted(),
      );
      expect(new Set(targets).size).toBe(targets.length);
      expect(shouldRunOxlintShardsSerial({ env, platform, hostResources })).toBe(true);
    },
  );

  it("parses shard runner flags without forwarding them to oxlint", () => {
    const parsed = parseShardRunnerArgs([
      "--only=core",
      "--split-core",
      "--core-stripe=2/3",
      "--max-warnings",
      "0",
    ]);

    expect([...parsed.only]).toEqual(["core"]);
    expect(parsed.coreStripe).toEqual({ index: 2, total: 3 });
    expect(parsed.extensionStripe).toBeUndefined();
    expect(parsed.splitCore).toBe(true);
    expect(parsed.oxlintArgs).toEqual(["--max-warnings", "0"]);

    const extension = parseShardRunnerArgs(["--only", "extensions", "--extension-stripe", "4/6"]);
    expect([...extension.only]).toEqual(["extensions"]);
    expect(extension.extensionStripe).toEqual({ index: 4, total: 6 });
    expect(extension.oxlintArgs).toEqual([]);
  });

  it("isolates large core targets while preserving disjoint stripe coverage", () => {
    const shards = createOxlintShards({
      cwd: "/repo",
      splitCore: true,
      readDir: () =>
        [
          { name: "agents", isDirectory: () => true, isFile: () => false },
          { name: "gateway", isDirectory: () => true, isFile: () => false },
          { name: "infra", isDirectory: () => true, isFile: () => false },
          { name: "misc", isDirectory: () => true, isFile: () => false },
        ] as never,
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

  it.runIf(process.platform !== "win32")(
    "keeps physical core selections in their canonical stripe after file projection",
    async () => {
      const cwd = createTempDir("openclaw-oxlint-core-parts-");
      const files = [
        "src/agents/root.ts",
        "src/agents/nested/child.ts",
        "src/agents/new-owner/another.ts",
        "src/gateway/root.ts",
        "src/gateway/server/child.ts",
        "ui/src/pages/chat/view.ts",
        "ui/src/components/view.ts",
        "ui/src/root.ts",
        "ui/config.ts",
        "ui/public/sw.js",
      ];
      for (const file of files) {
        mkdirSync(join(cwd, file, ".."), { recursive: true });
        writeFileSync(join(cwd, file), "export {};\n");
      }
      const shards = filterOxlintShards(
        createOxlintShards({ cwd, splitCore: true }),
        new Set(["core"]),
      );
      const stripes = [];
      for (const index of [1, 2, 3]) {
        stripes.push(
          await splitCoreOxlintSelections(
            selectCoreOxlintStripe(shards, { index, total: 3 }, { isolateLargeTargets: true }),
            { cwd, platform: "linux" },
          ),
        );
      }
      const projected = stripes.map((stripe) =>
        createOxlintFileScope(files, cwd).selectShards(stripe),
      );
      expect(
        projected.flatMap((stripe) => stripe.flatMap((shard) => shard.args.slice(2))).toSorted(),
      ).toEqual(files.toSorted());
      for (const [index, stripe] of projected.entries()) {
        const canonical = selectCoreOxlintStripe(
          shards,
          { index: index + 1, total: 3 },
          { isolateLargeTargets: true },
        );
        for (const shard of stripe) {
          expect(
            canonical.some((owner) => owner.args.slice(2).includes(shard.canonicalTargets![0]!)),
          ).toBe(true);
        }
      }
      const parts = stripes.flat().filter((shard) => shard.canonicalTargets);
      expect(
        parts
          .map((shard) => shard.canonicalTargets)
          .toSorted((left, right) => left![0]!.localeCompare(right![0]!)),
      ).toEqual([["src/agents"], ["src/agents"], ["src/gateway"], ["src/gateway"], ["ui"], ["ui"]]);
      for (const file of files) {
        const selected = createOxlintFileScope([file], cwd).selectShards(parts);
        expect(selected).toHaveLength(1);
        expect(selected[0]!.args.slice(2)).toEqual([file]);
        expect(selected[0]!.canonicalTargets).toEqual([
          file.startsWith("ui/") ? "ui" : file.split("/").slice(0, 2).join("/"),
        ]);
      }
    },
  );

  it("projects present source files when a sparse checkout omits UI", async () => {
    const cwd = createTempDir("openclaw-oxlint-core-sparse-");
    const file = "src/agents/root.ts";
    mkdirSync(join(cwd, "src/agents"), { recursive: true });
    writeFileSync(join(cwd, file), "export {};\n");
    const shards = filterOxlintShards(
      createOxlintShards({ cwd, splitCore: true }),
      new Set(["core"]),
    );
    const selected = await splitCoreOxlintSelections(
      selectCoreOxlintStripe(shards, { index: 1, total: 1 }, { isolateLargeTargets: true }),
      { cwd, platform: process.platform === "win32" ? "win32" : "linux" },
    );
    expect(
      createOxlintFileScope([file], cwd)
        .selectShards(selected)
        .map((shard) => shard.args.slice(2)),
    ).toEqual([[file]]);
  });

  it.each(["win32", "darwin"] as const)("retains directory arguments on %s", async (platform) => {
    const shards = [
      {
        name: "core:src:agents",
        args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src/agents"],
      },
    ];
    let reads = 0;
    const readDir = () => {
      reads++;
      throw new Error("non-Linux selections must not expand root files");
    };
    const selected = await splitCoreOxlintSelections(
      selectCoreOxlintStripe(shards, { index: 1, total: 1 }, { isolateLargeTargets: true }),
      { platform, readDir },
    );
    expect(selected[0]!.args).toEqual(shards[0]!.args);
    expect(reads).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "preserves native file coverage, symlinks and ignores across physical core parts",
    async () => {
      const cwd = createTempDir("openclaw-oxlint-core-native-parts-");
      const included = [
        "src/agents/root.ts",
        "src/agents/space name.mts",
        "src/agents/nested/child.cts",
        "src/agents/nested/view.vue",
        "src/gateway/root.ts",
        "src/gateway/server/child.mts",
        "ui/src/pages/chat/view.tsx",
        "ui/src/components/view.ts",
        "ui/src/root.ts",
        "ui/config.ts",
        "ui/public/sw.js",
      ];
      const ignored = [
        "src/agents/eslint-ignored.ts",
        "src/agents/git-ignored.ts",
        "src/gateway/git-ignored.ts",
        "ui/git-ignored.ts",
        "ui/src/git-ignored.ts",
        "src/gateway/eslint-ignored.ts",
        "src/gateway/server/git-ignored.ts",
        "src/gateway/server/config-ignored.ts",
        "src/agents/nested/git-ignored.ts",
        "src/agents/nested/config-ignored.ts",
        "ui/src/pages/eslint-ignored.ts",
        "ui/src/components/git-ignored.ts",
        "ui/src/components/config-ignored.ts",
        "ui/node_modules/example/index.ts",
        "src/agents/unsupported.txt",
        "src/agents/generated/ignored.ts",
        "src/gateway/generated/ignored.ts",
        "ui/generated/ignored.ts",
        "ui/src/generated/ignored.ts",
      ];
      for (const file of [...included, ...ignored]) {
        mkdirSync(join(cwd, file, ".."), { recursive: true });
        writeFileSync(join(cwd, file), "export {};\n");
      }
      writeFileSync(join(cwd, ".oxlintrc.json"), "{}");
      writeFileSync(join(cwd, ".eslintignore"), "**/eslint-ignored.ts\n**/generated/\n");
      writeFileSync(join(cwd, ".gitignore"), "node_modules/\n**/git-ignored.ts\n");
      for (const directory of ["src/agents/nested", "src/gateway/server", "ui/src/components"]) {
        writeFileSync(join(cwd, directory, ".gitignore"), "git-ignored.ts\n");
        writeFileSync(
          join(cwd, directory, ".oxlintrc.json"),
          JSON.stringify({ ignorePatterns: ["config-ignored.ts"] }),
        );
      }
      mkdirSync(join(cwd, "linked-source"));
      writeFileSync(join(cwd, "linked-source/linked.ts"), "export {};\n");
      symlinkSync(join(cwd, "linked-source"), join(cwd, "src/agents/linked"), "dir");
      symlinkSync(join(cwd, "linked-source/linked.ts"), join(cwd, "ui/src/linked.ts"), "file");
      const inventory = (targets: string[]) => {
        const result = spawnSync(
          resolveRepoToolBinPath("oxlint"),
          ["--debug", "files", ...targets],
          { cwd, encoding: "utf8", timeout: 10_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        return result.stdout.trim().split(/\r?\n/u).filter(Boolean).toSorted();
      };
      const shards = filterOxlintShards(
        createOxlintShards({ cwd, splitCore: true }),
        new Set(["core"]),
      );
      const selections = [];
      for (const index of [1, 2, 3, 4, 5]) {
        selections.push(
          ...(await splitCoreOxlintSelections(
            selectCoreOxlintStripe(shards, { index, total: 5 }, { isolateLargeTargets: true }),
            { cwd, platform: "linux" },
          )),
        );
      }
      for (const target of ["src/agents", "src/gateway", "ui"]) {
        const parts = selections.filter((shard) => shard.canonicalTargets?.includes(target));
        expect(parts).toHaveLength(2);
        const baseline = inventory([target]);
        const split = parts.flatMap((part) => inventory(part.args.slice(2))).toSorted();
        expect(split).toEqual(baseline);
        expect(new Set(split).size).toBe(split.length);
        expect(split).toEqual(
          included
            .filter((file) => file.startsWith(target + "/"))
            .concat(
              target === "ui"
                ? ["ui/src/linked.ts"]
                : target === "src/agents"
                  ? ["src/agents/linked/linked.ts"]
                  : [],
            )
            .toSorted(),
        );
      }

      // Root ignores prefilter explicit files before nested negations can restore
      // them. This selection must retain the native directory walk.
      writeFileSync(join(cwd, ".eslintignore"), "**/*.ts\n");
      writeFileSync(join(cwd, "src/agents/.eslintignore"), "!*.ts\n");
      const target = "src/agents";
      const canonical = {
        name: "core:src:agents",
        args: ["--tsconfig", "config/tsconfig/oxlint.core.json", target],
      };
      const baseline = inventory([target]);
      expect(baseline).toContain("src/agents/root.ts");
      const retained = await splitCoreOxlintSelections([canonical], { cwd, platform: "linux" });
      expect(retained).toEqual([canonical]);
      expect(retained.flatMap((part) => inventory(part.args.slice(2))).toSorted()).toEqual(
        baseline,
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "bounds physical core discovery by the command deadline",
    async () => {
      const cwd = createTempDir("openclaw-oxlint-discovery-deadline-");
      for (const owner of ["agents", "gateway"]) {
        mkdirSync(join(cwd, "src", owner), { recursive: true });
        writeFileSync(join(cwd, "src", owner, "root.ts"), "export {};\n");
      }
      mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true });
      writeFileSync(
        join(cwd, "node_modules/.bin/oxlint"),
        `#!${process.execPath}\n` +
          "const fs = require('node:fs');\n" +
          "fs.appendFileSync('discoveries', process.pid + '\\n');\n" +
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { main } from ${JSON.stringify(RUN_OXLINT_SHARDS_URL)}; await main(['--only=core', '--split-core', '--core-stripe=1/1']);`,
        ],
        {
          cwd,
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            OPENCLAW_LOCAL_CHECK: "0",
            OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "500",
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ETIMEDOUT");
      const pids = readFileSync(join(cwd, "discoveries"), "utf8").trim().split("\n").map(Number);
      expect(pids).toHaveLength(1);
      await waitForDead(pids[0]!, 1_000);
      const shards = [
        {
          name: "core:src:agents",
          args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src/agents"],
        },
      ];
      await expect(
        splitCoreOxlintSelections(shards, {
          cwd,
          platform: "linux",
          deadline: 0,
        }),
      ).rejects.toThrow("core stripe deadline expired before file discovery");
      expect(readFileSync(join(cwd, "discoveries"), "utf8").trim().split("\n")).toHaveLength(1);
    },
  );

  it.runIf(process.platform === "linux").each(["signal", "overflow", "failure"])(
    "joins physical core discovery and stops before shards on %s",
    async (mode) => {
      const cwd = createTempDir("openclaw-oxlint-discovery-stop-");
      for (const owner of ["agents", "gateway"]) {
        mkdirSync(join(cwd, "src", owner), { recursive: true });
        writeFileSync(join(cwd, "src", owner, "root.ts"), "export {};\n");
      }
      mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true });
      const descendant =
        "const fs = require('node:fs'); fs.writeFileSync('descendant.pid.tmp', String(process.pid)); fs.renameSync('descendant.pid.tmp', 'descendant.pid'); " +
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');";
      writeModule(join(cwd, "node_modules/.bin/oxlint"), [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        "fs.appendFileSync('discoveries', process.pid + '\\n');",
        mode === "failure"
          ? "fs.writeFileSync('ready', JSON.stringify([process.pid])); process.stdout.write('src/agents/root.ts\\n', () => process.exit(7));"
          : [
              "process.on('SIGTERM', () => {});",
              `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
              "child.once('message', () => {",
              "fs.writeFileSync('ready.tmp', JSON.stringify([process.pid, child.pid])); fs.renameSync('ready.tmp', 'ready');",
              mode === "overflow" ? "process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1));" : "",
              "}); setInterval(() => {}, 1000);",
            ].join("\n"),
      ]);
      // The discovery shim must be executable for the same native-bin entry point.
      chmodSync(join(cwd, "node_modules/.bin/oxlint"), 0o755);
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { main } from ${JSON.stringify(RUN_OXLINT_SHARDS_URL)}; process.exitCode = await main(['--only=core', '--split-core', '--core-stripe=1/1']);`,
        ],
        {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            OPENCLAW_LOCAL_CHECK: "0",
            OPENCLAW_CI_STATIC_EVIDENCE: "1",
            OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "3000",
            OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS: "25",
          },
        },
      );
      const completion = waitForChildClose(child, 7_000);
      void completion.catch(() => undefined);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      let pids: number[] = [];
      try {
        await waitForFile(join(cwd, "ready"), 3_000);
        pids = JSON.parse(readFileSync(join(cwd, "ready"), "utf8")) as number[];
        if (mode === "signal") {
          process.kill(child.pid!, "SIGTERM");
        }
        const result = await completion;
        expect(result, stderr).toEqual({ code: mode === "signal" ? 143 : 1, signal: null });
        if (mode === "overflow") {
          expect(stderr).toContain("core file discovery exceeded 4 MiB output");
        }
        if (mode === "failure") {
          expect(stderr).toContain("core file discovery failed (exit 7)");
        }
        expect(stdout).not.toContain("[ci-static:oxlint:");
        expect(stderr).not.toContain("[oxlint] shard concurrency");
        expect(readFileSync(join(cwd, "discoveries"), "utf8").trim().split("\n")).toHaveLength(1);
        for (const pid of pids) {
          await waitForDead(pid, 1_000);
        }
      } finally {
        // Keep the cleanup owner alive even when readiness or the assertion times out.
        // A rejected timeout promise does not prove that the wrapper has closed.
        if (child.exitCode === null && child.signalCode === null) {
          const closed = waitForChildClose(child, 2_000);
          child.kill("SIGTERM");
          try {
            await closed;
          } catch {
            const killed = waitForChildClose(child, 2_000);
            child.kill("SIGKILL");
            await killed;
          }
        }
        const discoveries = existsSync(join(cwd, "discoveries"))
          ? readFileSync(join(cwd, "discoveries"), "utf8")
              .trim()
              .split("\n")
              .map(Number)
              .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
          : [];
        const descendantPid = existsSync(join(cwd, "descendant.pid"))
          ? Number(readFileSync(join(cwd, "descendant.pid"), "utf8"))
          : undefined;
        for (const pid of discoveries) {
          // The managed discovery child owns this group; join it even if its
          // leader exited before publishing the separate readiness receipt.
          try {
            process.kill(-pid, "SIGKILL");
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
          }
          expect(
            await waitForManagedProcessGroupExit({ pid }, 1_000, { errorPolicy: "alive-on-eperm" }),
          ).toBe(true);
        }
        for (const pid of new Set([
          ...pids,
          ...discoveries,
          ...(descendantPid ? [descendantPid] : []),
        ])) {
          if (isProcessAlive(pid)) {
            process.kill(pid, "SIGKILL");
          }
          await waitForDead(pid, 1_000);
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "preserves a single JSON report for a split-eligible core target",
    () => {
      const cwd = createTempDir("openclaw-oxlint-core-json-");
      for (const directory of ["src/agents/nested", "scripts"]) {
        mkdirSync(join(cwd, directory), { recursive: true });
      }
      symlinkSync(join(process.cwd(), "node_modules"), join(cwd, "node_modules"), "junction");
      writeFileSync(join(cwd, "src/agents/root.ts"), "export {};\n");
      writeFileSync(join(cwd, "src/agents/nested/child.ts"), "export {};\n");
      writeModule(join(cwd, "scripts/run-oxlint.mts"), [
        "console.log(JSON.stringify({ diagnostics: [], args: process.argv.slice(2) }));",
      ]);
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { main } from ${JSON.stringify(RUN_OXLINT_SHARDS_URL)}; process.exitCode = await main(['--only=core:src:agents','--split-core','--core-stripe=1/1','--threads=1','--format=json']);`,
        ],
        {
          cwd,
          encoding: "utf8",
          timeout: 15_000,
          env: { ...process.env, OPENCLAW_LOCAL_CHECK: "0" },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        diagnostics: [],
        args: [
          "--tsconfig",
          "config/tsconfig/oxlint.core.json",
          "src/agents",
          "--threads=1",
          "--format=json",
        ],
      });
    },
  );

  it.runIf(process.platform === "linux").each([0, 7, 124])(
    "joins core parts serially, sharing their deadline and stopping on exit %s",
    (exitCode) => {
      const cwd = createTempDir("openclaw-oxlint-core-parts-execution-");
      for (const directory of ["src/agents/nested", "scripts"]) {
        mkdirSync(join(cwd, directory), { recursive: true });
      }
      symlinkSync(join(process.cwd(), "node_modules"), join(cwd, "node_modules"), "junction");
      writeFileSync(join(cwd, "src/agents/root.ts"), "export {};\n");
      writeFileSync(join(cwd, "src/agents/nested/child.ts"), "export {};\n");
      writeModule(join(cwd, "scripts/run-oxlint.mts"), [
        "import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';",
        "const previous = existsSync('events.jsonl') ? readFileSync('events.jsonl', 'utf8').trim().split('\\n').map(JSON.parse).at(-1) : undefined;",
        "if (previous) { try { process.kill(previous.pid, 0); throw new Error('previous child is still alive'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }",
        "writeFileSync('active.lock', String(process.pid), { flag: 'wx' });",
        "appendFileSync('events.jsonl', JSON.stringify({pid:process.pid,args:process.argv.slice(2),budget:Number(process.env.OPENCLAW_OXLINT_SHARD_TIMEOUT_MS),concurrency:process.env.OPENCLAW_OXLINT_BATCH_CONCURRENCY,bounded:process.env.OPENCLAW_OXLINT_BOUNDED_SHARD_ARGS === JSON.stringify(process.argv.slice(2))})+'\\n');",
        `await new Promise(resolve => setTimeout(resolve, ${exitCode === 124 ? 10000 : 100}));`,
        "unlinkSync('active.lock');",
        `process.exitCode = ${exitCode};`,
      ]);
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { main } from ${JSON.stringify(RUN_OXLINT_SHARDS_URL)}; process.exitCode = await main(['--only=core:src:agents','--split-core','--core-stripe=1/1','--threads=1']);`,
        ],
        {
          cwd,
          encoding: "utf8",
          timeout: 15_000,
          env: {
            ...process.env,
            OPENCLAW_LOCAL_CHECK: "0",
            OPENCLAW_OXLINT_SHARDS_SERIAL: "0",
            OPENCLAW_OXLINT_SHARD_CONCURRENCY: "8",
            OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: exitCode === 124 ? "1000" : "10000",
            OPENCLAW_CI_STATIC_EVIDENCE: "1",
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(exitCode);
      const events = readFileSync(join(cwd, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              args: string[];
              budget: number;
              concurrency: string;
              bounded: boolean;
            },
        );
      expect(events).toHaveLength(exitCode === 0 ? 2 : 1);
      expect(events.every((event) => event.concurrency === "1" && event.bounded)).toBe(true);
      expect(events[0]!.args).toContain("src/agents/root.ts");
      expect(events[0]!.budget).toBeLessThanOrEqual(10_000);
      const completions = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("[ci-static:oxlint:completion] "));
      if (exitCode === 0) {
        expect(events[1]!.args).toContain("src/agents/nested");
        expect(events[1]!.budget).toBeLessThan(events[0]!.budget - 90);
        expect(completions).toHaveLength(1);
        const completion = JSON.parse(
          completions[0]!.slice("[ci-static:oxlint:completion] ".length),
        ) as { planned: number; completed: number; leaves: string[] };
        expect([completion.planned, completion.completed, new Set(completion.leaves).size]).toEqual(
          [2, 2, 2],
        );
      } else {
        expect(completions).toEqual([]);
      }
    },
  );

  it.each([
    { name: "constrained CI", hostResources: CONSTRAINED_HOST, env: { CI: "true" } },
    { name: "roomy CI", hostResources: ROOMY_HOST, env: { CI: "true" } },
    {
      name: "explicit parallel",
      hostResources: CONSTRAINED_HOST,
      env: { OPENCLAW_OXLINT_SHARDS_SERIAL: "0" },
    },
  ])("partitions explicit extension stripes on $name", ({ hostResources, env }) => {
    const entries = [
      { name: "root.test.ts", isDirectory: () => false, isFile: () => true },
      ...Array.from({ length: 55 }, (_, index) => ({
        name: `plugin-${String(index).padStart(2, "0")}`,
        isDirectory: () => true,
        isFile: () => false,
      })),
    ] as never;
    const shards = filterOxlintShards(
      createOxlintShards({
        cwd: "/repo",
        env,
        hostResources,
        platform: "linux",
        readDir: () => entries,
        splitExtensions: true,
      }),
      new Set(["extensions"]),
    );
    const stripes = Array.from({ length: 6 }, (_, index) =>
      selectExtensionOxlintStripe(shards, { index: index + 1, total: 6 }),
    );

    const selected = stripes.flat();
    expect(selected.toSorted((left, right) => left.name.localeCompare(right.name))).toEqual(
      shards.toSorted((left, right) => left.name.localeCompare(right.name)),
    );
    expect(new Set(selected.map((shard) => shard.name))).toHaveProperty("size", shards.length);
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
    "records every native lint shard after an ordinary failure without hiding its exit",
    () => {
      const cwd = createTempDir("openclaw-oxlint-evidence-");
      mkdirSync(join(cwd, ".git"));
      for (const directory of ["src/alpha", "ui", "packages", "scripts", "config/tsconfig"]) {
        mkdirSync(join(cwd, directory), { recursive: true });
      }
      symlinkSync(join(process.cwd(), "node_modules"), join(cwd, "node_modules"), "junction");
      writeFileSync(
        join(cwd, ".oxlintrc.json"),
        JSON.stringify({
          categories: { correctness: "off" },
          rules: { "no-var": "error", "max-lines": ["error", { max: 10 }] },
        }),
      );
      writeFileSync(join(cwd, "config/tsconfig/oxlint.core.json"), "{}");
      writeFileSync(join(cwd, "src/alpha/example.ts"), "export var legacy = 1;\n");
      writeFileSync(join(cwd, "ui/example.ts"), "export const value = 1;\n");
      writeFileSync(join(cwd, "packages/example.ts"), "export const value = 2;\n");
      const nativeRunner = join(process.cwd(), "scripts/run-oxlint.mts");
      writeModule(join(cwd, "scripts/run-oxlint.mts"), [
        `process.argv[1] = ${JSON.stringify(nativeRunner)};`,
        `await import(${JSON.stringify(pathToFileURL(nativeRunner).href)});`,
      ]);

      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(RUN_OXLINT_SHARDS_URL),
          "--only=core",
          "--split-core",
          "--threads=1",
          "--openclaw-focused-config",
        ],
        {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            CI: "true",
            GITHUB_ACTIONS: "true",
            OPENCLAW_CI_STATIC_EVIDENCE: "1",
            OPENCLAW_OXLINT_SHARD_CONCURRENCY: "2",
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      const lines = result.stdout.trim().split("\n");
      const leaves = lines
        .filter((line) => line.startsWith("[ci-static:oxlint:leaf] "))
        .map((line) => JSON.parse(line.slice("[ci-static:oxlint:leaf] ".length)));
      const groups = lines
        .filter((line) => line.startsWith("[ci-static:oxlint:completion] "))
        .map((line) => JSON.parse(line.slice("[ci-static:oxlint:completion] ".length)));
      expect(leaves).toHaveLength(3);
      expect(leaves.map((leaf) => leaf.exitCode).toSorted((left, right) => left - right)).toEqual([
        0, 0, 1,
      ]);
      expect(
        leaves.every(
          (leaf) => leaf.stderr === "" && leaf.config === "config/tsconfig/oxlint.core.json",
        ),
      ).toBe(true);
      expect(groups).toEqual([
        {
          version: 1,
          id: expect.any(String),
          planned: 3,
          completed: 3,
          leaves: expect.arrayContaining(leaves.map((leaf) => leaf.id)),
        },
      ]);
      expect(lines.at(-1)).toMatch(/^\[ci-static:oxlint:completion\]/u);
      const failedReport = JSON.parse(leaves.find((leaf) => leaf.exitCode === 1).stdout);
      expect(failedReport.diagnostics).toEqual([
        expect.objectContaining({
          filename: "src/alpha/example.ts",
          code: "eslint(no-var)",
          severity: "error",
        }),
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "partitions explicit extension stripes through the CLI on nonserial hosts",
    () => {
      const cwd = createTempDir("openclaw-oxlint-cli-stripes-");
      mkdirSync(join(cwd, ".git"));
      const receivedArgsPath = join(cwd, "received-args.jsonl");
      for (const directory of PLUGIN_FIXTURE_DIRECTORIES) {
        mkdirSync(join(cwd, "extensions", directory), { recursive: true });
      }
      writeFileSync(join(cwd, "extensions", "root.test.ts"), "");
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
    ["--core-stripe=0/3"],
    ["--core-stripe=4/3"],
    ["--core-stripe=1/0"],
    ["--core-stripe=wat"],
    ["--core-stripe", "1/3"],
  ])("rejects invalid core stripe arguments: %s", (...args) => {
    expect(() => parseShardRunnerArgs(args)).toThrow(/--core-stripe/u);
  });

  it.each([
    ["--extension-stripe=0/6"],
    ["--extension-stripe=7/6"],
    ["--extension-stripe=1/0"],
    ["--extension-stripe=wat"],
  ])("rejects invalid extension stripe arguments: %s", (...args) => {
    expect(() => parseShardRunnerArgs(args)).toThrow(/--extension-stripe/u);
  });

  it("filters split core shards by shard family", () => {
    const shards = filterOxlintShards(
      createOxlintShards({
        cwd: "/repo",
        splitCore: true,
        readDir: () => [{ name: "alpha", isDirectory: () => true, isFile: () => false }] as never,
      }),
      new Set(["core"]),
    );

    expect(shards.map((shard) => shard.name)).toEqual([
      "core:src:alpha",
      "core:ui",
      "core:packages",
    ]);
  });

  it.each([
    ["--only"],
    ["--only", "--split-core"],
    ["--only="],
    ["--only=-h"],
    ["--only=wat"],
    ["--only=core", "--only=wat"],
  ])("rejects invalid shard CLI input before starting work: %s", (...args) => {
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
  });

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
    expect(() =>
      resolveWindowsExtensionChunkSize({ OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE: "0" }),
    ).toThrow("OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE must be a positive integer; got: 0");
    expect(() =>
      resolveWindowsExtensionChunkSize({
        OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE: "8 chunks",
      }),
    ).toThrow(
      "OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE must be a positive integer; got: 8 chunks",
    );
  });

  it("filters tracked targets missing from sparse checkouts", () => {
    const result = filterSparseMissingOxlintTargets(
      ["--tsconfig", "config/tsconfig/oxlint.core.json", "src", "ui", "packages", "--threads=1"],
      {
        fileExists: (target: string) => target.endsWith("/src"),
        isSparseCheckoutEnabled: () => true,
        isTrackedPath: ({ target }: { target: string }) => target === "ui" || target === "packages",
      },
    );

    expect(result).toEqual({
      args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src", "--threads=1"],
      hadExplicitTargets: true,
      remainingExplicitTargets: 1,
      skippedTargets: ["ui", "packages"],
      skippedConfigs: [],
    });
  });

  it("filters tracked tsconfig files missing from sparse checkouts", () => {
    const result = filterSparseMissingOxlintTargets(
      ["--tsconfig", "config/tsconfig/oxlint.core.json", "src"],
      {
        fileExists: (target: string) => target.endsWith("/src"),
        isSparseCheckoutEnabled: () => true,
        isTrackedPath: ({ target }: { target: string }) =>
          target === "config/tsconfig/oxlint.core.json",
      },
    );

    expect(result).toEqual({
      args: ["src"],
      hadExplicitTargets: true,
      remainingExplicitTargets: 1,
      skippedTargets: [],
      skippedConfigs: ["config/tsconfig/oxlint.core.json"],
    });
  });

  it("keeps missing untracked oxlint targets so typos still fail", () => {
    const result = filterSparseMissingOxlintTargets(["src", "typo"], {
      fileExists: (target: string) => target.endsWith("/src"),
      isSparseCheckoutEnabled: () => true,
      isTrackedPath: () => false,
    });

    expect(result).toEqual({
      args: ["src", "typo"],
      hadExplicitTargets: true,
      remainingExplicitTargets: 2,
      skippedTargets: [],
      skippedConfigs: [],
    });
  });
});
