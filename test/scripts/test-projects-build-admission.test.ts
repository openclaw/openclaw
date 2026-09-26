import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
import { createToolingVitestConfig } from "../vitest/vitest.tooling.config.ts";
import { createControlledWorkerCompiler } from "./vitest-worker-artifacts.test-support.js";

const commands = vi.hoisted(() => ({ prepare: vi.fn(), prepareE2e: vi.fn(), reader: vi.fn() }));
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

const { runManagedCommand: runCliCommand } = await vi.importActual<
  typeof import("../../scripts/lib/managed-child-process.mts")
>("../../scripts/lib/managed-child-process.mts");

const modelTarget = "src/agents/embedded-agent-runner/model-resolution-consistency.test.ts";
const targets = [modelTarget, "extensions/qa-lab/src/suite-process-lifecycle.test.ts"];
const lifecycle = targets[1]!;
const ordinaryQa = "extensions/qa-lab/src/gateway-child.test.ts";
const patternFiles = createPatternFileHelper("plugin-build-selection-");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const e2eTarget = "test/openclaw-launcher-version.e2e.test.ts";
const nativeHostTarget = "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts";
const e2eConfig = "test/vitest/vitest.e2e.config.ts";
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let terminal: ReturnType<typeof createDeferred<unknown>>;
const testProjectsUrl = new URL("../../scripts/test-projects.mts", import.meta.url).href;
let startCount = 0;

beforeEach(() => {
  commands.prepare.mockReset();
  commands.prepareE2e.mockReset().mockResolvedValue({ OPENCLAW_E2E_USE_PREBUILT_DIST: "1" });
  commands.reader.mockReset().mockImplementation(() => ({
    completion: Promise.resolve({ code: 0, signal: null }),
    getForwardedSignal: () => undefined,
  }));
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  process.exitCode = 0;
  vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "");
  vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "");
  vi.stubEnv("OPENCLAW_E2E_SKIP_BUILD", "");
  vi.stubEnv("OPENCLAW_E2E_USE_PREBUILT_DIST", "");
  vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", "");
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
  posixIt.for<[name: string, args: string[]]>([
    ["ordinary target", [ordinaryQa]],
    ["ordinary CLI config", ["--config", "test/vitest/vitest.cli.config.ts"]],
    [
      "CLI process runtime exclusions",
      [
        "--config",
        "test/vitest/vitest.cli-process.config.ts",
        ...listVitestRuntimeConsumerFiles(["test/vitest/vitest.cli-process.config.ts"]).flatMap(
          (file) => ["--exclude", file],
        ),
      ],
    ],
    [
      "Gateway scoped exclusion",
      ["--config", "test/vitest/vitest.gateway-core.config.ts", "--exclude", "gateway-*.test.ts"],
    ],
    [
      "Gateway server scoped exclusion",
      [
        "--config",
        "test/vitest/vitest.gateway-server.config.ts",
        "--exclude",
        "server.acp-native-model.product.test.ts",
        "--exclude",
        "server-sidecar-retention.test.ts",
        "--exclude",
        "server.config-patch.test.ts",
      ],
    ],
    [
      "root scoped exclusion",
      [
        "--config",
        "vitest.config.ts",
        "suite-process-lifecycle",
        "--exclude",
        lifecycle.replace("extensions/", ""),
      ],
    ],
    ["scoped exclusion", ["--exclude", lifecycle.replace("extensions/", "")]],
    ["absolute exclusion", ["--exclude", path.resolve(lifecycle)]],
    ["alternate root", ["--root", "."]],
    ["alternate directory", ["--dir=extensions"]],
    ["project override", ["--project", "extension-qa"]],
    ["custom config", ["--config", "custom.config.ts"]],
    ["list command", ["list"]],
    ["help", ["--help"]],
    ["version only", ["--version=true"]],
    ["native invalid scalar", ["--passWithNoTests", "--passWithNoTests"]],
    ["native unknown option", ["--unknownOption"]],
  ])(
    "leaves direct $0 selection without runtime preparation",
    async ([_name, args], { signal, onTestFinished }) => {
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
  args.includes('scripts/run-node.mjs') ? 'process.exit(91)' : ''], options);
syncFixtureBuiltinExports();\n`,
        );
        const configArgs = args.includes("--config")
          ? []
          : ["--config", "test/vitest/vitest.extension-qa.config.ts"];
        let child: ChildProcess | undefined;
        await lifetime.track(
          runCliCommand({
            bin: process.execPath,
            args: ["--import", preload, "scripts/run-vitest.mts", ...configArgs, ...args],
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
    [
      "direct",
      "scripts/run-vitest.mts",
      ["run", "--config", "test/vitest/vitest.extension-qa.config.ts"],
    ],
    [
      "direct watch",
      "scripts/run-vitest.mts",
      ["watch", "--config=test/vitest/vitest.extension-qa.config.ts"],
    ],
    [
      "config short control",
      "scripts/run-vitest.mts",
      ["run", "-c", "test/vitest/vitest.extension-qa.config.ts"],
    ],
    [
      "config empty long",
      "scripts/run-vitest.mts",
      ["run", "--config=", "test/vitest/vitest.extension-qa.config.ts"],
    ],
    ["root config", "scripts/run-vitest.mts", ["run", "--config", "vitest.config.ts"]],
    [
      "CLI process",
      "scripts/run-vitest.mts",
      ["run", "--config", "test/vitest/vitest.cli-process.config.ts"],
      "runtime",
    ],
    [
      "CLI process selective exclusion",
      "scripts/run-vitest.mts",
      [
        "run",
        "--config",
        "test/vitest/vitest.cli-process.config.ts",
        "--exclude",
        "src/cli/update-dry-run-state.process.test.ts",
      ],
      "runtime",
    ],
    [
      "Codex delivery QA runtime",
      "scripts/run-vitest.mts",
      [
        "run",
        "--config",
        "test/vitest/vitest.tooling.config.ts",
        "test/e2e/qa-lab/runtime/gateway-codex-delivery-cache.test.ts",
      ],
      "private-qa",
    ],
    [
      "Gateway server selective exclusion",
      "scripts/run-vitest.mts",
      [
        "run",
        "--config",
        "test/vitest/vitest.gateway-server.config.ts",
        "--exclude",
        "server-sidecar-retention.test.ts",
      ],
      "runtime",
    ],
    [
      "Windows cron process identity",
      "scripts/run-vitest.mts",
      [
        "run",
        "--config",
        "test/vitest/vitest.gateway-database-workers.config.ts",
        "src/gateway/gateway-cron-process-identity.windows.test.ts",
      ],
      "runtime",
    ],
    [
      "aggregate config",
      "scripts/run-vitest.mts",
      ["run", "--config", "test/vitest/vitest.full-extensions.config.ts"],
    ],
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
              { ...process.env, OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" },
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
  if (args.includes('scripts/run-node.mjs')) return spawn(process.execPath, [${JSON.stringify(builder)}], options);
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
    const config = "test/vitest/vitest.tooling.config.ts";
    actual.writeShardTimings([actual.createShardTimingSample({ config }, 999_999)], root);
    const writeTimings = vi
      .spyOn(timings, "writeShardTimings")
      .mockImplementation(actual.writeShardTimings);
    commands.prepare.mockResolvedValue(0);
    commands.reader.mockImplementation(() => ({
      completion: Promise.resolve({ code: 0, signal: null, groupJoined: true }),
      getForwardedSignal: () => undefined,
    }));
    const files = ["test/scripts/run-with-env.test.ts", "test/scripts/run-node.test.ts"];
    for (const file of files) {
      const includeFile = patternFiles.writePatternFile("timing-include.json", [file]);
      vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", includeFile);
      await runTestProjects(async () => {}, [config]);
      expect(fs.existsSync(includeFile)).toBe(true);
      expect(commands.reader.mock.lastCall?.[0].env.OPENCLAW_VITEST_INCLUDE_FILE).toBe(includeFile);
    }
    const inheritedFile = process.env.OPENCLAW_VITEST_INCLUDE_FILE;
    fs.writeFileSync(inheritedFile!, "{}");
    await runTestProjects(async () => {}, [files[0]!]);
    const inlineFile = commands.reader.mock.lastCall?.[0].env.OPENCLAW_VITEST_INCLUDE_FILE;
    expect(inlineFile).not.toBe(inheritedFile);
    expect(fs.existsSync(inheritedFile!)).toBe(true);
    expect(fs.existsSync(inlineFile)).toBe(false);
    const planner = await import("../../scripts/test-projects.test-support.mts");
    const empty = vi.spyOn(planner, "buildFullSuiteVitestRunPlans").mockReturnValue([]);
    await runTestProjects(async () => {}, []);
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
    const cliConfig = "test/vitest/vitest.cli.config.ts";
    await runTestProjects(async () => {}, [cliConfig]);
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
      const config = "test/vitest/vitest.tooling.config.ts";
      vi.spyOn(planner, "buildFullSuiteVitestRunPlans").mockReturnValue(
        files.map((file) => ({
          config,
          forwardedArgs: [file],
          timingTargets: [file],
          includePatterns: null,
          watchMode: false,
        })),
      );
      const writeTimings = vi.spyOn(timings, "writeShardTimings");
      commands.prepare.mockResolvedValue(0);
      commands.reader.mockImplementation(() => ({
        completion: Promise.resolve({ code: 0, signal: null, groupJoined: true }),
        getForwardedSignal: () => undefined,
      }));

      await runTestProjects(async () => {}, []);

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
        } else if (pnpmArgs.includes("test/vitest/vitest.ui-e2e.config.ts")) {
          attempts += 1;
        }
        return {
          completion: Promise.resolve({ code: 0, signal: null, groupJoined: false }),
          getForwardedSignal: () => undefined,
        };
      });
      const running = runTestProjects(async () => {}, [
        "test/vitest/vitest.ui-e2e.config.ts",
        "test/vitest/vitest.cli.config.ts",
      ]);
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
          return {
            completion: Promise.resolve({ code, signal, groupJoined: true }),
            getForwardedSignal: () => undefined,
          };
        })
        .mockImplementation(() => ({
          completion: Promise.resolve({ code: 0, signal: null, groupJoined: true }),
          getForwardedSignal: () => undefined,
        }));

      await runTestProjects(exitBySignal, ["test/vitest/vitest.cli.config.ts"]);

      expect(process.exitCode).toBe(143);
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
          [
            "test/vitest/vitest.ui-e2e.config.ts",
            "test/vitest/vitest.cli.config.ts",
            "test/vitest/vitest.ui-e2e.config.ts",
          ].map((config) => ({
            config,
            forwardedArgs: [],
            includePatterns: null,
            watchMode: false,
          })),
        );
      }
      const firstPreflight = createDeferred<{ code: number; signal: null; groupJoined: boolean }>();
      const firstExecution = createDeferred<{ code: number; signal: null; groupJoined: boolean }>();
      const peer = createDeferred<{ code: number; signal: null; groupJoined: boolean }>();
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
        } else if (pnpmArgs.includes("test/vitest/vitest.ui-e2e.config.ts")) {
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
        return { completion, getForwardedSignal: () => undefined };
      });
      const running = runTestProjects(
        async () => {},
        concurrency === 1
          ? []
          : ["test/vitest/vitest.ui-e2e.config.ts", "test/vitest/vitest.cli.config.ts"],
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

  it.each(["failure", "signal", "rejection"])(
    "joins admitted work after %s without confusing failure with cleanup",
    async (outcome) => {
      const groupJoined = process.platform !== "win32";
      vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "2");
      commands.prepare.mockResolvedValue(0);
      const { runTestProjects } = await import("../../scripts/test-projects-run.mts");
      const first = createDeferred<{
        code: number;
        signal: NodeJS.Signals | null;
        groupJoined: boolean;
      }>();
      const second = createDeferred<{ code: number; signal: null; groupJoined: boolean }>();
      const admitted = createDeferred();
      const settled = { value: false };
      commands.reader.mockImplementation(() => {
        const index = commands.reader.mock.calls.length;
        if (index === 2) {
          admitted.resolve();
        }
        return {
          completion:
            index === 1
              ? first.promise
              : index === 2
                ? second.promise
                : Promise.resolve({ code: 0, signal: null, groupJoined }),
          getForwardedSignal: () => undefined,
        };
      });
      const running = runTestProjects(async () => {}, [
        "test/vitest/vitest.unit-fast.config.ts",
        "test/vitest/vitest.unit-fast-fake-timers.config.ts",
        "test/vitest/vitest.cli.config.ts",
      ]).finally(() => {
        settled.value = true;
      });
      const checked = outcome === "rejection" ? expect(running).rejects.toThrow() : running;
      try {
        await withTestTimeout(
          Promise.race([admitted.promise, running]),
          5_000,
          "scheduler admission",
        );
        expect(commands.reader).toHaveBeenCalledTimes(2);
        if (outcome === "rejection") {
          first.reject(new Error("unverified group completion"));
        } else {
          first.resolve({
            code: 1,
            signal: outcome === "signal" ? "SIGTERM" : null,
            groupJoined,
          });
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled.value).toBe(false);
        expect(commands.reader).toHaveBeenCalledTimes(outcome === "failure" ? 3 : 2);
      } finally {
        first.resolve({ code: 0, signal: null, groupJoined });
        second.resolve({ code: 0, signal: null, groupJoined });
        await checked;
      }
      if (outcome !== "rejection") {
        expect(process.exitCode).toBe(outcome === "signal" ? 143 : 1);
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
  const toolingConfig = "test/vitest/vitest.tooling.config.ts";
  const ordinaryTooling = "test/scripts/run-vitest-state-cleanup.test.ts";
  const runtimeTooling = "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts";
  const privateQaTooling = "test/e2e/qa-lab/runtime/gateway-codex-delivery-cache.test.ts";

  it.each([
    {
      name: "borrowed ordinary tooling",
      args: [toolingConfig],
      include: [ordinaryTooling],
      build: false,
    },
    {
      name: "borrowed runtime tooling",
      args: [toolingConfig],
      include: [runtimeTooling],
      build: true,
    },
    {
      name: "borrowed private-QA tooling",
      args: [toolingConfig],
      include: [privateQaTooling],
      build: true,
    },
    { name: "borrowed empty selection", args: [toolingConfig], include: [], build: false },
    { name: "whole config without an override", args: [toolingConfig], build: true },
    {
      name: "owned ordinary over borrowed runtime",
      args: [ordinaryTooling],
      include: [runtimeTooling],
      build: false,
    },
    {
      name: "owned runtime over borrowed ordinary",
      args: [runtimeTooling],
      include: [ordinaryTooling],
      build: true,
    },
    { name: "owned runtime over borrowed empty", args: [runtimeTooling], include: [], build: true },
  ])("prepares only the effective tooling selection: $name", async ({ args, include, build }) => {
    const borrowed = include ? patternFiles.writePatternFile("borrowed.json", include) : undefined;
    const original = borrowed
      ? { bytes: fs.readFileSync(borrowed), stat: fs.statSync(borrowed) }
      : undefined;
    if (borrowed) {
      vi.stubEnv("OPENCLAW_VITEST_INCLUDE_FILE", borrowed);
    }
    commands.prepare.mockResolvedValue(0);
    const selected: unknown[] = [];
    commands.reader.mockImplementation(({ env, pnpmArgs }) => {
      const wrapperArgv = process.argv;
      // The config consumes the reader's CLI, not its parent wrapper's targets.
      process.argv = [
        process.execPath,
        ...pnpmArgs.slice(pnpmArgs.indexOf(resolveVitestCliEntry())),
      ];
      try {
        selected.push(createToolingVitestConfig(env).test?.include);
      } finally {
        process.argv = wrapperArgv;
      }
      return {
        completion: Promise.resolve({ code: 0, signal: null }),
        getForwardedSignal: () => undefined,
      };
    });

    await start(args);
    expect(await terminal.promise).toMatch(/^\[test\] passed 1 Vitest shard/u);
    expect(commands.prepare).toHaveBeenCalledTimes(build ? 1 : 0);
    expect(commands.prepareE2e).not.toHaveBeenCalled();
    expect(commands.reader).toHaveBeenCalledOnce();
    expect(selected).toEqual([
      args[0] === toolingConfig
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
      if (args[0] === toolingConfig) {
        expect(readerInclude).toBe(borrowed);
      } else {
        expect(readerInclude).not.toBe(borrowed);
        expect(fs.existsSync(readerInclude)).toBe(false);
      }
    }
  });

  it.each([
    { args: ["--help=true"], prepare: false },
    { args: ["-uh"], prepare: false },
    { args: ["--help", "--help"], prepare: false },
    { args: ["--help", "false"], prepare: true },
    { args: ["--no-help"], prepare: true },
    { args: ["--version"], prepare: true },
    { args: ["--watch=false"], prepare: true },
    { args: ["--listTags"], prepare: false },
    { args: ["--clearCache"], prepare: false },
    { args: ["--mergeReports", "reports"], prepare: false },
    { args: ["--unknownOption"], prepare: false },
    { args: ["--passWithNoTests", "--passWithNoTests"], prepare: false },
    { args: ["--help=true"], target: "test/vitest/vitest.ui-e2e.config.ts", prepare: false },
    { args: ["--help=true"], target: e2eTarget, prepare: false },
    { args: ["--configLoader=", "runner"], prepare: true },
    { args: ["--isolate=", "false"], prepare: true },
  ])(
    "admits preparation from native controls only: $args",
    async ({ args, prepare, target = lifecycle }) => {
      commands.prepare.mockResolvedValue(0);
      await start([target, "--", ...args]);
      await terminal.promise;
      expect(commands.reader).toHaveBeenCalledOnce();
      expect(commands.prepare).toHaveBeenCalledTimes(prepare ? 1 : 0);
      expect(commands.prepareE2e).not.toHaveBeenCalled();
      expect(Boolean(commands.reader.mock.calls[0]![0].workerRun)).toBe(prepare);
    },
  );

  it.each([false, true])(
    "holds every reader until preparation completes (parallel=%s)",
    async (parallel) => {
      vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", parallel ? "2" : "");
      const preparation = createPreparationGate<number>(commands.prepare);
      const readers = createDeferred<{ code: number; signal: null }>();
      const readersStarted = createDeferred();
      commands.reader.mockImplementation(() => {
        if (commands.reader.mock.calls.length === (parallel ? 2 : 1)) {
          readersStarted.resolve();
        }
        return {
          completion: readers.promise,
          getForwardedSignal: () => undefined,
        };
      });
      await start(targets);
      try {
        await Promise.race([preparation.started, terminal.promise]);
        expect(commands.reader).not.toHaveBeenCalled();
        expect(commands.prepare).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            args: ["scripts/run-node.mjs", "--version"],
            env: expect.objectContaining({ OPENCLAW_BUILD_PRIVATE_QA: "1" }),
          }),
        );
        preparation.resolve(0);
        await Promise.race([readersStarted.promise, terminal.promise]);
        expect(commands.reader).toHaveBeenCalledTimes(parallel ? 2 : 1);
      } finally {
        preparation.resolve(0);
        readers.resolve({ code: 0, signal: null });
        await terminal.promise;
      }
      expect(await terminal.promise).toMatch(/^\[test\] passed 2 Vitest shards/u);
      expect(commands.reader).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBe(0);
    },
  );

  it.each(["exit", "throw"])("admits no readers when preparation fails by %s", async (failure) => {
    commands.prepare.mockImplementation(async () => {
      if (failure === "throw") {
        throw new Error("build failed");
      }
      return 7;
    });
    await start(targets);
    await terminal.promise;
    expect(commands.reader).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(failure === "throw" ? 1 : 7);
  });

  it.each([
    modelTarget,
    "extensions/browser/src/browser/extension-install.test.ts",
    "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts",
    "packages/sdk/src/app-sdk-external-boundary.e2e.test.ts",
  ])("starts %s without runtime preparation", async (target) => {
    await start([target]);
    expect(await terminal.promise).toMatch(/^\[test\] passed 1 Vitest shard/u);
    expect(commands.prepare).not.toHaveBeenCalled();
    expect(commands.prepareE2e).not.toHaveBeenCalled();
    expect(commands.reader).toHaveBeenCalledOnce();
  });

  it.each(["build", "failed build", "prebuilt"])(
    "admits the built native-host integration after %s",
    async (mode) => {
      if (mode === "prebuilt") {
        vi.stubEnv("OPENCLAW_E2E_USE_PREBUILT_DIST", "1");
      }
      const preparation = createPreparationGate<NodeJS.ProcessEnv>(commands.prepareE2e);
      if (mode === "prebuilt") {
        preparation.resolve({});
      }
      await start([nativeHostTarget]);
      try {
        await Promise.race([preparation.started, terminal.promise]);
        if (mode !== "prebuilt") {
          expect(commands.reader).not.toHaveBeenCalled();
          expect(commands.prepareE2e).toHaveBeenCalledOnce();
        }
      } finally {
        if (mode === "failed build") {
          preparation.reject(new Error("build failed"));
        } else {
          preparation.resolve({ OPENCLAW_E2E_USE_PREBUILT_DIST: "1" });
        }
        await terminal.promise;
      }
      expect(commands.prepare).not.toHaveBeenCalled();
      expect(commands.prepareE2e).toHaveBeenCalledOnce();
      expect(commands.reader).toHaveBeenCalledTimes(mode === "failed build" ? 0 : 1);
      if (mode === "failed build") {
        expect(process.exitCode).toBe(1);
      } else {
        expect(commands.reader).toHaveBeenCalledWith(
          expect.objectContaining({
            pnpmArgs: expect.arrayContaining(["--config", e2eConfig]),
            env: expect.objectContaining({ OPENCLAW_E2E_USE_PREBUILT_DIST: "1" }),
          }),
        );
      }
    },
  );

  it.each(["", "OPENCLAW_E2E_SKIP_BUILD", "OPENCLAW_E2E_USE_PREBUILT_DIST"])(
    "prepares an ordinary runtime reader independently of E2E flag %s",
    async (key) => {
      if (key) {
        vi.stubEnv(key, "1");
      }
      commands.prepare.mockResolvedValue(0);
      await start(["test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts"]);
      await terminal.promise;
      expect(commands.prepare).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          env: expect.objectContaining({ OPENCLAW_BUILD_PRIVATE_QA: "" }),
        }),
      );
      expect(commands.prepareE2e).not.toHaveBeenCalled();
      expect(commands.reader).toHaveBeenCalledOnce();
    },
  );

  it("coalesces mixed package, E2E and private QA preparation before marking only E2E prebuilt", async () => {
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "2");
    const preparation = createPreparationGate<NodeJS.ProcessEnv>(commands.prepareE2e);
    await start([...targets, e2eTarget, "packages/sdk/src/app-sdk-external-boundary.e2e.test.ts"]);
    try {
      await Promise.race([preparation.started, terminal.promise]);
      expect(commands.prepareE2e).toHaveBeenCalledOnce();
      expect(commands.prepare).not.toHaveBeenCalled();
      expect(commands.reader).not.toHaveBeenCalled();
    } finally {
      preparation.resolve({ OPENCLAW_E2E_USE_PREBUILT_DIST: "1" });
      await terminal.promise;
    }
    expect(await terminal.promise).toMatch(/^\[test\] passed 3 Vitest shards/u);
    expect(commands.prepare).not.toHaveBeenCalled();
    expect(commands.reader).toHaveBeenCalledTimes(3);
    for (const [options] of commands.reader.mock.calls) {
      expect(options.env.OPENCLAW_E2E_USE_PREBUILT_DIST).toBe(
        options.pnpmArgs.includes(e2eConfig) ? "1" : "",
      );
    }
  });

  it("admits no mixed readers when E2E preparation fails", async () => {
    commands.prepareE2e.mockRejectedValue(new Error("E2E build failed"));
    await start([...targets, e2eTarget]);
    await terminal.promise;
    expect(commands.prepare).not.toHaveBeenCalled();
    expect(commands.reader).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each(["OPENCLAW_E2E_SKIP_BUILD", "OPENCLAW_E2E_USE_PREBUILT_DIST"] as const)(
    "preserves the explicit %s contract",
    async (key) => {
      vi.stubEnv(key, "1");
      commands.prepareE2e.mockResolvedValue({});
      await start([...targets, e2eTarget]);
      await terminal.promise;
      expect(commands.prepareE2e).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ [key]: "1" }),
      );
      expect(commands.prepare).not.toHaveBeenCalled();
      expect(commands.reader).toHaveBeenCalledTimes(3);
      for (const [options] of commands.reader.mock.calls) {
        expect(options.env[key]).toBe("1");
      }
    },
  );
});

describe("plugin batch build admission", () => {
  const qaConfig = "test/vitest/vitest.extension-qa.config.ts";
  const databaseConfig = "test/vitest/vitest.extension-database-workers.config.ts";
  const combinedConfig = "test/vitest/vitest.database-worker-watch.config.ts";

  it.each(["1", "2"])(
    "holds all groups and chunks behind one build (parallel=%s)",
    async (parallel) => {
      const { resolveExtensionBatchPlan, createExtensionTestProcessTargetChunks } =
        await import("../../scripts/lib/extension-test-plan.mts");
      const { runExtensionBatchPlan } = await import("../../scripts/test-extension-batch.mts");
      const batch = resolveExtensionBatchPlan({ extensionIds: ["qa-lab", "matrix", "firecrawl"] });
      const preparation = createPreparationGate<number>(commands.prepare);
      const reader = vi.fn().mockResolvedValue(0);
      const running = runExtensionBatchPlan(batch, {
        env: { OPENCLAW_EXTENSION_BATCH_PARALLEL: parallel },
        runGroup: reader,
      });
      try {
        await Promise.race([preparation.started, running]);
        expect(reader).not.toHaveBeenCalled();
        expect(commands.prepare).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            args: ["scripts/run-node.mjs", "--version"],
            env: expect.objectContaining({ OPENCLAW_BUILD_PRIVATE_QA: "1" }),
          }),
        );
      } finally {
        preparation.resolve(0);
        await running;
      }
      expect(await running).toBe(0);
      expect(reader).toHaveBeenCalledTimes(
        batch.planGroups.reduce(
          (sum, group) =>
            sum + createExtensionTestProcessTargetChunks(group.config, group.roots).length,
          0,
        ),
      );
      expect(commands.prepare).toHaveBeenCalledOnce();
    },
  );

  it.each([7, 143, "throw"])("admits no readers after preparation outcome %s", async (outcome) => {
    const { resolveExtensionBatchPlan } = await import("../../scripts/lib/extension-test-plan.mts");
    const { runExtensionBatchPlan } = await import("../../scripts/test-extension-batch.mts");
    commands.prepare.mockImplementation(async () => {
      if (outcome === "throw") {
        throw new Error("build spawn failed");
      }
      return outcome;
    });
    const reader = vi.fn().mockResolvedValue(0);
    const running = runExtensionBatchPlan(
      resolveExtensionBatchPlan({ extensionIds: ["qa-lab", "matrix"] }),
      {
        runGroup: reader,
        env: { OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" },
      },
    );
    if (outcome === "throw") {
      await expect(running).rejects.toThrow("build spawn failed");
    } else {
      await expect(running).resolves.toBe(outcome);
    }
    expect(reader).not.toHaveBeenCalled();
    expect(commands.prepare).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "full QA", ids: ["qa-lab"], build: true, configs: [databaseConfig, qaConfig] },
    { name: "shared config, channel only", ids: ["qa-channel"], build: false, configs: [qaConfig] },
    {
      name: "unrelated plugin",
      ids: ["firecrawl"],
      build: false,
      configs: ["test/vitest/vitest.extension-misc.config.ts"],
    },
    { name: "ordinary QA file", args: [ordinaryQa], build: false, configs: [combinedConfig] },
    { name: "lifecycle file", args: [lifecycle], build: true, configs: [combinedConfig] },
    {
      name: "absolute lifecycle",
      args: [path.resolve(lifecycle)],
      build: true,
      configs: [combinedConfig],
    },
    {
      name: "exact exclusion",
      args: ["--exclude", lifecycle],
      build: false,
      configs: [databaseConfig, qaConfig],
    },
    {
      name: "equals exclusion",
      args: [`--exclude=${lifecycle}`],
      build: false,
      configs: [databaseConfig, qaConfig],
    },
    {
      name: "scoped exclusion",
      args: ["--exclude", lifecycle.replace("extensions/", "")],
      build: false,
      configs: [databaseConfig, qaConfig],
    },
    {
      name: "absolute exclusion",
      args: ["--exclude", path.resolve(lifecycle)],
      build: false,
      configs: [databaseConfig, qaConfig],
    },
    {
      name: "glob exclusion",
      args: ["--exclude", "extensions/qa-lab/**/suite-process-*.test.ts"],
      build: false,
      configs: [combinedConfig],
    },
    {
      name: "all QA excluded",
      args: ["--exclude=extensions/qa-lab/**"],
      build: false,
      configs: [combinedConfig],
    },
    { name: "empty include", include: [], build: false, configs: [databaseConfig, qaConfig] },
    {
      name: "unrelated include",
      include: [ordinaryQa],
      build: false,
      configs: [databaseConfig, qaConfig],
    },
    {
      name: "lifecycle include",
      include: [lifecycle],
      build: true,
      configs: [databaseConfig, qaConfig],
    },
    {
      name: "absolute lifecycle include",
      include: [path.resolve(lifecycle)],
      build: true,
      configs: [databaseConfig, qaConfig],
    },
    {
      name: "scoped lifecycle include",
      include: [lifecycle.replace("extensions/", "")],
      build: true,
      configs: [databaseConfig, qaConfig],
    },
    {
      name: "runtime include outside config directory",
      include: ["test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts"],
      args: ["test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts"],
      build: false,
      configs: [combinedConfig],
    },
    {
      name: "include outside emitted roots",
      ids: ["qa-channel"],
      include: [lifecycle],
      build: false,
      configs: [qaConfig],
    },
    {
      name: "cross-root CLI with include",
      ids: ["qa-channel"],
      args: [lifecycle],
      include: [lifecycle],
      build: true,
      configs: [qaConfig],
    },
    {
      name: "include outside explicit target",
      args: [ordinaryQa],
      include: [lifecycle],
      build: true,
      configs: [combinedConfig],
    },
    {
      name: "existing exact-exclude expansion",
      args: [ordinaryQa, "--exclude", "extensions/codex/src/app-server/run-attempt.test.ts"],
      build: true,
      configs: [combinedConfig],
    },
    { name: "no groups", ids: [], build: false, configs: [] },
  ])(
    "prepares the actual invocation selection: $name",
    async ({ ids = ["qa-lab"], args = [], include, build, configs }) => {
      const { resolveExtensionBatchPlan } =
        await import("../../scripts/lib/extension-test-plan.mts");
      const { runExtensionBatchPlan } = await import("../../scripts/test-extension-batch.mts");
      const env = include
        ? { OPENCLAW_VITEST_INCLUDE_FILE: patternFiles.writePatternFile("include.json", include) }
        : {};
      commands.prepare.mockResolvedValue(0);
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
