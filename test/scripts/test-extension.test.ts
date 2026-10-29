import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { parseCLI } from "vitest/node";
import {
  listAvailableExtensionIds,
  listChangedExtensionIds,
} from "../../scripts/lib/changed-extensions.mts";
import {
  DEFAULT_EXTENSION_TEST_SHARD_COUNT,
  createExtensionTestProcessTargetChunks,
  createExtensionTestShards,
  estimateExtensionTestCost,
  listExtensionTestFilesForRoots,
  listTrackedTestPlanFiles,
  resolveExtensionBatchPlan,
  resolveExtensionTestPlan,
} from "../../scripts/lib/extension-test-plan.mts";
import { relativizeExtensionVitestArgs } from "../../scripts/lib/extension-vitest-paths.mts";
import bunPin from "../../scripts/lib/openclaw-bun.json" with { type: "json" };
import type { VitestBatchRunParams } from "../../scripts/lib/vitest-batch-runner.mts";
import {
  prepareVitestRuntime,
  resolveVitestPretestBuildMode,
} from "../../scripts/lib/vitest-build-prerequisites.mts";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mjs";
import {
  parseExtensionIds,
  parseExactVitestExcludePaths,
  resolveExtensionBatchParallelism,
  runExtensionBatchPlan,
} from "../../scripts/test-extension-batch-run.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { listVitestConfigTestFiles } from "../vitest-projects-config.test-support.js";
import { databaseWorkerExtensionTestFiles } from "../vitest/vitest.extension-database-workers-paths.mjs";
import { matchesVitestCliSelection } from "../vitest/vitest.pattern-file.ts";
import { childTermination, scriptFiles } from "./run-vitest.test-support.js";

vi.mock("../../scripts/lib/vitest-build-prerequisites.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/vitest-build-prerequisites.mts")>()),
  prepareVitestRuntime: vi.fn().mockResolvedValue(0),
}));

const scriptPath = path.join(process.cwd(), "scripts", "test-extension.mts");
const posixIt = process.platform === "win32" ? it.skip : it;
const MATRIX_TEST_PROCESS_FILE_LIMIT = 40;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

type RunGroupParams = VitestBatchRunParams;

async function runSelectedExtensions(
  extensionIds: string[],
  options: Omit<NonNullable<Parameters<typeof runExtensionBatchPlan>[1]>, "runGroup"> = {},
) {
  const runGroup = vi.fn<(params: RunGroupParams) => Promise<number>>().mockResolvedValue(0);
  const result = await runExtensionBatchPlan(
    resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds }),
    { ...options, runGroup },
  );
  return { result, runGroup };
}

const concurrentPlan = () => ({
  extensionCount: 3,
  extensionIds: ["one", "two", "three"],
  estimatedCost: 60,
  hasTests: true,
  testFileCount: 6,
  planGroups: (
    [
      ["light", 10, "one", 1],
      ["heavy", 30, "two", 3],
      ["middle", 20, "three", 2],
    ] as const
  ).map(([config, estimatedCost, extensionId, testFileCount]) => ({
    config,
    estimatedCost,
    extensionIds: [extensionId],
    roots: [`extensions/${extensionId}`],
    testFileCount,
  })),
});

function runScriptResult(args: string[], cwd = process.cwd(), env = process.env) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

const firstInvocation = (mock: { mock: { calls: readonly [RunGroupParams][] } }) =>
  mock.mock.calls[0]![0];

const extensionConfig = (id: string) => `test/vitest/vitest.extension-${id}.config.ts`;
const withoutExtensionRoot = (file: string) => file.replace(/^extensions\//u, "");
const parseVitest = (args: string[]) => parseCLI(["vitest", "run", ...args]);

function controlledBatch() {
  const started: string[] = [];
  const resolvers: Array<(code: number) => void> = [];
  const runGroup = vi.fn((params: RunGroupParams) => {
    started.push(params.config);
    return new Promise<number>((resolve) => {
      resolvers.push(resolve);
    });
  });
  const runPromise = runExtensionBatchPlan(concurrentPlan(), {
    env: { OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" },
    runGroup,
    vitestArgs: ["--reporter=dot"],
  });
  return { started, resolvers, runGroup, runPromise };
}

const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

function findExtensionWithoutTests() {
  const extensionId = listAvailableExtensionIds().find(
    (candidate) => !resolveExtensionTestPlan({ targetArg: candidate, cwd: process.cwd() }).hasTests,
  );

  if (!extensionId) {
    throw new Error("Expected at least one extension without tests");
  }
  return extensionId;
}

function listExtensionTestFiles(extensionId: string): string[] {
  return listExtensionTestFilesForRoots([bundledPluginRoot(extensionId)]);
}

function expectedMatrixTestProcessCount() {
  const files = listExtensionTestFilesForRoots([bundledPluginRoot("matrix")]);
  const workers = files.filter((file) => databaseWorkerExtensionTestFiles.includes(file));
  return (
    Math.ceil(workers.length / MATRIX_TEST_PROCESS_FILE_LIMIT) +
    Math.ceil((files.length - workers.length) / MATRIX_TEST_PROCESS_FILE_LIMIT)
  );
}

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts?.close();
});

it("splits the IRC batch between persistence and channel owners without double counting", async () => {
  const extensionId = "irc";
  const ingressFile = "extensions/irc/src/irc-ingress.test.ts";
  const root = `extensions/${extensionId}`;
  const batch = resolveExtensionBatchPlan({ extensionIds: [extensionId] });
  const files = listExtensionTestFilesForRoots([root]);
  const workerFiles = (await listVitestConfigTestFiles(extensionConfig("database-workers"))).filter(
    (file) => file.startsWith(`${root}/`),
  );
  const channelFiles = await listVitestConfigTestFiles(extensionConfig(extensionId));
  expect(workerFiles).toContain(ingressFile);
  expect(channelFiles).not.toContain(ingressFile);
  expect([...workerFiles, ...channelFiles].toSorted()).toEqual(files.toSorted());
  expect(batch).toMatchObject({ extensionIds: [extensionId], testFileCount: files.length });
  expect(batch.planGroups).toEqual([
    expect.objectContaining({
      config: extensionConfig("database-workers"),
      extensionIds: [extensionId],
      testFileCount: workerFiles.length,
    }),
    expect.objectContaining({
      config: extensionConfig(extensionId),
      roots: [root],
      extensionIds: [extensionId],
      testFileCount: channelFiles.length,
    }),
  ]);
  expect(listExtensionTestFilesForRoots(batch.planGroups[0]!.roots)).toEqual(
    workerFiles.toSorted(),
  );
  const shards = createExtensionTestShards({ extensionIds: [extensionId], shardCount: 2 });
  expect(shards).toHaveLength(1);
  expect(shards[0]?.planGroups).toEqual(batch.planGroups);
});

posixIt("preserves newline and leading-space tokens in the tracked Git inventory", () => {
  const root = tempDirs.make("openclaw-extension-git-paths-");
  const trackedPaths = [" extensions/example.test.ts", "extensions/example\npath.test.ts"];
  expect(spawnSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root }).status).toBe(0);
  for (const trackedPath of trackedPaths) {
    const absolutePath = path.join(root, trackedPath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, "export {};\n");
  }
  expect(spawnSync("git", ["add", "--", ...trackedPaths], { cwd: root }).status).toBe(0);

  expect(listTrackedTestPlanFiles(root, [":(glob)**/*.test.ts"])?.toSorted()).toEqual(
    trackedPaths.toSorted(),
  );
});

it("keeps Matrix runs with a missing retry value in one process", () => {
  const root = bundledPluginRoot("matrix");

  expect(
    createExtensionTestProcessTargetChunks(extensionConfig("matrix"), [root], ["--retry"]),
  ).toEqual([[root]]);
});

it("maps only exact tracked extension paths without reading extension directories", () => {
  const payload = expectNoNodeFsScans<{
    changed: string[];
    ids: number;
    lookalikes: string[];
  }>(`
      const { detectChangedExtensionIds, listAvailableExtensionIds } =
        await import("./scripts/lib/changed-extensions.mts");
      const ids = listAvailableExtensionIds();
      const changed = detectChangedExtensionIds([
        "extensions/slack/src/channel.ts",
        "src/line/message.test.ts",
        "extensions/firecrawl/package.json",
        "extensions/not-real/package.json",
        "src/not-a-plugin/file.ts",
      ]);
      const lookalikes = detectChangedExtensionIds([
        " extensions/slack/src/channel.ts",
        ${JSON.stringify(String.raw`extensions\slack\src\channel.ts`)},
        " src/line/message.test.ts",
      ]);
      return { changed, ids: ids.length, lookalikes };
    `);
  expect(payload.changed).toEqual(["firecrawl", "line", "slack"]);
  expect(payload.lookalikes).toEqual([]);
  expect(payload.ids).toBeGreaterThan(0);
});

it("can fail safe to all extensions when the base revision is unavailable", () => {
  const extensionIds = listChangedExtensionIds({
    base: "refs/heads/openclaw-test-missing-base",
    unavailableBaseBehavior: "all",
  });

  expect(extensionIds).toEqual(listAvailableExtensionIds());
});

it("keeps explicitly requested extensions without tests in batch plans", () => {
  const extensionId = findExtensionWithoutTests();
  const testedExtensionId = "firecrawl";
  const testedExtensionFiles = listExtensionTestFiles(testedExtensionId);
  const batch = resolveExtensionBatchPlan({
    cwd: process.cwd(),
    extensionIds: [extensionId, testedExtensionId],
  });

  expect(batch).toMatchObject({
    extensionIds: [extensionId, testedExtensionId].toSorted((a, b) => a.localeCompare(b)),
    extensionCount: 2,
    noTestExtensionIds: [extensionId],
    hasTests: true,
    testFileCount: testedExtensionFiles.length,
  });
  expect(batch.planGroups.flatMap((group) => group.extensionIds)).toEqual([testedExtensionId]);
});

it("counts tracked extension tests without walking extension directories", () => {
  const payload = expectNoNodeFsScans<{
    batchTests: number;
    shards: number;
    shardTests: number;
  }>(
    `
        const { createExtensionTestShards, resolveExtensionBatchPlan } =
          await import("./scripts/lib/extension-test-plan.mts");
        const extensionIds = ["matrix", "openai", "slack", "telegram"];
        const batch = resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds });
        const shards = createExtensionTestShards({ cwd: process.cwd(), extensionIds, shardCount: 2 });
        return {
          batchTests: batch.testFileCount,
          shards: shards.length,
          shardTests: shards.reduce((total, shard) => total + shard.testFileCount, 0),
        };
      `,
    { counters: ["readdirSync"] },
  );
  expect(payload.batchTests).toBeGreaterThan(0);
  expect(payload.shards).toBe(2);
  expect(payload.shardTests).toBe(payload.batchTests);
});

it("balances extension test shards by estimated CI cost", () => {
  for (const [config, singletonSeconds, tenFileSeconds] of [
    [extensionConfig("slack"), 2, 12],
    [extensionConfig("telegram"), 6, 43],
    [extensionConfig("database-workers"), 8, 76],
  ] as const) {
    expect(estimateExtensionTestCost(config, 1), config).toBe(singletonSeconds);
    expect(estimateExtensionTestCost(config, 10), config).toBe(tenFileSeconds);
  }
  const shards = createExtensionTestShards({ shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT });
  const expectedIds = listAvailableExtensionIds().filter(
    (targetArg) => resolveExtensionTestPlan({ targetArg }).hasTests,
  );

  expect(shards).toHaveLength(DEFAULT_EXTENSION_TEST_SHARD_COUNT);
  expect(shards.map((shard) => shard.checkName)).toEqual(
    shards.map((_shard, index) => `checks-node-extensions-shard-${index + 1}`),
  );

  const assigned = shards.flatMap((shard) => shard.extensionIds);
  const uniqueAssigned = [...new Set(assigned)];

  expect(uniqueAssigned.toSorted((left, right) => left.localeCompare(right))).toEqual(
    expectedIds.toSorted((left, right) => left.localeCompare(right)),
  );
  expect(assigned).toHaveLength(expectedIds.length);

  const totals = shards.map((shard) => shard.estimatedCost);
  const largestPlugin = Math.max(
    ...expectedIds.map((targetArg) => resolveExtensionTestPlan({ targetArg }).estimatedCost),
  );
  const lowerBound = Math.max(
    largestPlugin,
    Math.ceil(totals.reduce((sum, cost) => sum + cost, 0) / shards.length),
  );
  expect(Math.max(...totals)).toBe(lowerBound);

  for (const shard of shards) {
    expect(shard.extensionIds.length).toBeGreaterThan(0);
  }
});

it.each([0, 7])("runs bounded parallel groups and stops admission after exit %s", async (code) => {
  const { started, resolvers, runGroup, runPromise } = controlledBatch();
  await vi.waitFor(() => {
    expect(started).toEqual(["heavy", "middle"]);
  });
  resolvers.shift()?.(code);
  await nextTurn();
  expect(started).toEqual(code ? ["heavy", "middle"] : ["heavy", "middle", "light"]);
  while (resolvers.length > 0) {
    resolvers.shift()?.(0);
  }
  await expect(runPromise).resolves.toBe(code);
  expect(runGroup).toHaveBeenCalledTimes(code ? 2 : 3);
  if (code) {
    return;
  }
  const firstRunGroupParams = firstInvocation(runGroup);
  expect(firstRunGroupParams).toMatchObject({
    args: ["--reporter=dot"],
    config: "heavy",
    env: {
      OPENCLAW_EXTENSION_BATCH_PARALLEL: "2",
    },
    targets: ["two/"],
  });
  const cachePaths = runGroup.mock.calls.map(([params]) =>
    params.env?.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH?.replaceAll("\\", "/"),
  );
  expect(new Set(cachePaths).size).toBe(3);
  expect(
    cachePaths.every((cachePath) =>
      /\/\.cache\/vitest\/slots\/[a-f\d]+\/0$/u.test(cachePath ?? ""),
    ),
  ).toBe(true);
});

it("rejects malformed extension batch parallelism", () => {
  for (const value of ["nope", "2x", "0"]) {
    expect(() =>
      resolveExtensionBatchParallelism(3, { OPENCLAW_EXTENSION_BATCH_PARALLEL: value }),
    ).toThrow("OPENCLAW_EXTENSION_BATCH_PARALLEL must be a positive integer");
  }
});

it.each([
  {
    name: "preserves positional Vitest args after the extension batch separator",
    input: ["telegram", "--coverage", "--", "extensions/telegram/src/index.test.ts", "--run"],
    extensionIds: ["telegram"],
    passthroughArgs: ["--coverage", "extensions/telegram/src/index.test.ts", "--run"],
  },
  {
    name: "accepts pnpm's leading argument separator before extension ids",
    input: ["--", "telegram,slack", "--run"],
    extensionIds: ["telegram", "slack"],
    passthroughArgs: ["--run"],
  },
])("$name", ({ input, extensionIds, passthroughArgs }) => {
  expect(parseExtensionIds(input)).toEqual({ extensionIds, passthroughArgs });
});

it.each([
  { enableMaglev: false, realHomeReplay: false, pool: "forks" },
  { enableMaglev: true, realHomeReplay: false, pool: "forks" },
  { enableMaglev: false, realHomeReplay: true, pool: "forks" },
  { enableMaglev: false, realHomeReplay: false, pool: "threads" },
])(
  "runs installed Vitest without pnpm (pool: $pool, Maglev: $enableMaglev, owner-authorized real home: $realHomeReplay)",
  ({ enableMaglev, realHomeReplay, pool }) => {
    const root = realpathSync(tempDirs.make("openclaw-test-extension-native-"));
    const files = scriptFiles(root);
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const runtime = process.versions.bun ? "bun" : "node";
    const report = path.join(root, "report.json");
    const config = path.join(root, "vitest.config.mjs");
    const entry = path.join(root, "batch.mts");
    mkdirSync(home);
    mkdirSync(bin);
    const executable = path.join(bin, process.platform === "win32" ? `${runtime}.exe` : runtime);
    if (runtime === "bun" && process.platform !== "win32") {
      // This fixture owns attestation metadata; real test execution still uses the outer runtime.
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync(
        executable,
        `#!/bin/sh\nif [ "$1" = --revision ]; then\n  printf '%s\\n' ${quote(bunPin.revision)}\nelse\n  exec ${quote(process.execPath)} "$@"\nfi\n`,
        { mode: 0o755 },
      );
    } else {
      symlinkSync(process.execPath, executable, "file");
    }
    files.linkModules();
    writeFileSync(
      config,
      `import assert from 'node:assert/strict';
assert.equal(process.execArgv.includes('--no-maglev'), ${runtime === "node" && !enableMaglev}, 'batch Node defaults');
assert.equal(process.execArgv.includes('--no-concurrent-sparkplug'), ${runtime === "node"}, 'batch Sparkplug policy');
export default {root:${JSON.stringify(root)},cacheDir:${JSON.stringify(path.join(root, "cache"))},test:{include:['*.test.mjs'],pool:${JSON.stringify(pool)},execArgv:['--no-warnings'],globalSetup:[${JSON.stringify(path.join(process.cwd(), "test/vitest/vitest.node-policy.global-setup.ts"))}],maxWorkers:1,fileParallelism:false,cache:false,fsModuleCache:false}};`,
    );
    const expectedHome = realHomeReplay ? JSON.stringify(home) : "path.join(tmpdir(), 'home')";
    writeFileSync(
      path.join(root, "selected.test.mjs"),
      `import {homedir,tmpdir} from 'node:os';import path from 'node:path';import {test,expect} from 'vitest';let attempts=0;test('selected native case',()=>{expect(++attempts).toBe(2);expect(Boolean(process.versions.bun)).toBe(${runtime === "bun"});expect(process.execArgv.includes('--no-concurrent-sparkplug')).toBe(${runtime === "node" && pool === "forks"});expect(process.execArgv).toContain('--no-warnings');expect(process.env.NODE_OPTIONS).toBe('--trace-warnings');expect(process.env.HOME).toBe(${expectedHome});expect(homedir()).toBe(${expectedHome});});`,
    );
    for (const name of ["excluded", "unrelated"]) {
      writeFileSync(
        path.join(root, `${name}.test.mjs`),
        "import {test,expect} from 'vitest';test('must not execute',()=>expect.fail('selection lost'));",
      );
    }
    const params = {
      config,
      homeMode: realHomeReplay ? "live-aware" : undefined,
      args: [
        "--configLoader=native",
        "--retry=1",
        "--reporter=verbose",
        "--reporter=json",
        `--outputFile=${report}`,
        "--exclude",
        "**/excluded.test.mjs",
      ],
      targets: [path.join(root, "selected.test.mjs"), path.join(root, "excluded.test.mjs")],
    } satisfies VitestBatchRunParams;
    writeFileSync(
      entry,
      `import {runVitestBatch} from ${JSON.stringify(path.join(process.cwd(), "scripts/lib/vitest-batch-runner.mts"))};process.exitCode=await runVitestBatch({...${JSON.stringify(params)},env:{...process.env,OPENCLAW_VITEST_ENABLE_MAGLEV:${JSON.stringify(enableMaglev ? "1" : "")}}});`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", path.join(process.cwd(), "scripts/tsx.mjs"), entry],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: bin,
          OPENCLAW_VITEST_RUNTIME: runtime,
          HOME: home,
          USERPROFILE: home,
          OPENCLAW_LIVE_TEST: realHomeReplay ? "1" : "0",
          OPENCLAW_LIVE_USE_REAL_HOME: realHomeReplay ? "1" : "0",
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          SystemRoot: process.env.SystemRoot,
          COREPACK_ENABLE_NETWORK: "0",
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_OPTIONS: "--trace-warnings",
          CI: "1",
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    const native = files.json("report.json");
    expect(native.success).toBe(true);
    expect(
      native.testResults.flatMap(
        (file: { assertionResults: { title: string; status: string }[] }) =>
          file.assertionResults.map(({ title, status }) => [title, status]),
      ),
    ).toEqual([["selected native case", "passed"]]);
  },
);

it.each([
  {
    name: "preserves native Vitest option operands from a plugin cwd",
    input: ["--max-workers", "2", "extensions/browser/src/example.test.ts"],
    expected: ["--max-workers", "2", "browser/src/example.test.ts"],
  },
  {
    name: "preserves native separator tails without interpreting them as plugin paths",
    input: ["--", "extensions/browser/src/literal.test.ts", "--exclude="],
    expected: ["--", "extensions/browser/src/literal.test.ts", "--exclude="],
  },
])("$name", ({ input, expected }) => {
  const args = relativizeExtensionVitestArgs(input, path.join(process.cwd(), "extensions/browser"));
  expect(parseVitest(args)).toEqual(parseVitest(expected));
});

it("relativizes absolute exclude paths from extension cwd", () => {
  const flag = "--exclude=";
  const extensionCwd = path.join(process.cwd(), "extensions", "codex");
  expect(
    relativizeExtensionVitestArgs(
      [
        flag,
        path.join(extensionCwd, "src", "app-server", "run-attempt.test.ts"),
        path.join(extensionCwd, "src", "app-server", "client.test.ts"),
      ],
      extensionCwd,
    ),
  ).toEqual([
    flag,
    "codex/src/app-server/run-attempt.test.ts",
    "codex/src/app-server/client.test.ts",
  ]);
});

posixIt(
  "preserves wrapper termination when native Vitest exits cleanly after SIGTERM",
  ({ signal }) =>
    fixture.run(async () => {
      const root = tempDirs.make("openclaw-test-extension-signal-");
      const config = path.join(root, "vitest.config.mjs");
      const entry = path.join(root, "batch.mts");
      const childPidPath = path.join(root, "child.pid");
      const descendantPidPath = path.join(root, "descendant.pid");
      const signaledPath = path.join(root, "signaled");
      const pidPaths = [childPidPath, descendantPidPath];
      const readPids = () => pidPaths.map((file) => Number(readFileSync(file, "utf8")));
      let pids: number[] = [];

      writeFileSync(
        config,
        `import {spawn} from 'node:child_process';import fs from 'node:fs';
${fixtureReceiptClientSource(receipts.endpoint)}
process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(signaledPath)},'SIGTERM');process.exit(0)});
const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready');"],{stdio:['ignore','pipe','ignore']});
await new Promise(resolve=>descendant.stdout.once('data',resolve));
fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(descendant.pid));
fs.writeFileSync(${JSON.stringify(childPidPath)},String(process.pid));
sendReceipt(${JSON.stringify(childPidPath)}, "ready");
await new Promise(()=>{});export default {};`,
      );
      const batchRunnerUrl = resolveRuntimeWorkerUrl(scriptModuleEntrypoints.vitestBatchRunner);
      writeFileSync(
        entry,
        `import {runVitestBatch} from ${JSON.stringify(batchRunnerUrl.href)};process.exitCode=await runVitestBatch({config:${JSON.stringify(config)},args:['--configLoader=native'],targets:[]});`,
      );
      const runner = spawn(
        process.execPath,
        [...resolveRuntimeWorkerArgv(batchRunnerUrl).slice(0, -1), entry],
        { cwd: process.cwd(), stdio: "ignore" },
      );
      const runnerClosed = childTermination(runner);
      try {
        // The native config publishes both PIDs before the receipt. Its exit can
        // overtake that separate socket, so durable records decide an early close.
        await withinTest(
          Promise.race([
            receipts.waitFor(childPidPath, "ready"),
            runnerClosed.then(() => {
              if (!pidPaths.every(existsSync)) {
                throw new Error(`timeout waiting for pid in ${childPidPath}`);
              }
            }),
          ]),
          signal,
        );
        pids = readPids();
        expect(pids.map(Number.isInteger)).toEqual([true, true]);

        expect(runner.pid).toBeGreaterThan(0);
        process.kill(runner.pid!, "SIGTERM");
        const result = await withinTest(runnerClosed, signal);

        expect(result).toEqual({ code: null, signal: "SIGTERM" });
        // The config writes this synchronously before exiting, and the batch
        // runner joins the native process before re-raising its signal.
        expect(readFileSync(signaledPath, "utf8")).toBe("SIGTERM");
        await waitForProcessesExit(pids, signal);
      } finally {
        if (runner.pid && isProcessAlive(runner.pid)) {
          process.kill(runner.pid, "SIGTERM");
        }
        await runnerClosed;
        for (const pid of pids.length
          ? pids
          : pidPaths.filter(existsSync).map((file) => Number(readFileSync(file, "utf8")))) {
          if (pid && isProcessAlive(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      }
    }),
);

it("confines extension roots without selecting path lookalikes", async () => {
  const { result, runGroup } = await runSelectedExtensions(["policy", "file-transfer"], {
    env: {},
    vitestArgs: [],
  });
  expect(result).toBe(0);
  expect(runGroup).toHaveBeenCalledOnce();
  const invocation = firstInvocation(runGroup);
  const candidates = [
    "extensions/policy/src/example.test.ts",
    "extensions/file-transfer/src/shared/policy.test.ts",
    "extensions/other/src/policy/example.test.ts",
    "extensions/policy-extra/src/example.test.ts",
    "extensions/policy/src/example.test.tsx",
  ];
  expect(
    candidates.filter((file) =>
      matchesVitestCliSelection(
        file,
        ["extensions/**/*.test.ts"],
        ["run", "--config", invocation.config, ...invocation.args, ...invocation.targets],
        "extensions",
        invocation.env ?? {},
      ),
    ),
  ).toEqual([
    "extensions/policy/src/example.test.ts",
    "extensions/file-transfer/src/shared/policy.test.ts",
  ]);
});

it.each([
  { policy: "bun-all", nodeCode: 0, bunCode: 0 },
  {
    policy: "bun-all",
    nodeCode: 0,
    bunCode: 0,
    args: ["--reporter=dot", "--", "literal"],
  },
  { policy: "dual-all", nodeCode: 0, bunCode: 0 },
  { policy: "dual-all", nodeCode: 1, bunCode: 0 },
  { policy: "dual-all", nodeCode: 0, bunCode: 1 },
  { policy: "dual-all", nodeCode: 7, bunCode: 0 },
])("runs the complete extension selection with $policy ($nodeCode/$bunCode)", async (row) => {
  const calls: RunGroupParams[] = [];
  let completedNode = 0;
  const args = row.args ?? ["--reporter=dot"];
  vi.mocked(prepareVitestRuntime).mockClear();
  const result = await runExtensionBatchPlan(concurrentPlan(), {
    env: {
      OPENCLAW_CI_TEST_RUNTIME_POLICY: row.policy,
      OPENCLAW_VITEST_RUNTIME: "bun",
      OPENCLAW_EXTENSION_BATCH_PARALLEL: row.nodeCode === 7 ? "1" : "2",
    },
    vitestArgs: args,
    runGroup: async (invocation) => {
      calls.push(invocation);
      const bun = invocation.env?.OPENCLAW_VITEST_RUNTIME === "bun";
      if (bun && row.policy === "dual-all") {
        expect(completedNode).toBe(3);
      }
      await Promise.resolve();
      if (!bun) {
        completedNode += 1;
      }
      return bun ? row.bunCode : row.nodeCode;
    },
  });
  expect(result).toBe(row.nodeCode || row.bunCode);
  const node = calls.filter((call) => call.env?.OPENCLAW_VITEST_RUNTIME === "node");
  const bun = calls.filter((call) => call.env?.OPENCLAW_VITEST_RUNTIME === "bun");
  expect(node.map((call) => call.config)).toEqual(
    row.policy === "bun-all" ? [] : row.nodeCode === 7 ? ["light"] : ["heavy", "middle", "light"],
  );
  expect(bun.map((call) => call.config)).toEqual(
    row.nodeCode === 7 ? [] : ["heavy", "middle", "light"],
  );
  for (const call of bun) {
    expect(call.env?.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toMatch(/-bun$/u);
    expect(call.args.slice(-args.length)).toEqual(args);
    const sameOwner = node.find((entry) => entry.config === call.config);
    if (sameOwner) {
      expect(call.targets).toEqual(sameOwner.targets);
      expect(call.env?.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).not.toBe(
        sameOwner.env?.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH,
      );
    }
  }
  expect(prepareVitestRuntime).toHaveBeenCalledOnce();
  expect(vi.mocked(prepareVitestRuntime).mock.calls[0]?.[1]).toMatchObject({
    OPENCLAW_VITEST_RUNTIME: "node",
  });
});

it("preserves Codex process bounds with release options", async () => {
  const excluded = "extensions/codex/src/app-server/run-attempt.test.ts";
  const expectedFiles = [
    ...(await listVitestConfigTestFiles(extensionConfig("codex"))),
    ...(await listVitestConfigTestFiles(extensionConfig("database-workers"))).filter((file) =>
      file.startsWith("extensions/codex/"),
    ),
  ]
    .filter((file) => file !== excluded)
    .map(withoutExtensionRoot);

  const { result, runGroup } = await runSelectedExtensions(["codex"], {
    vitestArgs: ["--retry", "1", `--exclude=${excluded}`],
    env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "node" },
  });

  expect(result).toBe(0);
  const calls = runGroup.mock.calls.map(([params]) => params);
  const workerCount = expectedFiles.filter((file) =>
    databaseWorkerExtensionTestFiles.includes(`extensions/${file}`),
  ).length;
  expect(calls).toHaveLength(
    Math.ceil(workerCount / 12) + Math.ceil((expectedFiles.length - workerCount) / 24),
  );
  expect(calls.every((call) => call.targets.length <= 24)).toBe(true);
  expect(
    calls
      .filter((call) => call.config === extensionConfig("database-workers"))
      .every((call) => call.targets.length <= 12),
  ).toBe(true);
  expect(calls.flatMap((call) => call.targets).toSorted()).toEqual(expectedFiles.toSorted());
  expect(new Set(calls.flatMap((call) => call.targets)).size).toBe(expectedFiles.length);
  for (const call of calls) {
    expect(parseVitest(call.args).options).toMatchObject({
      retry: 1,
      exclude: ["codex/src/app-server/run-attempt.test.ts"],
    });
  }
});

it("runs every Matrix process chunk after an earlier chunk fails", async () => {
  const runGroup = vi
    .fn<(params: RunGroupParams) => Promise<number>>()
    .mockResolvedValueOnce(1)
    .mockResolvedValue(0);

  const result = await runExtensionBatchPlan(
    resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["matrix"] }),
    { runGroup, env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "node" } },
  );

  expect(result).toBe(1);
  expect(runGroup).toHaveBeenCalledTimes(expectedMatrixTestProcessCount());
});

it("keeps Matrix extension batch glob exclusions in one process", async () => {
  const { result, runGroup } = await runSelectedExtensions(["matrix"], {
    vitestArgs: ["--exclude=extensions/matrix/src/**"],
    env: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "node" },
  });

  expect(result).toBe(0);
  expect(runGroup).toHaveBeenCalledOnce();
  const invocation = firstInvocation(runGroup);
  expect(invocation).toMatchObject({
    targets: ["matrix/"],
    config: "test/vitest/vitest.database-worker-watch.config.ts",
    homeMode: "live-aware",
    env: { OPENCLAW_VITEST_DATABASE_WORKER_WATCH_OWNER: extensionConfig("matrix") },
  });
  expect(JSON.parse(invocation.env!.OPENCLAW_VITEST_DATABASE_WORKER_WATCH_TESTS!)).toEqual(
    databaseWorkerExtensionTestFiles.filter((file) => file.startsWith("extensions/matrix/")),
  );
});

it("prepares the selected Telegram leaves before the aggregate", async () => {
  const include = "extensions/telegram/src/sticker-cache.selection.test.ts";
  const includeFile = path.join(tempDirs.make("openclaw-extension-selection-"), "include.json");
  writeFileSync(includeFile, JSON.stringify([include]));
  vi.mocked(prepareVitestRuntime).mockClear();
  const env = { OPENCLAW_VITEST_INCLUDE_FILE: includeFile };
  const args = ["--watch"];
  const { result, runGroup } = await runSelectedExtensions(["telegram"], {
    env,
    vitestArgs: args,
  });
  expect(result).toBe(0);
  expect(runGroup).toHaveBeenCalledOnce();
  expect(prepareVitestRuntime).toHaveBeenCalledOnce();
  const [selections] = vi.mocked(prepareVitestRuntime).mock.calls[0]!;
  expect(resolveVitestPretestBuildMode(selections)).toBe("runtime");
  expect(firstInvocation(runGroup)).toMatchObject({
    env: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
    homeMode: "live-aware",
    args: relativizeExtensionVitestArgs(args),
  });
});

it.each([
  { allowEmptyAfterExclude: false, relative: true, expected: 1 },
  { allowEmptyAfterExclude: true, relative: false, expected: 0 },
])(
  "handles empty exact excludes (allow=$allowEmptyAfterExclude, relative=$relative)",
  async ({ allowEmptyAfterExclude, relative, expected }) => {
    const { result, runGroup } = await runSelectedExtensions(["firecrawl"], {
      allowEmptyAfterExclude,
      vitestArgs: listExtensionTestFiles("firecrawl").flatMap((file) => [
        "--exclude",
        relative ? withoutExtensionRoot(file) : file,
      ]),
    });
    expect(result).toBe(expected);
    expect(runGroup).not.toHaveBeenCalled();
  },
);

it("detects exact Vitest excludes in extension batch args", () => {
  expect([
    ...parseExactVitestExcludePaths([
      "--exclude",
      "extensions/codex/src/app-server/run-attempt.test.ts",
    ]),
  ]).toEqual(["extensions/codex/src/app-server/run-attempt.test.ts"]);
  expect([...parseExactVitestExcludePaths(["--exclude=extensions/**/*.test.ts"])]).toEqual([]);
});

it("reports single-plugin preparation rejection as infrastructure failure", () => {
  const result = runScriptResult(["firecrawl"], undefined, {
    ...process.env,
    OPENCLAW_EXTENSION_BATCH_PARALLEL: "invalid",
  });

  expect(result.stderr).toContain("OPENCLAW_EXTENSION_BATCH_PARALLEL must be a positive integer");
  expect(result.status, result.stdout + result.stderr).toBe(2);
});
// Native Vitest owns these handles and its group join accepts terminal zombies.
// Preserve the stronger absent-PID assertion until reaping, bounded only by cancellation.
async function waitForProcessesExit(pids: number[], signal: AbortSignal): Promise<void> {
  while (pids.some(isProcessAlive)) {
    try {
      await delay(5, undefined, { signal });
    } catch (cause) {
      throw new Error(`timed out waiting for condition: processes ${pids.join(", ")} exited`, {
        cause,
      });
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
