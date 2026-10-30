import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VitestBatchRunParams } from "../../scripts/lib/vitest-batch-runner.mts";
import {
  listVitestRuntimeConsumerFiles,
  resolveVitestCliEntry,
} from "../../scripts/lib/vitest-build-prerequisites.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { createPatternFileHelper } from "../helpers/pattern-file.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createInfraVitestConfig } from "../vitest/vitest.infra.config.ts";
import { createToolingVitestConfig } from "../vitest/vitest.tooling.config.ts";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";
import { createControlledWorkerCompiler } from "./vitest-worker-artifacts.test-support.js";

const commands = vi.hoisted(() => ({
  prepare: vi.fn(),
  prepareE2e: vi.fn(),
  reader: vi.fn(),
  uiAssets: vi.fn(),
  sourceLoader: vi.fn(),
  runtimeBuildId: "fixture-runtime",
  runtimeBuildInfoPresent: true,
}));
vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: commands.prepare,
}));
vi.mock("../../scripts/lib/vitest-build-prerequisites.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/vitest-build-prerequisites.mts")>()),
  prepareE2eVitestRuntime: commands.prepareE2e,
}));
vi.mock("../../scripts/run-vitest.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/run-vitest.mts")>()),
  spawnWatchedVitestProcess: commands.reader,
}));
vi.mock("../../scripts/lib/vitest-shard-timings.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/vitest-shard-timings.mts")>()),
  readShardTimings: () => new Map(),
  writeShardTimings: () => {},
}));
vi.mock("../../src/infra/control-ui-assets.ts", () => ({
  inspectControlUiRootAssets: commands.uiAssets,
}));
// Vitest owns source transforms here; native CLI cases cover tooling registration.
vi.mock("../../scripts/lib/tsx-cli-shim.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/tsx-cli-shim.mjs")>()),
  registerToolingTsx: commands.sourceLoader,
}));

const { runManagedCommand: runCliCommand } = await vi.importActual<
  typeof import("../../scripts/lib/managed-child-process.mts")
>("../../scripts/lib/managed-child-process.mts");

const modelTarget = "src/agents/embedded-agent-runner/model-resolution-consistency.test.ts";
const targets = [modelTarget, "extensions/qa-lab/src/suite-process-lifecycle.test.ts"];
const lifecycle = targets[1]!;
const ordinaryQa = "extensions/qa-lab/src/gateway-child.test.ts";
const qaRuntimeConsumers = listVitestRuntimeConsumerFiles([configPath("extension-qa")]);
const patternFiles = createPatternFileHelper("plugin-build-selection-");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const e2eTarget = "test/openclaw-launcher-version.e2e.test.ts";
const e2eConfig = configPath("e2e");
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let terminal: ReturnType<typeof createDeferred<unknown>>;
const testProjectsUrl = new URL("../../scripts/test-projects.mts", import.meta.url).href;
let startCount = 0;
function configPath(name: string) {
  return `test/vitest/vitest.${name}.config.ts`;
}
const runVitest = "scripts/run-vitest.mts";
const scoped = (file: string) => file.replace("extensions/", "");
const excludeQa = (transform = (file: string) => file) =>
  qaRuntimeConsumers.flatMap((file) => ["--exclude", transform(file)]);
const excludeConsumers = (config: string) =>
  listVitestRuntimeConsumerFiles([configPath(config)]).flatMap((file) => ["--exclude", file]);
const noExit = async () => {};
const configArgs = (config: string, ...args: string[]) => ["--config", configPath(config), ...args];
const runConfig = (config: string, ...args: string[]) => ["run", ...configArgs(config, ...args)];
const currentRuntimeArgs = ["scripts/prepare-vitest-runtime.mjs", "--require-current-head"];
const uiBuildArgs = ["scripts/ui.js", "build"];
async function expectPassed(pattern = /^\[test\] passed /u) {
  const outcome = await terminal.promise;
  if (outcome instanceof Error) {
    throw outcome;
  }
  expect(outcome).toMatch(pattern);
}
function stubEnv(values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    vi.stubEnv(name, value);
  }
}
type Completion = { code: number | null; signal: NodeJS.Signals | null; groupJoined: boolean };
function makeReader(completion: Promise<Completion>) {
  return { completion, getForwardedSignal: () => undefined };
}
const completedReader = (groupJoined = true) =>
  makeReader(Promise.resolve({ code: 0, signal: null, groupJoined }));
const preparationArgs = () => commands.prepare.mock.calls.map(([command]) => command.args);
function waitForAdmission(started: Promise<unknown>, running: Promise<unknown>, label: string) {
  return withTestTimeout(Promise.race([started, running]), 5_000, label);
}
function runPlan(config: string, forwardedArgs: string[] = [], timingTargets?: string[]) {
  return {
    config,
    forwardedArgs,
    includePatterns: null,
    watchMode: false,
    ...(timingTargets ? { timingTargets } : {}),
  };
}
function expectPrivateQaPreparation() {
  expect(commands.prepare).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      args: ["scripts/prepare-vitest-runtime.mjs"],
      env: expect.objectContaining({ OPENCLAW_BUILD_PRIVATE_QA: "1" }),
    }),
  );
}
type ReaderInput = { env: NodeJS.ProcessEnv; pnpmArgs: string[] };
async function assertSchedulerDrain({
  args,
  firstOutcome,
  expected,
  rejects,
  reusePeer = false,
  observe,
}: {
  args: string[];
  firstOutcome: Completion | Error;
  expected: number;
  rejects: boolean;
  reusePeer?: boolean;
  observe?: (input: ReaderInput) => void;
}) {
  const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
  const first = createDeferred<Completion>();
  const peer = createDeferred<Completion>();
  const admitted = createDeferred();
  const joined = { code: 0, signal: null, groupJoined: process.platform !== "win32" };
  let settled = false;
  commands.reader.mockImplementation((input) => {
    observe?.(input);
    const index = commands.reader.mock.calls.length;
    if (index === 2) {
      admitted.resolve();
    }
    return makeReader(
      index === 1
        ? first.promise
        : index === 2 || reusePeer
          ? peer.promise
          : Promise.resolve(joined),
    );
  });
  const running = runTestProjects(noExit, args).finally(() => {
    settled = true;
  });
  const checked = rejects ? expect(running).rejects.toThrow() : running;
  try {
    await waitForAdmission(admitted.promise, running, "scheduler admission");
    expect(commands.reader).toHaveBeenCalledTimes(2);
    if (firstOutcome instanceof Error) {
      first.reject(firstOutcome);
    } else {
      first.resolve(firstOutcome);
    }
    await nextTurn();
    expect(commands.reader).toHaveBeenCalledTimes(expected);
    expect(settled).toBe(false);
  } finally {
    first.resolve(joined);
    peer.resolve(joined);
    await checked;
  }
  expect(commands.reader).toHaveBeenCalledTimes(expected);
}

beforeEach(() => {
  const env = testRunnerFixtureEnv();
  for (const name of ["CI", "GITHUB_ACTIONS", "OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE"]) {
    vi.stubEnv(name, env[name]);
  }
  commands.prepare.mockReset().mockResolvedValue(0);
  commands.prepareE2e.mockReset().mockResolvedValue({ OPENCLAW_E2E_USE_PREBUILT_DIST: "1" });
  commands.uiAssets.mockReset().mockReturnValue({ kind: "ready", indexPath: "fixture-index" });
  commands.sourceLoader.mockReset().mockResolvedValue(undefined);
  commands.runtimeBuildId = "fixture-runtime";
  commands.runtimeBuildInfoPresent = true;
  const readFileSync = fs.readFileSync;
  const existsSync = fs.existsSync;
  const buildInfoPath = path.resolve(import.meta.dirname, "../../dist/build-info.json");
  vi.spyOn(fs, "existsSync").mockImplementation((file) =>
    file === buildInfoPath ? commands.runtimeBuildInfoPresent : existsSync(file),
  );
  vi.spyOn(fs, "readFileSync").mockImplementation(
    (file, options?: BufferEncoding | fs.ReadFileSyncOptions | null) => {
      const readOptions = typeof options === "string" ? { encoding: options } : (options ?? {});
      // Mocked builders publish fixture metadata, never borrow the checkout's dist.
      if (file === buildInfoPath && readOptions.encoding === "utf8") {
        return JSON.stringify({ buildId: commands.runtimeBuildId });
      }
      return readFileSync(file, readOptions);
    },
  );
  commands.reader
    .mockReset()
    .mockImplementation(() => completedReader(process.platform !== "win32"));
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  process.exitCode = 0;
  stubEnv({
    OPENCLAW_TEST_PROJECTS_PARALLEL: "",
    OPENCLAW_BUILD_PRIVATE_QA: "",
    OPENCLAW_E2E_SKIP_BUILD: "",
    OPENCLAW_E2E_USE_PREBUILT_DIST: "",
    OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "",
    OPENCLAW_VITEST_INCLUDE_FILE: "",
  });
  terminal = createDeferred<unknown>();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((value: unknown) => {
    if (value instanceof Error || /^\[test\] (passed|failed|skipped) /u.test(String(value))) {
      terminal.resolve(value);
    }
  });
});

afterEach(() => {
  patternFiles.cleanup();
  process.argv = originalArgv;
  process.exitCode = originalExitCode ?? 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("CLI runtime admission", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;
  posixIt.for<[args: string[], implicitRoot?: boolean]>([
    [[ordinaryQa]],
    [["run", "src/utils"], true],
    [["watch", "src/config"], true],
    [configArgs("cli")],
    [configArgs("cli-process", ...excludeConsumers("cli-process"))],
    [
      configArgs(
        "gateway-server",
        ...[
          "server.acp-native-model.product.test.ts",
          "server-sidecar-retention.test.ts",
          "server.config-patch.test.ts",
          "server-runtime-subscriptions.test.ts",
        ].flatMap((file) => ["--exclude", file]),
      ),
    ],
    [["--config", "vitest.config.ts", "suite-process-lifecycle", "--exclude", scoped(lifecycle)]],
    [excludeQa(scoped)],
    [excludeQa((file) => path.resolve(file))],
    [["--root", "."]],
    [["--dir=extensions"]],
    [["--project", "extension-qa"]],
    [["--config", "custom.config.ts"]],
    [["list"]],
    [["--help"]],
    [["--version=true"]],
  ])(
    "leaves direct %j selection without runtime preparation",
    async ([args, implicitRoot], { signal, onTestFinished }) => {
      const lifetime = createFixtureLifetime();
      onTestFinished(() => lifetime.cleanup());
      await lifetime.run(async () => {
        const root = lifetime.createTempDir("plugin-build-direct-");
        const preload = path.join(root, "preload.mjs");
        fs.writeFileSync(
          preload,
          `import cp from 'node:child_process';
import { syncFixtureBuiltinExports } from ${JSON.stringify(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url).href)};
const spawn = cp.spawn;
cp.spawn = (bin, args, options) => spawn(process.execPath, ['-e',
  args.includes('scripts/prepare-vitest-runtime.mjs') ? 'process.exit(91)' : ''], options);
syncFixtureBuiltinExports();\n`,
        );
        const defaultConfigArgs =
          implicitRoot || args.includes("--config") ? [] : ["--config", configPath("extension-qa")];
        let child: ChildProcess | undefined;
        await lifetime.track(
          runCliCommand({
            bin: process.execPath,
            args: ["--import", preload, "scripts/run-vitest.mts", ...defaultConfigArgs, ...args],
            env: testRunnerFixtureEnv(),
            stdio: "ignore",
            signal,
            requireProcessTreeExit: true,
            onReady(owned) {
              child = owned;
            },
          }),
        );
        expect({ code: child?.exitCode, signal: child?.signalCode }).toEqual({
          code: 0,
          signal: null,
        });
      });
    },
  );
  posixIt.for([
    ["single", "scripts/test-extension.mts", []],
    ["batch", "scripts/test-extension-batch.mts", ["qa-lab,firecrawl"]],
    ["direct watch", runVitest, ["watch", `--config=${configPath("extension-qa")}`]],
    ["config short control", runVitest, ["run", "-c", configPath("extension-qa")]],
    ["config empty long", runVitest, ["run", "--config=", configPath("extension-qa")]],
    ["root config", runVitest, ["run", "--config", "vitest.config.ts"]],
    ["implicit root directory", runVitest, ["run", "src/config"], "runtime"],
    [
      "CLI process selective exclusion",
      runVitest,
      runConfig("cli-process", "--exclude", "src/cli/update-dry-run-state.process.test.ts"),
      "runtime",
    ],
    [
      "Codex delivery QA runtime",
      runVitest,
      runConfig("infra", "test/e2e/qa-lab/runtime/gateway-codex-delivery-cache.test.ts"),
      "private-qa",
    ],
    [
      "Gateway server selective exclusion",
      runVitest,
      runConfig("gateway-server", "--exclude", "server-sidecar-retention.test.ts"),
      "runtime",
    ],
    [
      "Windows cron process identity",
      runVitest,
      runConfig(
        "gateway-database-workers",
        "src/gateway/gateway-cron-process-identity.windows.test.ts",
      ),
      "runtime",
    ],
    ["aggregate config", runVitest, runConfig("full-extensions")],
  ] as const)(
    "blocks %s CLI readers until successful build and preserves SIGTERM",
    async ([_name, script, args, mode = "private-qa"], { signal, onTestFinished }) => {
      const lifetime = createFixtureLifetime();
      onTestFinished(() => lifetime.cleanup());
      await lifetime.run(async () => {
        const outcomes = [0, 7, "SIGTERM"] as const;
        // Rows share hooks and module state; only their independent process trees overlap.
        const results = await Promise.allSettled(
          outcomes.map(async (outcome) => {
            const root = lifetime.createTempDir("plugin-build-cli-");
            const pidFile = path.join(root, "build.pid");
            const readersFile = path.join(root, "readers");
            const builder = path.join(root, "build.mjs");
            const preload = path.join(root, "preload.mjs");
            const workerCompiler = createControlledWorkerCompiler(
              root,
              testRunnerFixtureEnv({ OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" }),
              process.versions.bun ? "bun" : "node",
            );
            fs.writeFileSync(
              builder,
              `import fs from 'node:fs';
process.on('SIGTERM', () => process.exit(0));
process.stdin.once('data', () => process.exit(${typeof outcome === "number" ? outcome : 0}));
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.resume();
process.stdout.write('fixture-build-ready\\n');\n`,
            );
            // Keep the real managed process owner and CLI scheduler. Replace only
            // heavyweight build/test executables at Node's child-process boundary.
            fs.writeFileSync(
              preload,
              `import cp from 'node:child_process';
import fs from 'node:fs';
import { syncFixtureBuiltinExports } from ${JSON.stringify(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url).href)};
const spawn = cp.spawn;
cp.spawn = (bin, args, options) => {
  if (args.includes('scripts/prepare-vitest-runtime.mjs')) return spawn(process.execPath, [${JSON.stringify(builder)}], options);
  if (args.some((arg) => arg === 'vitest' || arg.endsWith('/vitest.mjs'))) {
    fs.appendFileSync(${JSON.stringify(readersFile)}, 'reader\\n');
    return spawn(process.execPath, ['-e', ''], options);
  }
  return spawn(bin, args, options);
};
syncFixtureBuiltinExports();\n`,
            );
            const finished = new AbortController();
            const ready = createDeferred();
            let child: ChildProcess | undefined;
            let output = "";
            let stdout = "";
            const closed = lifetime.track(
              runCliCommand({
                bin: process.execPath,
                args: ["--import", preload, path.resolve(script), ...args],
                cwd: _name === "single" ? path.resolve("extensions/qa-lab") : process.cwd(),
                env: workerCompiler.env,
                stdio: ["pipe", "pipe", "pipe"],
                signal: AbortSignal.any([signal, finished.signal]),
                requireProcessTreeExit: true,
                onReady(owned) {
                  child = owned;
                  owned.stdout!.on("data", (data) => {
                    output += data;
                    stdout += data;
                    if (stdout.includes("fixture-build-ready\n")) {
                      ready.resolve();
                    }
                  });
                  owned.stderr!.on("data", (data) => {
                    output += data;
                  });
                },
              }),
            );
            try {
              await Promise.race([
                ready.promise,
                closed.then((code) => {
                  throw new Error(`CLI exited before builder readiness (${code}):\n${output}`);
                }),
              ]);
              const buildPid = Number(fs.readFileSync(pidFile, "utf8"));
              expect(Number.isInteger(buildPid)).toBe(true);
              expect(buildPid).toBeGreaterThan(0);
              expect(fs.existsSync(readersFile), `outcome=${outcome}`).toBe(false);
              if (outcome === "SIGTERM") {
                expect(child!.kill("SIGTERM")).toBe(true);
              } else {
                child!.stdin!.end("finish\n");
              }
              await closed;
              expect(
                { code: child?.exitCode, signal: child?.signalCode },
                `outcome=${outcome}\n${output}`,
              ).toEqual({
                code: outcome === "SIGTERM" ? 143 : outcome,
                signal: null,
              });
              expect(fs.existsSync(readersFile), `outcome=${outcome}\n${output}`).toBe(
                outcome === 0,
              );
              expect(
                output.match(new RegExp(`preparing ${mode} runtime`, "gu")),
                `outcome=${outcome}`,
              ).toHaveLength(1);
              await lifetime.verifyCleanup(async () => {
                expect(isProcessAlive(buildPid)).toBe(false);
                if (_name === "root config" && outcome === 0) {
                  const compilations = workerCompiler.read();
                  expect(compilations).toHaveLength(1);
                  expect(isProcessAlive(compilations[0]!.pid)).toBe(false);
                  expect(fs.existsSync(compilations[0]!.directory)).toBe(false);
                }
              });
            } finally {
              finished.abort();
              await Promise.allSettled([closed]);
            }
          }),
        );
        for (const [index, result] of results.entries()) {
          expect.soft(result, `outcome=${outcomes[index]}`).toEqual({
            status: "fulfilled",
            value: undefined,
          });
        }
      });
    },
  );
});

async function start(args: string[]) {
  process.argv = [process.execPath, "scripts/test-projects.mts", ...args];
  // Replay the command entry while retaining its immutable planner dependencies.
  const entryUrl = `${testProjectsUrl}?case=${startCount}`;
  startCount += 1;
  await import(entryUrl);
}

describe("full-suite timing metadata", () => {
  it("records inherited include selections without replacing whole-config history", async () => {
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_TIMINGS", "1");
    const timings = await import("../../scripts/lib/vitest-shard-timings.mts");
    const actual = await vi.importActual<
      typeof import("../../scripts/lib/vitest-shard-timings.mts")
    >("../../scripts/lib/vitest-shard-timings.mts");
    const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
    const root = tempDirs.make("inherited-timing-");
    const timingFile = path.join(root, "timings.json");
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_TIMINGS_PATH", timingFile);
    vi.stubEnv("OPENCLAW_VITEST_SHARD_NAME", "same-parent");
    const config = configPath("tooling");
    actual.writeShardTimings([actual.createShardTimingSample({ config }, 999_999)], root);
    const writeTimings = vi
      .spyOn(timings, "writeShardTimings")
      .mockImplementation(actual.writeShardTimings);
    commands.reader.mockImplementation(() => completedReader());
    const files = ["test/scripts/run-with-env.test.ts", "test/scripts/run-node.test.ts"];
    for (const file of files) {
      const includeFile = patternFiles.writePatternFile("timing-include.json", [file]);
      vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", includeFile);
      await runTestProjects(noExit, [config]);
      expect(fs.existsSync(includeFile)).toBe(true);
      expect(commands.reader.mock.lastCall?.[0].env.OPENCLAW_VITEST_INCLUDE_FILE).toBe(includeFile);
    }
    const inheritedFile = process.env.OPENCLAW_VITEST_INCLUDE_FILE;
    fs.writeFileSync(inheritedFile!, "{}");
    await runTestProjects(noExit, [files[0]!]);
    const inlineFile = commands.reader.mock.lastCall?.[0].env.OPENCLAW_VITEST_INCLUDE_FILE;
    expect(inlineFile).not.toBe(inheritedFile);
    expect(fs.existsSync(inheritedFile!)).toBe(true);
    expect(fs.existsSync(inlineFile)).toBe(false);
    const planner = await import("../../scripts/test-projects.test-support.mts");
    const empty = vi.spyOn(planner, "buildFullSuiteVitestRunPlans").mockReturnValue([]);
    await runTestProjects(noExit, []);
    empty.mockRestore();
    expect(commands.reader).toHaveBeenCalledTimes(3);
    const samples = writeTimings.mock.calls.flatMap(([entries]) => entries);
    expect(samples).toHaveLength(3);
    expect(new Set(samples.map((sample) => sample?.config)).size).toBe(3);
    expect(samples.every((sample) => sample?.includePatternCount === 1)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(timingFile, "utf8")).configs;
    expect(stored[config].averageMs).toBe(999_999);
    expect(Object.keys(stored)).toHaveLength(4);
    vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", "");
    const cliConfig = configPath("cli");
    await runTestProjects(noExit, [cliConfig]);
    expect(writeTimings.mock.lastCall?.[0]).toEqual([
      expect.objectContaining({ config: cliConfig, includePatternCount: 0 }),
    ]);
  });

  it.each([false, true])(
    "carries chunk targets without changing launch selection (inherited=%s)",
    async (inherited) => {
      vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "2");
      vi.stubEnv("OPENCLAW_VITEST_MAX_WORKERS", "1");
      vi.stubEnv("OPENCLAW_VITEST_SHARD_NAME", "same-parent");
      vi.stubEnv("OPENCLAW_VITEST_ENABLE_MAGLEV", "0");
      const planner = await import("../../scripts/test-projects.test-support.mts");
      const timings = await import("../../scripts/lib/vitest-shard-timings.mts");
      const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
      const files = ["test/scripts/run-with-env.test.ts", "test/scripts/run-node.test.ts"];
      const includeFile = inherited
        ? patternFiles.writePatternFile("chunk-include.json", [files[0]!])
        : undefined;
      if (includeFile) {
        vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", includeFile);
      }
      const config = configPath("tooling");
      vi.spyOn(planner, "buildFullSuiteVitestRunPlans").mockReturnValue(
        files.map((file) => runPlan(config, [file], [file])),
      );
      const writeTimings = vi.spyOn(timings, "writeShardTimings");
      commands.reader.mockImplementation(() => completedReader());

      await runTestProjects(noExit, []);

      expect(commands.reader).toHaveBeenCalledTimes(2);
      const launches = commands.reader.mock.calls.map(([input]) => input);
      expect(launches.map((input) => input.pnpmArgs)).toEqual(
        files.map((file) => [
          "exec",
          "node",
          "--no-maglev",
          "--no-concurrent-sparkplug",
          resolveVitestCliEntry(),
          "run",
          "--config",
          config,
          file,
        ]),
      );
      for (const input of launches) {
        if (includeFile) {
          expect(input.env.OPENCLAW_VITEST_INCLUDE_FILE).toBe(includeFile);
        } else {
          expect(input.env.OPENCLAW_VITEST_INCLUDE_FILE).toBeFalsy();
        }
        expect(input.env.OPENCLAW_VITEST_MAX_WORKERS).toBe("1");
      }
      expect(writeTimings).toHaveBeenCalledTimes(1);
      const samples = writeTimings.mock.calls[0]?.[0] ?? [];
      expect(samples).toHaveLength(2);
      expect(new Set(samples.map((sample) => sample?.config)).size).toBe(2);
      for (const sample of samples) {
        expect(sample).toMatchObject({ baseConfig: config, includePatternCount: 1 });
      }
    },
  );
});

describe("packed config continuation", () => {
  const configs = [configPath("logging"), configPath("process")];
  it.each([
    { platform: "linux", code: 1, expected: 2 },
    { platform: "win32", code: 1, expected: 2 },
    { ci: "", code: 1, expected: 1 },
    { ci: "", optIn: "0", code: 1, expected: 1 },
    { ci: "", optIn: "1", code: 1, expected: 2 },
    { optIn: "0", code: 1, expected: 2 },
    { ci: "", optIn: "1", code: 2, expected: 1 },
    { code: null, expected: 1 },
    { code: 1, timeout: true, expected: 1 },
    { code: 1, signaled: true, expected: 1 },
    { code: 1, unjoined: true, expected: 1 },
    { code: 1, rejected: true, expected: 1 },
  ])("preserves complete selection and failure status for %j", async (scenario) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(
      scenario.platform === "win32" ? "win32" : "linux",
    );
    stubEnv({
      CI: scenario.ci ?? "1",
      OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
      OPENCLAW_VITEST_SHARD_NAME: "serial-fixture",
      OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: "",
      OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "",
      OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE: scenario.optIn ?? "",
    });
    const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
    const selected: string[] = [];
    commands.reader.mockImplementation(({ pnpmArgs, onNoOutputTimeout }) => {
      const first = selected.length === 0;
      selected.push(pnpmArgs[pnpmArgs.indexOf("--config") + 1]);
      if (first && scenario.timeout) {
        onNoOutputTimeout();
      }
      return {
        completion:
          first && scenario.rejected
            ? Promise.reject(new Error("child completion rejected"))
            : Promise.resolve({
                code: first ? scenario.code : 0,
                signal: first && scenario.signaled ? "SIGTERM" : null,
                groupJoined: scenario.platform !== "win32" && !(first && scenario.unjoined),
              }),
        getForwardedSignal: () => undefined,
      };
    });
    const exit = vi.fn(async () => {});
    const running = runTestProjects(exit, configs);
    if (scenario.rejected) {
      await expect(running).rejects.toThrow("child completion rejected");
    } else {
      await running;
    }
    if (scenario.ci !== "") {
      expect(console.error).toHaveBeenCalledWith("[test] inner parallelism 1");
    }
    expect(selected).toEqual(configs.slice(0, scenario.expected));
    if (scenario.signaled) {
      expect(exit).toHaveBeenCalledWith("SIGTERM");
    } else if (!scenario.rejected) {
      expect(process.exitCode).toBe(scenario.code === null || scenario.timeout ? 2 : scenario.code);
    }
  });
});

describe("empty changed selection", () => {
  it.each([
    { paths: [], diagnostic: "[test] no changed test targets; skipping Vitest." },
    {
      paths: ["unknown/file.txt"],
      diagnostic: "[test] no precise changed test targets; skipping Vitest.",
    },
  ])("keeps one selection and its diagnostics for $paths", async ({ paths, diagnostic }) => {
    const lanes = await import("../../scripts/changed-lanes.mts");
    const changedPaths = vi.spyOn(lanes, "listChangedPathsFromGit").mockReturnValue(paths);
    const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
    await runTestProjects(noExit, ["--changed", "origin/main"], {
      ...testRunnerFixtureEnv(),
      OPENCLAW_TEST_CHANGED_BROAD: "0",
    });
    expect(changedPaths).toHaveBeenCalledTimes(1);
    expect(commands.reader).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(diagnostic);
    if (paths.length > 0) {
      expect(console.error).toHaveBeenCalledWith("[test]   unknown/file.txt");
      expect(console.error).toHaveBeenCalledWith(
        "[test] run `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` for broad coverage.",
      );
    }
    expect(process.exitCode).toBe(0);
  });
});

describe("automatic exact-target admission", () => {
  const outputArgs = ["--reporter=dot", "--coverage.enabled=false"];
  const files = [
    modelTarget,
    "test/scripts/run-node-lifecycle.test.ts",
    "extensions/memory-lancedb/config.test.ts",
  ];
  beforeEach(async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    stubEnv({
      CI: "1",
      GITHUB_ACTIONS: "",
      OPENCLAW_TEST_PROJECTS_SERIAL: "",
      OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: "",
      OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "",
      OPENCLAW_VITEST_MAX_WORKERS: "2",
    });
    vi.spyOn(os, "availableParallelism").mockReturnValue(8);
    vi.spyOn(os, "totalmem").mockReturnValue(24 * 1024 ** 3);
    const planner = await import("../../scripts/test-projects.test-support.mts");
    expect(planner.findUnmatchedExplicitTestTargets(files, process.cwd())).toEqual([]);
  });

  it.each([
    { expected: 2 },
    { changed: true, expected: 2 },
    { changed: true, serial: "1", expected: 1 },
    { ci: "true", expected: 2 },
    { args: [], expected: 1 },
    { args: ["--coverage"], expected: 1 },
    { args: ["--outputFile=report.json"], expected: 1 },
    { args: ["--reporter=html"], expected: 1 },
    { args: ["--reporters=html"], expected: 1 },
    { args: ["--reporter=./custom-reporter.mjs"], expected: 1 },
    { ci: "", expected: 1 },
    { cpus: 4, expected: 1 },
    { gib: Number.NaN, expected: 1 },
    { parallel: "3", expected: 3 },
    { serial: "1", expected: 1 },
    { portable: true, expected: 1 },
    { callerLeaf: true, expected: 1 },
  ])(
    "preserves resolved specs and policy for %j",
    async ({ ci, cpus, gib, parallel, serial, portable, callerLeaf, args, changed, expected }) => {
      vi.stubEnv("CI", ci ?? "1");
      vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", parallel ?? "");
      vi.stubEnv("OPENCLAW_TEST_PROJECTS_SERIAL", serial ?? "");
      if (portable) {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      }
      if (callerLeaf) {
        const root = tempDirs.make("caller-cache-");
        vi.stubEnv("OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT", root);
        vi.stubEnv("OPENCLAW_VITEST_FS_MODULE_CACHE_PATH", path.join(root, "leaf"));
      }
      vi.mocked(os.availableParallelism).mockReturnValue(cpus ?? 8);
      vi.mocked(os.totalmem).mockReturnValue((gib ?? 24) * 1024 ** 3);
      const planner = await import("../../scripts/test-projects.test-support.mts");
      const changedPaths = changed
        ? vi
            .spyOn(await import("../../scripts/changed-lanes.mts"), "listChangedPathsFromGit")
            .mockReturnValue(files)
        : undefined;
      const produced = vi.spyOn(planner, "createVitestRunSpecs");
      const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
      const selections: Array<{ config: string; include: string[] | null; workers: string }> = [];
      let active = 0;
      let peak = 0;
      commands.reader.mockImplementation(({ env, pnpmArgs }) => {
        selections.push({
          config: pnpmArgs[pnpmArgs.indexOf("--config") + 1],
          include: env.OPENCLAW_VITEST_INCLUDE_FILE
            ? JSON.parse(fs.readFileSync(env.OPENCLAW_VITEST_INCLUDE_FILE, "utf8"))
            : null,
          workers: env.OPENCLAW_VITEST_MAX_WORKERS,
        });
        active += 1;
        peak = Math.max(peak, active);
        return makeReader(
          nextTurn().then(() => {
            active -= 1;
            return { code: 0, signal: null, groupJoined: !portable };
          }),
        );
      });
      await runTestProjects(noExit, [
        ...(changed ? ["--changed", "origin/main"] : files),
        ...(args ?? outputArgs),
      ]);
      const specs = produced.mock.results[0]!.value as ReturnType<
        typeof planner.createVitestRunSpecs
      >;
      expect(specs.length).toBeGreaterThanOrEqual(3);
      if (changed) {
        expect(changedPaths).toHaveBeenCalledTimes(1);
        expect(specs.some((spec) => spec.pnpmArgs.includes("--passWithNoTests=false"))).toBe(false);
      }
      expect(peak).toBe(expected);
      const actual = selections.map(({ config, include }) => ({ config, include }));
      expect(actual.flatMap(({ include }) => include ?? []).toSorted()).toEqual(files.toSorted());
      const planned = specs.map((spec) => ({ config: spec.config, include: spec.includePatterns }));
      // Explicit parallelism retains its timing order; automatic admission keeps native plan order.
      expect(
        parallel ? actual.toSorted((a, b) => a.config.localeCompare(b.config)) : actual,
      ).toEqual(parallel ? planned.toSorted((a, b) => a.config.localeCompare(b.config)) : planned);
      expect(selections.every(({ workers }) => workers === "2")).toBe(true);
      expect(process.exitCode).toBe(0);
    },
  );

  it.each([
    { outcome: "success", mode: "automatic" },
    { outcome: "failure", mode: "automatic" },
    { outcome: "SIGTERM", mode: "automatic" },
    { outcome: "success", mode: "explicit parallel" },
    { outcome: "success", mode: "full suite" },
    { outcome: "success", mode: "local full suite" },
  ])(
    "joins the real Gateway plan barrier before later admission and disposal ($mode, $outcome)",
    async ({ outcome, mode }) => {
      const workerOwner = await import("../../scripts/lib/vitest-worker-run.mts");
      const original = workerOwner.createVitestWorkerRun;
      const events: string[] = [];
      vi.spyOn(workerOwner, "createVitestWorkerRun").mockImplementation((...args) => {
        const worker = original(...args);
        const dispose = worker.dispose.bind(worker);
        vi.spyOn(worker, "dispose").mockImplementation(async () => {
          events.push("dispose");
          await dispose();
          events.push("disposed");
        });
        return worker;
      });
      const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
      if (mode === "local full suite") {
        vi.stubEnv("CI", "");
        vi.stubEnv("GITHUB_ACTIONS", "");
        vi.stubEnv("OPENCLAW_VITEST_MAX_WORKERS", "");
        vi.stubEnv("OPENCLAW_TEST_WORKERS", "");
      }
      const gatewayFile =
        mode === "automatic"
          ? "src/gateway/call.test.ts"
          : "src/gateway/server.sessions.fixture-lifecycle.test.ts";
      const barrierFiles = ["src/utils.test.ts", gatewayFile, modelTarget];
      const configs = [
        configPath("unit-fast-fake-timers"),
        mode === "automatic" ? configPath("gateway") : configPath("gateway-server"),
        configPath("agents-embedded-agent"),
      ];
      const planner = await import("../../scripts/test-projects.test-support.mts");
      expect(planner.findUnmatchedExplicitTestTargets(barrierFiles, process.cwd())).toEqual([]);
      expect(
        planner.buildVitestRunPlans([...barrierFiles, ...outputArgs]).map(({ config }) => config),
      ).toEqual(configs);
      if (mode !== "automatic") {
        vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "3");
        // Hold the ordinary/Gateway/ordinary order; timing weights have separate coverage.
        vi.spyOn(planner, "orderFullSuiteSpecsForParallelRun").mockImplementation((specs) => specs);
      }
      if (mode.endsWith("full suite")) {
        vi.spyOn(planner, "buildFullSuiteVitestRunPlans").mockReturnValue(
          configs.map((config, index) =>
            runPlan(config, [...outputArgs, barrierFiles[index]!], [barrierFiles[index]!]),
          ),
        );
      }
      const releases = configs.map(() => createDeferred());
      const admissions = configs.map(() => createDeferred());
      const selected: string[] = [];
      commands.reader.mockImplementation(({ pnpmArgs, env }) => {
        const config = pnpmArgs[pnpmArgs.indexOf("--config") + 1];
        const index = configs.indexOf(config);
        expect(index).toBeGreaterThanOrEqual(0);
        if (mode === "local full suite") {
          expect(env.OPENCLAW_VITEST_MAX_WORKERS).toBe(index === 1 ? "3" : "1");
        }
        selected.push(config);
        events.push(`start:${index}`);
        admissions[index]!.resolve();
        return makeReader(
          releases[index]!.promise.then(() => {
            events.push(`joined:${index}`);
            return {
              code: index === 1 && outcome === "failure" ? 1 : 0,
              signal: index === 1 && outcome === "SIGTERM" ? "SIGTERM" : null,
              groupJoined: true,
            };
          }),
        );
      });
      const exit = vi.fn(async () => {});
      const running = runTestProjects(
        exit,
        mode.endsWith("full suite") ? outputArgs : [...barrierFiles, ...outputArgs],
      );
      try {
        for (let index = 0; index < 2; index++) {
          await waitForAdmission(admissions[index]!.promise, running, "barrier admission");
          expect(selected).toEqual(configs.slice(0, index + 1));
          expect(events).not.toContain("dispose");
          releases[index]!.resolve();
        }
        if (outcome !== "SIGTERM") {
          await waitForAdmission(admissions[2]!.promise, running, "post-barrier admission");
          expect(events).toEqual(["start:0", "joined:0", "start:1", "joined:1", "start:2"]);
        }
      } finally {
        releases.forEach((release) => release.resolve());
        await running;
      }
      expect(selected).toEqual(outcome === "SIGTERM" ? configs.slice(0, 2) : configs);
      expect(events.slice(-3)).toEqual([
        `joined:${outcome === "SIGTERM" ? 1 : 2}`,
        "dispose",
        "disposed",
      ]);
      expect(exit.mock.calls).toEqual(outcome === "SIGTERM" ? [["SIGTERM"]] : []);
      expect(process.exitCode).toBe(outcome === "SIGTERM" ? 143 : outcome === "failure" ? 1 : 0);
    },
  );

  it.each(["failure", "unjoined", "rejection", "signal"])(
    "drains peers and admits later exact-target specs only after an ordinary %s",
    async (outcome) => {
      await assertSchedulerDrain({
        args: [...files, ...outputArgs],
        expected: outcome === "failure" ? 3 : 2,
        rejects: outcome === "unjoined" || outcome === "rejection",
        reusePeer: true,
        firstOutcome:
          outcome === "rejection"
            ? new Error("child join rejected")
            : {
                code: outcome === "unjoined" ? 0 : 1,
                signal: outcome === "signal" ? "SIGTERM" : null,
                groupJoined: outcome !== "unjoined",
              },
      });
      if (outcome === "failure") {
        expect(process.exitCode).toBe(1);
        expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[test\] failed 3 /u));
      }
      if (outcome === "signal") {
        expect(process.exitCode).toBe(143);
      }
    },
  );
});

describe("cache lease completion", () => {
  beforeEach(() => {
    // The enclosing CI test worker owns its PATH; these fixtures exercise a new scheduler.
    vi.stubEnv("OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT", "");
    vi.stubEnv("OPENCLAW_VITEST_FS_MODULE_CACHE_PATH", "");
  });

  it.each(["linux", "win32"] as const)(
    "preserves %s policy after an unverified preflight completion",
    async (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "2");
      const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
      let preflights = 0;
      let attempts = 0;
      commands.reader.mockImplementation(({ pnpmArgs }) => {
        if (pnpmArgs.includes("scripts/ensure-playwright-chromium.mts")) {
          preflights += 1;
        } else if (pnpmArgs.includes(configPath("ui-e2e"))) {
          attempts += 1;
        }
        return completedReader(false);
      });
      const running = runTestProjects(noExit, [configPath("ui-e2e"), configPath("cli")]);
      if (platform === "win32") {
        await expect(running).resolves.toBeUndefined();
        expect(attempts).toBe(1);
      } else {
        await expect(running).rejects.toMatchObject({
          errors: [
            expect.objectContaining({
              message: "Cannot continue a Vitest cache lease without verified group completion",
            }),
          ],
        });
        expect(attempts).toBe(0);
      }
      expect(preflights).toBe(1);
    },
  );

  it.each([
    { signal: "SIGTERM", code: 143 },
    { signal: null, code: 143 },
    { signal: null, code: 0 },
    { signal: null, code: 1 },
  ] as const)(
    "fails on the first no-output timeout without retrying (signal=$signal, code=$code)",
    async ({ signal, code }) => {
      vi.stubEnv("CI", "true");
      vi.stubEnv("OPENCLAW_VITEST_NO_OUTPUT_RETRY", "1");
      const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
      const exitBySignal = vi.fn(async () => {});
      commands.reader
        .mockImplementationOnce(({ onNoOutputTimeout }) => {
          onNoOutputTimeout();
          return makeReader(Promise.resolve({ code, signal, groupJoined: true }));
        })
        .mockImplementation(() => completedReader());

      await runTestProjects(exitBySignal, [configPath("cli")]);

      expect(process.exitCode).toBe(code === 0 || code === 1 ? 2 : 143);
      expect(commands.reader).toHaveBeenCalledTimes(1);
      expect(exitBySignal).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[test\] failed /u));
      expect(console.error).not.toHaveBeenCalledWith(expect.stringMatching(/^\[test\] passed /u));
    },
  );

  it.each([
    { platform: "linux", concurrency: 1 },
    { platform: "linux", concurrency: 2 },
    { platform: "win32", concurrency: 1 },
    { platform: "win32", concurrency: 2 },
  ] as const)(
    "preserves $platform cache ownership through preflight and execution (concurrency=$concurrency)",
    async ({ platform, concurrency }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const cacheRoot = tempDirs.make("cache-policy-");
      vi.stubEnv("OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT", cacheRoot);
      vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", String(concurrency));
      const planner = await import("../../scripts/test-projects.test-support.mts");
      const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
      if (concurrency === 1) {
        vi.spyOn(planner, "buildFullSuiteVitestRunPlans").mockReturnValue(
          [configPath("ui-e2e"), configPath("cli"), configPath("ui-e2e")].map((config) =>
            runPlan(config),
          ),
        );
      }
      const firstPreflight = createDeferred<Completion>();
      const firstExecution = createDeferred<Completion>();
      const peer = createDeferred<Completion>();
      const started = createDeferred();
      const executionStarted = createDeferred();
      const paths: string[] = [];
      const uiPaths: string[] = [];
      let peerPath: string | undefined;
      let preflights = 0;
      let attempts = 0;
      const joined = { code: 0, signal: null, groupJoined: platform !== "win32" };
      commands.reader.mockImplementation(({ env, pnpmArgs }) => {
        const cache = env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH;
        paths.push(cache);
        let completion;
        if (pnpmArgs.includes("scripts/ensure-playwright-chromium.mts")) {
          uiPaths.push(cache);
          preflights += 1;
          completion = preflights === 1 ? firstPreflight.promise : Promise.resolve(joined);
        } else if (pnpmArgs.includes(configPath("ui-e2e"))) {
          uiPaths.push(cache);
          attempts += 1;
          completion = attempts === 1 ? firstExecution.promise : Promise.resolve(joined);
          executionStarted.resolve();
        } else {
          peerPath = cache;
          completion = peer.promise;
        }
        if (paths.length === (concurrency === 1 ? 1 : 2)) {
          started.resolve();
        }
        return makeReader(completion);
      });
      const running = runTestProjects(
        noExit,
        concurrency === 1 ? [] : [configPath("ui-e2e"), configPath("cli")],
      );
      try {
        await withTestTimeout(started.promise, 5_000, "preflight and peer admission");
        expect(new Set(paths).size).toBe(concurrency);
        for (const cache of paths) {
          const relative = path.relative(cacheRoot, cache);
          expect(relative).not.toBe("");
          expect(path.isAbsolute(relative)).toBe(false);
          expect(relative.split(path.sep)).not.toContain("..");
        }
        firstPreflight.resolve(joined);
        await withTestTimeout(executionStarted.promise, 5_000, "execution admission");
        expect(uiPaths).toHaveLength(2);
        expect(new Set(uiPaths).size).toBe(1);
        expect(uiPaths).not.toContain(peerPath);
        expect(attempts).toBe(1);
      } finally {
        firstPreflight.resolve(joined);
        firstExecution.resolve(joined);
        peer.resolve(joined);
        await running;
      }
      expect(uiPaths).toHaveLength(concurrency === 1 ? 4 : 2);
      expect(new Set(uiPaths.slice(0, 2)).size).toBe(1);
      if (concurrency === 1) {
        expect(new Set(uiPaths.slice(2)).size).toBe(1);
        if (platform === "win32") {
          expect(uiPaths[2]).not.toBe(uiPaths[0]);
        } else {
          expect(uiPaths[2]).toBe(uiPaths[0]);
        }
      }
      expect(uiPaths).not.toContain(peerPath);
      expect(preflights).toBe(concurrency === 1 ? 2 : 1);
      expect(attempts).toBe(concurrency === 1 ? 2 : 1);
      expect(process.exitCode).toBe(0);
    },
  );

  it.each([
    { outcome: "failure", scope: "local", expected: 3 },
    { outcome: "infrastructure", scope: "local", expected: 2 },
    { outcome: "infrastructure", scope: "ci-continued", expected: 2 },
    { outcome: "signal", scope: "local", expected: 2 },
    { outcome: "rejection", scope: "local", expected: 2 },
    { outcome: "failure", scope: "ci-focused", expected: 3 },
    { outcome: "failure", scope: "ci-full-suite", expected: 3 },
  ])(
    "joins admitted work after $outcome without confusing failure with cleanup ($scope)",
    async ({ outcome, scope, expected }) => {
      const groupJoined = process.platform !== "win32";
      const focused = scope === "ci-focused";
      const configs = [
        configPath("unit-fast"),
        configPath("unit-fast-fake-timers"),
        configPath("cli"),
      ];
      const databaseConfig = configPath("extension-database-workers");
      const files = [
        "extensions/telegram/src/polling-session.test.ts",
        "extensions/telegram/src/telegram-ingress-drain.test.ts",
        "extensions/telegram/src/webhook.test.ts",
      ];
      vi.stubEnv("CI", scope === "local" ? "" : "1");
      vi.stubEnv("GITHUB_ACTIONS", "");
      vi.stubEnv("OPENCLAW_VITEST_SHARD_NAME", scope === "local" ? "" : "selected-envelope");
      vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "2");
      vi.stubEnv("OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE", "");
      if (focused) {
        vi.stubEnv(
          "OPENCLAW_VITEST_INCLUDE_FILE",
          patternFiles.writePatternFile("focused-ci.json", files),
        );
      }
      if (scope === "ci-full-suite") {
        const planner = await import("../../scripts/test-projects.test-support.mts");
        vi.spyOn(planner, "buildFullSuiteVitestRunPlans").mockReturnValue(
          configs.map((config) => runPlan(config)),
        );
      }
      const selections: unknown[] = [];
      await assertSchedulerDrain({
        args: focused ? [databaseConfig] : scope === "ci-full-suite" ? [] : configs,
        expected,
        rejects: outcome === "rejection",
        firstOutcome:
          outcome === "rejection"
            ? new Error("unverified group completion")
            : {
                code: outcome === "infrastructure" ? 2 : 1,
                signal: outcome === "signal" ? "SIGTERM" : null,
                groupJoined,
              },
        observe: ({ env, pnpmArgs }) => {
          if (focused) {
            expect(pnpmArgs[pnpmArgs.indexOf("--config") + 1]).toBe(databaseConfig);
            const includeFile = env.OPENCLAW_VITEST_INCLUDE_FILE;
            assert(includeFile, "Expected focused Vitest selection file");
            selections.push(JSON.parse(fs.readFileSync(includeFile, "utf8")));
          }
        },
      });
      if (focused) {
        expect(console.error).toHaveBeenCalledWith("[test] inner parallelism 2");
        const selected = selections.flat();
        expect(
          selections.every((selection) => Array.isArray(selection) && selection.length === 1),
        ).toBe(true);
        expect(new Set(selected).size).toBe(expected);
        expect(files).toEqual(expect.arrayContaining(selected));
        if (expected === files.length) {
          expect(selected).toEqual(expect.arrayContaining(files));
        }
      }
      if (outcome !== "rejection") {
        expect(process.exitCode).toBe(
          outcome === "signal" ? 143 : outcome === "infrastructure" ? 2 : 1,
        );
      }
    },
  );
});

function createPreparationGate<T>(prepare: typeof commands.prepare) {
  const started = createDeferred();
  const result = createDeferred<T>();
  prepare.mockImplementation(() => {
    started.resolve();
    return result.promise;
  });
  // Import completion does not imply admission; observe the preparation owner.
  return { ...result, started: started.promise };
}

describe("test-projects build admission", () => {
  const toolingConfig = configPath("tooling");
  const infraConfig = configPath("infra");
  const ordinaryTooling = "test/scripts/run-vitest-state-cleanup.test.ts";
  const runtimeTooling = "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts";
  const privateQaInfra = "test/e2e/qa-lab/runtime/gateway-codex-delivery-cache.test.ts";
  const uiConfig = configPath("ui-e2e");
  const avatarTarget = "ui/src/e2e/chat-agent-avatar.real-gateway.e2e.test.ts";
  const mockUiTarget = "ui/src/e2e/chat-code-block-fences.e2e.test.ts";

  it.each(["test/e2e/line-doctor-group-allowlist.built-cli.e2e.test.ts"])(
    "prepares cold UI before admitting the real Doctor fixture %s",
    async (target) => {
      const runtime = createPreparationGate<NodeJS.ProcessEnv>(commands.prepareE2e);
      const ui = createPreparationGate<number>(commands.prepare);
      commands.uiAssets.mockReturnValueOnce({ kind: "missing-index", indexPath: null });
      const entry = start([target]);
      try {
        await Promise.race([runtime.started, entry]);
        expect(commands.uiAssets).not.toHaveBeenCalled();
        expect(commands.reader).not.toHaveBeenCalled();
        runtime.resolve({ OPENCLAW_E2E_USE_PREBUILT_DIST: "1" });
        await Promise.race([ui.started, entry]);
        expect(commands.reader).not.toHaveBeenCalled();
        expect(commands.prepare.mock.lastCall?.[0].args).toEqual(uiBuildArgs);
      } finally {
        runtime.resolve({ OPENCLAW_E2E_USE_PREBUILT_DIST: "1" });
        ui.resolve(0);
        await entry;
      }
      await expectPassed();
      expect(commands.reader).toHaveBeenCalled();
    },
  );

  it.each(["ready", "missing", "failed", "skip"])(
    "handles prebuilt Doctor UI with no runtime build-info: %s",
    async (state) => {
      const target = "test/e2e/line-doctor-group-allowlist.built-cli.e2e.test.ts";
      commands.runtimeBuildInfoPresent = false;
      commands.prepareE2e.mockResolvedValue({ OPENCLAW_E2E_USE_PREBUILT_DIST: "1" });
      if (state === "skip") {
        vi.stubEnv("OPENCLAW_E2E_SKIP_BUILD", "1");
      } else if (state !== "ready") {
        commands.uiAssets.mockReturnValueOnce({ kind: "missing-index", indexPath: null });
      }
      commands.prepare.mockResolvedValue(state === "failed" ? 7 : 0);
      await start([target]);
      await terminal.promise;
      if (state === "skip") {
        expect(commands.uiAssets).not.toHaveBeenCalled();
      } else {
        expect(commands.uiAssets).toHaveBeenCalledWith(path.resolve("dist/control-ui"), null);
      }
      expect(commands.prepare).toHaveBeenCalledTimes(["missing", "failed"].includes(state) ? 1 : 0);
      if (state === "missing") {
        expect(
          commands.prepare.mock.lastCall?.[0].env.OPENCLAW_CONTROL_UI_BUILD_ID,
        ).toBeUndefined();
      }
      expect(commands.reader).toHaveBeenCalledTimes(state === "failed" ? 0 : 1);
      expect(process.exitCode).toBe(state === "failed" ? 7 : 0);
    },
  );

  it.each([false, true])(
    "holds Gateway readers behind the matching UI build (mixed E2E=%s)",
    async (mixed) => {
      const runtime = createPreparationGate<number | NodeJS.ProcessEnv>(
        mixed ? commands.prepareE2e : commands.prepare,
      );
      let assetBuildId = "previous-runtime";
      commands.runtimeBuildId = assetBuildId;
      commands.uiAssets.mockImplementation((_root, expectedBuildId) =>
        assetBuildId === expectedBuildId
          ? { kind: "ready", indexPath: "fixture-index" }
          : { kind: "stale", indexPath: "fixture-index", buildId: assetBuildId },
      );
      const entry = start(mixed ? [e2eTarget, avatarTarget] : [avatarTarget]);
      let ui: ReturnType<typeof createPreparationGate<number>> | undefined;
      try {
        await Promise.race([runtime.started, entry]);
        ui = createPreparationGate<number>(commands.prepare);
        if (mixed) {
          // E2E reuse still needs the UI's stricter current-head preparation.
          commands.prepare.mockResolvedValueOnce(0);
        }
        expect(commands.reader).not.toHaveBeenCalled();
        expect(commands.uiAssets).not.toHaveBeenCalled();
        commands.runtimeBuildId = "rebuilt-runtime";
        runtime.resolve(mixed ? { OPENCLAW_E2E_USE_PREBUILT_DIST: "1" } : 0);
        await Promise.race([ui.started, entry]);
        expect(commands.reader).not.toHaveBeenCalled();
        expect(commands.prepare.mock.lastCall?.[0]).toMatchObject({
          args: uiBuildArgs,
        });
        expect(commands.uiAssets).toHaveBeenCalledWith(
          path.resolve("dist/control-ui"),
          "rebuilt-runtime",
        );
        assetBuildId = commands.prepare.mock.lastCall?.[0].env.OPENCLAW_CONTROL_UI_BUILD_ID;
      } finally {
        runtime.resolve(mixed ? { OPENCLAW_E2E_USE_PREBUILT_DIST: "1" } : 0);
        ui?.resolve(0);
        await entry;
      }
      await expectPassed();
      expect(commands.prepareE2e).toHaveBeenCalledTimes(mixed ? 1 : 0);
      expect(preparationArgs()).toEqual([currentRuntimeArgs, uiBuildArgs]);
      expect(commands.uiAssets).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBe(0);
    },
  );

  it.each(["nonzero", "still stale"])(
    "admits no UI readers after a %s UI build",
    async (outcome) => {
      commands.uiAssets.mockReturnValue({
        kind: "stale",
        indexPath: "fixture-index",
        buildId: "previous-runtime",
      });
      commands.prepare.mockImplementation(async ({ args }) =>
        args[0] === "scripts/ui.js" && outcome === "nonzero" ? 7 : 0,
      );
      await start([avatarTarget]);
      await terminal.promise;
      expect(commands.reader).not.toHaveBeenCalled();
      expect(preparationArgs()).toEqual([currentRuntimeArgs, uiBuildArgs]);
      expect(process.exitCode).toBe(outcome === "nonzero" ? 7 : 2);
      if (outcome === "still stale") {
        expect(await terminal.promise).toMatchObject({
          message: "Control UI setup left stale assets for runtime fixture-runtime",
        });
      }
    },
  );

  it.each([false, true])(
    "retains cancellation between runtime preparation and UI admission (mixed E2E=%s)",
    async (mixed) => {
      const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
      const existingListeners = new Set(process.listeners("SIGTERM"));
      const source = createPreparationGate<void>(commands.sourceLoader);
      const exitBySignal = vi.fn(async () => {});
      const running = runTestProjects(
        exitBySignal,
        mixed ? [e2eTarget, avatarTarget] : [avatarTarget],
      );
      const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
      try {
        await waitForAdmission(source.started, running, "source loader admission");
        const listeners = process
          .listeners("SIGTERM")
          .filter((listener) => !existingListeners.has(listener));
        expect(listeners).toHaveLength(1);
        listeners[0]!.call(process, "SIGTERM");
      } finally {
        source.resolve();
        await rejected;
      }
      expect(preparationArgs()).toEqual([currentRuntimeArgs]);
      expect(commands.uiAssets).not.toHaveBeenCalled();
      expect(commands.reader).not.toHaveBeenCalled();
      expect(exitBySignal).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      expect(process.listeners("SIGTERM")).toEqual([...existingListeners]);
    },
  );

  it.each<{
    args: string[];
    include?: string[];
    flag?: string;
    build: boolean;
  }>([
    { args: [avatarTarget], build: true },
    { args: [uiConfig], include: [avatarTarget], build: true },
    {
      args: [uiConfig],
      include: ["extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts"],
      build: true,
    },
    { args: [uiConfig], include: [], build: false },
    { args: [uiConfig], include: [mockUiTarget], build: false },
    { args: [mockUiTarget], include: [avatarTarget], build: false },
    { args: [avatarTarget], include: [], build: true },
    {
      args: [avatarTarget, "--", "--exclude", avatarTarget],
      build: false,
    },
    ...[
      "OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY",
      "OPENCLAW_E2E_SKIP_BUILD",
      "OPENCLAW_E2E_USE_PREBUILT_DIST",
    ].map((flag) => ({ args: [avatarTarget], flag, build: false })),
  ])("prepares only selected Gateway assets: %j", async ({ args, include, build, flag }) => {
    if (include) {
      vi.stubEnv(
        "OPENCLAW_VITEST_INCLUDE_FILE",
        patternFiles.writePatternFile("ui-include.json", include),
      );
    }
    if (flag) {
      vi.stubEnv(flag, "1");
    }
    await start(args);
    await expectPassed();
    expect(commands.prepare).toHaveBeenCalledTimes(build ? 1 : 0);
    expect(commands.uiAssets).toHaveBeenCalledTimes(build ? 1 : 0);
    expect(
      commands.prepare.mock.calls.some(([command]) => command.args[0] === "scripts/ui.js"),
    ).toBe(false);
  });

  it.each<[target: string, build: boolean, include?: string[]]>([
    [toolingConfig, false, [ordinaryTooling]],
    [toolingConfig, true, [runtimeTooling]],
    [infraConfig, true, [privateQaInfra]],
    [toolingConfig, false, []],
    [toolingConfig, true],
    [ordinaryTooling, false, [runtimeTooling]],
    [runtimeTooling, true, [ordinaryTooling]],
    [runtimeTooling, true, []],
  ])(
    "prepares only the effective config selection: %s, build=%s, include=%j",
    async (target, build, include) => {
      const args = [target];
      const workerCompiler =
        args[0] === infraConfig
          ? createControlledWorkerCompiler(tempDirs.make("private-qa-worker-"), process.env)
          : undefined;
      if (workerCompiler) {
        commands.prepare.mockImplementation((command) =>
          path.basename(command.args[0]) === "vitest-worker-compiler.mts"
            ? runCliCommand({ ...command, args: workerCompiler.args(command.args[1]) })
            : Promise.resolve(0),
        );
      }
      const borrowed = include
        ? patternFiles.writePatternFile("borrowed.json", include)
        : undefined;
      const original = borrowed
        ? { bytes: fs.readFileSync(borrowed), stat: fs.statSync(borrowed) }
        : undefined;
      if (borrowed) {
        vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", borrowed);
      }
      const selected: unknown[] = [];
      commands.reader.mockImplementation(({ env, pnpmArgs }) => {
        const wrapperArgv = process.argv;
        // The config consumes the reader's CLI, not its parent wrapper's targets.
        process.argv = [
          process.execPath,
          ...pnpmArgs.slice(pnpmArgs.indexOf(resolveVitestCliEntry())),
        ];
        try {
          const createConfig =
            args[0] === infraConfig ? createInfraVitestConfig : createToolingVitestConfig;
          selected.push(createConfig(env).test?.include);
        } finally {
          process.argv = wrapperArgv;
        }
        return {
          completion: Promise.resolve({ code: 0, signal: null }),
          getForwardedSignal: () => undefined,
        };
      });

      await start(args);
      await expectPassed(/^\[test\] passed 1 Vitest shard/u);
      expect(commands.prepare).toHaveBeenCalledTimes((build ? 1 : 0) + (workerCompiler ? 1 : 0));
      if (workerCompiler) {
        expect(workerCompiler.read()).toHaveLength(1);
      }
      expect(commands.prepareE2e).not.toHaveBeenCalled();
      expect(commands.reader).toHaveBeenCalledOnce();
      expect(selected).toEqual([
        args[0] === infraConfig
          ? include
          : args[0] === toolingConfig
            ? (include ?? ["test/**/*.test.ts", "src/scripts/**/*.test.ts"])
            : args,
      ]);
      if (borrowed && original) {
        expect(fs.readFileSync(borrowed)).toEqual(original.bytes);
        expect(fs.statSync(borrowed)).toMatchObject({
          ino: original.stat.ino,
          mtimeMs: original.stat.mtimeMs,
        });
        const readerInclude = commands.reader.mock.calls[0]![0].env.OPENCLAW_VITEST_INCLUDE_FILE;
        if (args[0] === toolingConfig || args[0] === infraConfig) {
          expect(readerInclude).toBe(borrowed);
        } else {
          expect(readerInclude).not.toBe(borrowed);
          expect(fs.existsSync(readerInclude)).toBe(false);
        }
      }
    },
  );

  it.each([
    { args: ["--help=true"], prepare: false },
    { args: ["--help", "false"], prepare: true },
    { args: ["--no-help"], prepare: true },
    { args: ["--version"], prepare: true },
    { args: ["--watch=false"], prepare: true },
    { args: ["--listTags"], prepare: false },
    { args: ["--clearCache"], prepare: false },
    { args: ["--mergeReports", "reports"], prepare: false },
    { args: ["--unknownOption"], prepare: false },
    { args: ["--passWithNoTests", "--passWithNoTests"], prepare: false },
    { args: ["--configLoader=", "runner"], prepare: true },
    { args: ["--isolate=", "false"], prepare: true },
  ])("admits preparation from native controls only: $args", async ({ args, prepare }) => {
    await start([lifecycle, "--", ...args]);
    await terminal.promise;
    expect(commands.reader).toHaveBeenCalledOnce();
    expect(commands.prepare).toHaveBeenCalledTimes(prepare ? 1 : 0);
    expect(commands.prepareE2e).not.toHaveBeenCalled();
    expect(Boolean(commands.reader.mock.calls[0]![0].workerRun)).toBe(prepare);
  });

  it.each([
    { parallel: false, outcome: "success", e2e: false },
    { parallel: true, outcome: "success", e2e: false },
    { parallel: false, outcome: "exit", e2e: false },
    { parallel: false, outcome: "throw", e2e: false },
    { parallel: false, outcome: "throw", e2e: true },
  ])("admits readers only after successful preparation: %j", async ({ parallel, outcome, e2e }) => {
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", parallel ? "2" : "");
    const preparation = createPreparationGate<number | NodeJS.ProcessEnv>(
      e2e ? commands.prepareE2e : commands.prepare,
    );
    const readers = createDeferred<{ code: number; signal: null }>();
    const readersStarted = createDeferred();
    commands.reader.mockImplementation(() => {
      if (commands.reader.mock.calls.length === (parallel ? 2 : 1)) {
        readersStarted.resolve();
      }
      return { completion: readers.promise, getForwardedSignal: () => undefined };
    });
    const entry = start(e2e ? [...targets, e2eTarget] : targets);
    try {
      await Promise.race([preparation.started, entry]);
      expect(commands.reader).not.toHaveBeenCalled();
      if (!e2e) {
        expectPrivateQaPreparation();
      }
      if (outcome === "throw") {
        preparation.reject(new Error(e2e ? "E2E build failed" : "build failed"));
      } else {
        preparation.resolve(outcome === "exit" ? 7 : 0);
      }
      if (outcome === "success") {
        await Promise.race([readersStarted.promise, entry]);
        expect(commands.reader).toHaveBeenCalledTimes(parallel ? 2 : 1);
      }
    } finally {
      preparation.resolve(0);
      readers.resolve({ code: 0, signal: null });
      await entry;
    }
    if (outcome === "success") {
      await expectPassed(/^\[test\] passed 2 Vitest shards/u);
      expect(commands.reader).toHaveBeenCalledTimes(2);
    } else {
      expect(commands.reader).not.toHaveBeenCalled();
    }
    if (e2e) {
      expect(commands.prepare).not.toHaveBeenCalled();
    }
    expect(process.exitCode).toBe(outcome === "success" ? 0 : outcome === "exit" ? 7 : 2);
  });

  it.each(["", "OPENCLAW_E2E_SKIP_BUILD", "OPENCLAW_E2E_USE_PREBUILT_DIST"])(
    "coalesces mixed E2E preparation and preserves prebuilt ownership (flag=%s)",
    async (flag) => {
      vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", flag ? "" : "2");
      if (flag) {
        vi.stubEnv(flag, "1");
      }
      const preparation = createPreparationGate<NodeJS.ProcessEnv>(commands.prepareE2e);
      const entry = start([
        ...targets,
        e2eTarget,
        ...(flag ? [] : ["packages/sdk/src/app-sdk-external-boundary.e2e.test.ts"]),
      ]);
      try {
        await Promise.race([preparation.started, entry]);
        expect(commands.prepareE2e).toHaveBeenCalledOnce();
        expect(commands.prepare).not.toHaveBeenCalled();
        expect(commands.reader).not.toHaveBeenCalled();
      } finally {
        preparation.resolve(flag ? {} : { OPENCLAW_E2E_USE_PREBUILT_DIST: "1" });
        await entry;
      }
      await expectPassed(/^\[test\] passed 3 Vitest shards/u);
      if (flag) {
        expect(commands.prepareE2e).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ [flag]: "1" }),
        );
      }
      expect(commands.prepare).not.toHaveBeenCalled();
      expect(commands.reader).toHaveBeenCalledTimes(3);
      for (const [options] of commands.reader.mock.calls) {
        expect(options.env[flag || "OPENCLAW_E2E_USE_PREBUILT_DIST"]).toBe(
          flag || options.pnpmArgs.includes(e2eConfig) ? "1" : "",
        );
      }
    },
  );
});

describe("plugin batch build admission", () => {
  const qaConfig = configPath("extension-qa");
  const databaseConfig = configPath("extension-database-workers");
  const combinedConfig = configPath("database-worker-watch");

  it.each([
    { parallel: "1", outcome: 0 },
    { parallel: "2", outcome: 0 },
    { parallel: "2", outcome: 7 },
    { parallel: "2", outcome: 143 },
    { parallel: "2", outcome: "throw" },
  ] as const)(
    "holds batch readers behind preparation (parallel=$parallel, outcome=$outcome)",
    async ({ parallel, outcome }) => {
      const { resolveExtensionBatchPlan, createExtensionTestProcessTargetChunks } =
        await import("../../scripts/lib/extension-test-plan.mts");
      const { runExtensionBatchPlan } = await import("../../scripts/test-extension-batch-run.mts");
      const batch = resolveExtensionBatchPlan({
        extensionIds: outcome === 0 ? ["qa-lab", "matrix", "firecrawl"] : ["qa-lab", "matrix"],
      });
      const preparation = createPreparationGate<number>(commands.prepare);
      const reader = vi.fn().mockResolvedValue(0);
      const running = runExtensionBatchPlan(batch, {
        env: { OPENCLAW_EXTENSION_BATCH_PARALLEL: parallel },
        runGroup: reader,
      });
      const checked =
        outcome === "throw"
          ? expect(running).rejects.toThrow("build spawn failed")
          : expect(running).resolves.toBe(outcome);
      try {
        await Promise.race([preparation.started, running]);
        expect(reader).not.toHaveBeenCalled();
        expectPrivateQaPreparation();
      } finally {
        if (outcome === "throw") {
          preparation.reject(new Error("build spawn failed"));
        } else {
          preparation.resolve(outcome);
        }
        await checked;
      }
      if (outcome === 0) {
        expect(reader).toHaveBeenCalledTimes(
          batch.planGroups.reduce(
            (sum, group) =>
              sum + createExtensionTestProcessTargetChunks(group.config, group.roots).length,
            0,
          ),
        );
      } else {
        expect(reader).not.toHaveBeenCalled();
      }
      expect(commands.prepare).toHaveBeenCalledOnce();
    },
  );

  const qaConfigs = [databaseConfig, qaConfig];
  const combined = [combinedConfig];
  const runtime = "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts";
  type Selection = { ids?: string[]; args?: string[]; include?: string[] };
  it.each<[Selection, boolean, string[]]>([
    [{ ids: ["qa-lab"] }, true, qaConfigs],
    [{ ids: ["qa-channel"] }, false, qaConfigs],
    [{ ids: ["firecrawl"] }, false, [configPath("extension-misc")]],
    [{ args: [ordinaryQa] }, false, combined],
    [{ args: [lifecycle] }, true, combined],
    [{ args: [path.resolve(lifecycle)] }, true, combined],
    [{ args: ["--exclude", lifecycle] }, true, qaConfigs],
    [{ args: excludeQa() }, false, qaConfigs],
    [{ args: qaRuntimeConsumers.map((file) => `--exclude=${file}`) }, false, qaConfigs],
    [{ args: excludeQa(scoped) }, false, qaConfigs],
    [{ args: excludeQa((file) => path.resolve(file)) }, false, qaConfigs],
    [{ args: excludeQa((file) => `${path.posix.dirname(file)}/**/*.test.ts`) }, false, combined],
    [{ args: ["--exclude=extensions/qa-lab/**"] }, false, combined],
    [{ include: [] }, false, qaConfigs],
    [{ include: [ordinaryQa] }, false, qaConfigs],
    [{ include: [lifecycle] }, true, qaConfigs],
    [{ include: [path.resolve(lifecycle)] }, true, qaConfigs],
    [{ include: [scoped(lifecycle)] }, true, qaConfigs],
    [{ include: [runtime], args: [runtime] }, false, combined],
    [{ ids: ["qa-channel"], include: [lifecycle] }, false, qaConfigs],
    [{ ids: ["qa-channel"], args: [lifecycle], include: [lifecycle] }, true, combined],
    [{ args: [ordinaryQa], include: [lifecycle] }, true, combined],
    [
      { args: [ordinaryQa, "--exclude", "extensions/codex/src/app-server/run-attempt.test.ts"] },
      true,
      combined,
    ],
    [{ ids: [] }, false, []],
  ])(
    "prepares the actual invocation selection: %j, build=%s",
    async ({ ids = ["qa-lab"], args = [], include }, build, configs) => {
      const { resolveExtensionBatchPlan } =
        await import("../../scripts/lib/extension-test-plan.mts");
      const { runExtensionBatchPlan } = await import("../../scripts/test-extension-batch-run.mts");
      const env = include
        ? { OPENCLAW_VITEST_INCLUDE_FILE: patternFiles.writePatternFile("include.json", include) }
        : {};
      const reader = vi
        .fn<(params: VitestBatchRunParams) => Promise<number>>()
        .mockResolvedValue(0);
      await expect(
        runExtensionBatchPlan(resolveExtensionBatchPlan({ extensionIds: ids }), {
          runGroup: reader,
          env,
          vitestArgs: args,
        }),
      ).resolves.toBe(0);
      expect(commands.prepare).toHaveBeenCalledTimes(build ? 1 : 0);
      expect(reader.mock.calls.map(([invocation]) => invocation.config)).toEqual(configs);
    },
  );
});
