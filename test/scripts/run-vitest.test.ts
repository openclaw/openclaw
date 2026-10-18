import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import nodePath from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCLI } from "vitest/node";
import { resolveVitestCliEntry } from "../../scripts/lib/vitest-build-prerequisites.mts";
import {
  DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
  resolveDefaultVitestNoOutputTimeoutMs,
  resolveRunVitestSpawnEnv,
  resolveVitestNodeArgs,
} from "../../scripts/lib/vitest-process-env.mts";
import * as testRuntime from "../../scripts/lib/vitest-test-runtime.mts";
import {
  createVitestUnhandledErrorDetector,
  writeVitestUnhandledErrorSummary,
} from "../../scripts/lib/vitest-unhandled-errors.mts";
import {
  installVitestNoOutputWatchdog,
  resolveBoundedVitestInvocations,
  resolveExplicitTestFileNoPassArgs,
  resolveImplicitVitestArgs,
  resolveMissingExplicitTestFiles,
  resolveTestProjectsDelegationArgs,
  resolveVitestSpawnParams,
  runVitest,
  spawnWatchedVitestProcess,
  shouldSuppressVitestStderrLine,
} from "../../scripts/run-vitest.mts";
import { parseTestProjectsArgs } from "../../scripts/test-projects.test-support.mts";
import { forceKillVitestProcessGroup } from "../../scripts/vitest-process-group.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { listGitTrackedFiles } from "../../src/test-utils/repo-files.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { isGatewayServerTestFile } from "../vitest/vitest.gateway-server-paths.mjs";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";
import { childTermination } from "./run-vitest.test-support.js";

const posixIt = process.platform === "win32" ? it.skip : it;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const file = "test/scripts/run-vitest.test.ts";
const toolingConfig = "test/vitest/vitest.tooling.config.ts";
const e2eConfig = "test/vitest/vitest.e2e.config.ts";
const gatewayConfig = "test/vitest/vitest.gateway-server.config.ts";
const uiFile = "ui/src/pages/chat/chat-send.test.ts";
const browserFile = "ui/src/components/markdown-mermaid.runtime.browser.test.ts";
const dockerFile = "test/scripts/docker-build-helper.test.ts";
const browserGlob = "ui/src/**/*.browser.test.ts";
const markdownNodeFile = "ui/src/components/markdown.progress.node.test.ts";
const agentDir = "src/agents/embedded-agent-runner/run";
const modulesDir = "/runner/openclaw-pnpm-node-modules";
const baseEnv = { PATH: "/usr/bin" };
const PINNED_LOCALE = { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
const watchdogEnv = (timeout: number) => ({
  ...baseEnv,
  OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
  OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: String(timeout),
});
const compileCacheEnv = {
  ...baseEnv,
  CI: "true",
  NODE_COMPILE_CACHE: "/tmp/node-compile",
  NODE_COMPILE_CACHE_PORTABLE: "1",
};
const floorEnv = { ...baseEnv, OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "300000" };
const directArgs = (config: string, ...args: string[]) => ["run", "--config", config, ...args];
const nativeCLI = (args: string[]) => parseCLI(["vitest", ...args]);
const mixedDirs = ["extensions/canvas", "src/node-host"];

function readyLine(child: ChildProcess, accept: (line: string) => void) {
  const message = "fixture closed before reporting readiness";
  const lines = createInterface({ input: child.stdout! });
  const ready = new Promise<void>((resolve, reject) => {
    lines.once("line", (line) => {
      try {
        accept(line);
        resolve();
      } catch (error) {
        reject(new Error(message, { cause: error }));
      }
    });
    lines.once("close", () => reject(new Error(message)));
  });
  return { lines, ready };
}

function descendantFixture(report: string, exitCode?: number | null) {
  return `const { spawn } = require("node:child_process");
${typeof exitCode === "number" ? `process.once("SIGTERM", () => process.exit(${exitCode}));` : ""}
const descendant = spawn(process.execPath, ["-e",
  "setInterval(() => {}, 1000); process.send(process.pid);",
], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
descendant.once("message", (pid) => {
  descendant.disconnect();
  process.stdout.write(${report} + "\\n");
});
descendant.unref();
setInterval(() => {}, 1000);`;
}

async function proveRuntimeCache(native: boolean) {
  const files = ["./test/scripts/run-vitest.test.ts"];
  const directory = tempDirs.make("oc-runtime-cache-");
  const env = Object.freeze({
    OPENCLAW_BUN_PATH: process.execPath,
    NODE_COMPILE_CACHE: nodePath.join(directory, "node-cache"),
    NODE_COMPILE_CACHE_PORTABLE: "1",
    NODE_DISABLE_COMPILE_CACHE: "0",
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    ...(native ? {} : { OPENCLAW_VITEST_RUNTIME: "bun" }),
  });
  const parentCacheDisabled = process.env.NODE_DISABLE_COMPILE_CACHE;
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const operands = [
    "scripts/lib/vitest-worker-bootstrap.mts",
    "/compiled/generation",
    "node_modules/vitest/vitest.mjs",
    "run",
    "--testNamePattern",
    "--no-maglev",
  ];
  const flags = ["--no-maglev", "--no-concurrent-sparkplug"];
  const expectedCommand = native
    ? testRuntime.resolveNativeBunTestCommand(files, undefined, env)
    : testRuntime.resolveVitestTestCommand([...flags, ...operands], env);
  expect(expectedCommand).toEqual({
    command: process.execPath,
    envOverrides: { NODE_DISABLE_COMPILE_CACHE: "1", PATH: nodePath.dirname(process.execPath) },
    args: native
      ? [
          "test",
          "--no-env-file",
          "--tsconfig-override",
          nodePath.join(repoRoot, "tsconfig.json"),
          "--preload",
          nodePath.join(repoRoot, "test/setup.env.ts"),
          "--timeout",
          "120000",
          ...files,
        ]
      : ["--tsconfig-override", nodePath.join(repoRoot, "tsconfig.json"), ...operands],
  });
  const probe = {
    command: resolveTestNodeExecPath(),
    args: [
      "-e",
      [
        'const assert = require("node:assert/strict");',
        'assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, "1");',
        `assert.equal(process.env.NODE_COMPILE_CACHE, ${JSON.stringify(env.NODE_COMPILE_CACHE)});`,
        'assert.equal(process.env.NODE_COMPILE_CACHE_PORTABLE, "1");',
        "process.exitCode = 7;",
      ].join("\n"),
    ],
  };
  const resolveCommand = testRuntime.resolveVitestTestCommand;
  // Keep the real runtime policy on the Vitest route; replace only its executable.
  const command = native
    ? vi
        .spyOn(testRuntime, "resolveNativeBunTestCommand")
        .mockReturnValue({ ...expectedCommand, ...probe })
    : vi
        .spyOn(testRuntime, "resolveVitestTestCommand")
        .mockImplementation((...args) => ({ ...resolveCommand(...args), ...probe }));
  const exitCode = process.exitCode;
  try {
    if (native) {
      await runVitest(vi.fn(), ["--native-bun", ...files], env);
      expect(command).toHaveBeenCalledWith(files, undefined, expect.objectContaining(env));
      expect(process.exitCode).toBe(7);
    } else {
      const watched = spawnWatchedVitestProcess({
        pnpmArgs: ["exec", "node", ...flags, ...operands],
        spawnParams: { ...resolveVitestSpawnParams(env), stdio: ["ignore", "pipe", "pipe"] },
        env,
        homeMode: "hermetic",
      });
      expect((await watched.completion).code).toBe(7);
    }
    expect(env.NODE_DISABLE_COMPILE_CACHE).toBe("0");
    expect(process.env.NODE_DISABLE_COMPILE_CACHE).toBe(parentCacheDisabled);
  } finally {
    process.exitCode = exitCode;
    command.mockRestore();
  }
}

describe("scripts/run-vitest", () => {
  it("pins fixture scheduling independently of ambient CI and preserves explicit overrides", () => {
    const inherited = {
      PATH: "/fixture/bin",
      CI: "1",
      GITHUB_ACTIONS: "true",
      OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE: "1",
    };
    expect(testRunnerFixtureEnv({}, inherited)).toEqual({ PATH: "/fixture/bin" });
    expect(testRunnerFixtureEnv({ CI: "1", GITHUB_ACTIONS: "true" }, inherited)).toEqual({
      PATH: "/fixture/bin",
      CI: "1",
      GITHUB_ACTIONS: "true",
    });
    expect(inherited).toMatchObject({
      OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE: "1",
      CI: "1",
      GITHUB_ACTIONS: "true",
    });
  });

  it("reports an actionable error when Vitest cannot be resolved", () => {
    const error = new Error("Cannot find module 'vitest/package.json'");
    (error as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";

    expect(() =>
      resolveVitestCliEntry({
        baseDir: "/repo",
        fsImpl: { existsSync: () => false },
        requireResolve: () => {
          throw error;
        },
      }),
    ).toThrow(
      [
        "[vitest] node_modules is missing; Vitest cannot be resolved.",
        "Install dependencies before running scripts/run-vitest.mjs:",
        "  pnpm install --frozen-lockfile",
        "For raw Crabbox/AWS macOS source syncs, hydrate or install dependencies before this runner.",
      ].join("\n"),
    );
  });

  it("selects Bun without changing the compiled bootstrap or test operands", () =>
    proveRuntimeCache(false));

  it("rejects an unsupported test runtime before launching a child", () => {
    expect(() =>
      spawnWatchedVitestProcess({
        pnpmArgs: ["exec", "node", "node_modules/vitest/vitest.mjs", "run"],
        spawnParams: {},
        env: { OPENCLAW_VITEST_RUNTIME: "deno" },
      }),
    ).toThrow("Invalid OPENCLAW_VITEST_RUNTIME: deno; expected node or bun");
  });

  it("keeps native preparation tools on Node when tests select Bun", () => {
    const args = ["--import", "tsx", "scripts/ensure-playwright-chromium.mts"];
    expect(testRuntime.resolveVitestTestCommand(args, { OPENCLAW_VITEST_RUNTIME: "bun" })).toEqual({
      command: process.execPath,
      args,
    });
  });

  it.each([
    "test/scripts/run-vitest.test.ts",
    "./../outside.test.ts",
    "./test/scripts/missing-native-bun-file.test.ts",
  ])("rejects unbounded native Bun operand %s before launching", async (operand) => {
    const command = vi.spyOn(testRuntime, "resolveNativeBunTestCommand");
    try {
      await expect(runVitest(vi.fn(), ["--native-bun", operand], {})).rejects.toThrow(
        /Native Bun test/u,
      );
      expect(command).not.toHaveBeenCalled();
    } finally {
      command.mockRestore();
    }
  });

  it("refuses native Bun admission after its expected parent disconnected", async () => {
    const connected = Object.getOwnPropertyDescriptor(process, "connected");
    const command = vi.spyOn(testRuntime, "resolveNativeBunTestCommand");
    Object.defineProperty(process, "connected", { configurable: true, value: false });
    try {
      await expect(
        runVitest(vi.fn(), ["--native-bun", "./test/scripts/run-vitest.test.ts"], {
          OPENCLAW_NATIVE_BUN_PARENT_IPC: "1",
        }),
      ).rejects.toThrow("Native Bun test parent IPC disconnected before admission");
      expect(command).not.toHaveBeenCalled();
    } finally {
      if (connected) {
        Object.defineProperty(process, "connected", connected);
      } else {
        Reflect.deleteProperty(process, "connected");
      }
      command.mockRestore();
    }
  });

  posixIt("runs native Bun with bounded arguments and preserves failure", () =>
    proveRuntimeCache(true),
  );

  posixIt("joins native Bun descendants when its CI parent disconnects", async ({ signal }) => {
    const fixture = descendantFixture("JSON.stringify({ child: process.pid, descendant: pid })");
    const runtimeUrl = new URL("../../scripts/lib/vitest-test-runtime.mts", import.meta.url).href;
    const replacement = `data:text/javascript,${encodeURIComponent(
      `export function resolveNativeBunTestCommand() {
        return { command: process.execPath, args: ["-e", ${JSON.stringify(fixture)}] };
      }
      export function resolveVitestTestCommand() { throw new Error("unexpected Vitest launch"); }`,
    )}`;
    const preload = `data:text/javascript,${encodeURIComponent(
      `import { registerHooks } from "node:module";
      registerHooks({ resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        return resolved.url === ${JSON.stringify(runtimeUrl)}
          ? { url: ${JSON.stringify(replacement)}, shortCircuit: true }
          : resolved;
      } });`,
    )}`;
    const child = spawn(
      process.versions.bun ? "node" : process.execPath,
      [
        "--import",
        preload,
        nodePath.resolve("scripts/run-vitest.mts"),
        "--native-bun",
        "./test/scripts/run-vitest.test.ts",
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: testRunnerFixtureEnv({ OPENCLAW_NATIVE_BUN_PARENT_IPC: "1" }),
      },
    );
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    // Explicit IPC disconnect can omit Node's aggregate close notification.
    // Observe termination and drain both pipes independently instead.
    const exited = childTermination(child, "exit");
    const joined = Promise.all([exited, finished(child.stdout!), finished(child.stderr!)]).then(
      ([result]) => result,
    );
    let nativePid = 0;
    let descendantPid = 0;
    const { lines, ready } = readyLine(child, (line) => {
      const pids = JSON.parse(line);
      nativePid = pids.child;
      descendantPid = pids.descendant;
      expect(isProcessAlive(nativePid)).toBe(true);
      expect(isProcessAlive(descendantPid)).toBe(true);
      child.disconnect();
    });
    try {
      const [, result] = await withinTest(
        Promise.all([
          awaitGateBeforeSettlement(ready, joined, "native child closed before readiness"),
          joined,
        ]),
        signal,
      );
      expect(result, stderr).toEqual({ code: null, signal: "SIGTERM" });
      expect([child.stdout, child.stderr]).toMatchObject([
        { readableEnded: true },
        { readableEnded: true },
      ]);
      expect([child.pid!, nativePid].map(isProcessGroupStopped)).toEqual([true, true]);
    } finally {
      lines.close();
      forceKillVitestProcessGroup(child);
      if (nativePid) {
        forceKillVitestProcessGroup({ pid: nativePid });
      }
      await joined;
    }
  });

  it("resolves dependencies before native parsing at the mjs entrypoint", () => {
    const preload = `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier, context, nextResolve) {
  if (specifier === 'vitest/package.json' || specifier === 'vitest/node') {
    console.error('dependency request: ' + specifier);
    const error = new Error("Cannot find module '" + specifier + "'");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return nextResolve(specifier, context);
}});`;
    const importUrl = `data:text/javascript,${encodeURIComponent(preload)}`;
    // The JS shim creates another Node process; inject at the inherited dependency
    // boundary, and retain a bounded empty selection even if injection regresses.
    const result = spawnSync(
      process.versions.bun ? "node" : process.execPath,
      [
        nodePath.resolve("scripts/run-vitest.mjs"),
        "run",
        "--config",
        toolingConfig,
        file,
        "--testNamePattern=^dependency-order-no-test$",
      ],
      {
        encoding: "utf8",
        env: testRunnerFixtureEnv({
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${JSON.stringify(importUrl)}`]
            .filter(Boolean)
            .join(" "),
        }),
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Install dependencies before running scripts/run-vitest.mjs:");
    expect(result.stderr).toContain("dependency request: vitest/package.json");
    expect(result.stderr).not.toContain("dependency request: vitest/node");
  });

  it.each(["PNPM_CONFIG_MODULES_DIR", "npm_config_modules_dir"])(
    "links hydrated modules from %s before resolving Vitest",
    (key) => {
      const symlinkSync = vi.fn();
      const requireResolve = vi.fn(() => {
        throw new Error("must use hydrated modules");
      });
      expect(
        resolveVitestCliEntry({
          baseDir: "/repo",
          env: { [key]: modulesDir },
          fsImpl: {
            existsSync: (entry: string) =>
              entry.replaceAll("\\", "/") === modulesDir + "/vitest/package.json",
            symlinkSync,
          },
          platform: "win32",
          requireResolve,
        }),
      ).toBe("/repo/node_modules/vitest/vitest.mjs");
      expect(symlinkSync.mock.calls).toEqual([
        [modulesDir, modulesDir + "/node_modules", "junction"],
        [modulesDir, "/repo/node_modules", "junction"],
      ]);
      expect(requireResolve).not.toHaveBeenCalled();
    },
  );

  it.each<[string[], string[]?]>([
    [mixedDirs, [...mixedDirs, "--isolate"]],
    [mixedDirs.slice(1)],
    [[...mixedDirs, "--no-isolate"]],
    [
      [...mixedDirs, "--", "--no-isolate"],
      [...mixedDirs, "--isolate", "--", "--no-isolate"],
    ],
    [["run", file], directArgs(toolingConfig, file)],
    [["run", dockerFile], directArgs("test/vitest/vitest.tooling-docker.config.ts", dockerFile)],
    [["run", browserFile], directArgs("test/vitest/vitest.ui-browser.config.ts", browserFile)],
    [["run", browserGlob]],
    [["run", markdownNodeFile]],
  ])("routes implicit selection %j", (argv, expected = argv) => {
    expect(resolveImplicitVitestArgs(argv)).toEqual(expected);
  });

  it("replaces broad Gateway filters while retaining options and the native separator", () => {
    const argv = directArgs(gatewayConfig, "--reporter=verbose", "--testNamePattern", "server");
    const targets = ["src/gateway/server-a.test.ts", "src/gateway/server-b.test.ts"];
    expect(
      resolveBoundedVitestInvocations([...argv, "server", "--", "-x"], {
        env: {},
        gatewayServerTargetChunks: targets.map((target) => [target]),
      }),
    ).toEqual(targets.map((target) => argv.concat(target, "--", "-x")));
  });

  it("keeps every Gateway server file in one bounded native invocation", () => {
    const argv = ["--config", "/repo/" + gatewayConfig];
    const invocations = resolveBoundedVitestInvocations(argv, { env: { CI: "1" } });
    const targets = invocations.map((args) => args.slice(argv.length));

    expect(targets.every((files) => files.length > 0 && files.length <= 16)).toBe(true);
    expect(targets.flat()).toEqual(
      listGitTrackedFiles({ pathspecs: "src/gateway" })
        ?.filter(isGatewayServerTestFile)
        .toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("bounds the complete E2E selection without multiplying configured workers", () => {
    const argv = directArgs(e2eConfig, "--maxWorkers", "2");
    expect(resolveBoundedVitestInvocations(argv, { env: {} })).toEqual(
      [1, 2, 3, 4].map((index) => argv.concat(`--shard=${index}/4`)),
    );
  });

  it.each([
    { argv: directArgs(e2eConfig, "doctor") },
    { argv: directArgs(e2eConfig, "--testNamePattern", "doctor") },
    { argv: ["watch", "--config", gatewayConfig] },
  ])("keeps explicitly bounded or watched selection %j", ({ argv }) => {
    expect(resolveBoundedVitestInvocations(argv, { env: {} })).toEqual([argv]);
  });

  it.each([
    { argv: ["run", "--exclude=", file], filter: [], options: {}, config: [] },
    {
      argv: ["list", uiFile, "--exclude", file, "--passWithNoTests=false"],
      filter: [uiFile],
      options: { exclude: [file], passWithNoTests: false },
      config: ["--config", "test/vitest/vitest.ui.config.ts"],
    },
  ])(
    "routes positionals independently of excluded files: $argv",
    ({ argv, filter, options, config }) => {
      const native = nativeCLI(argv);
      expect(native).toMatchObject({ filter, options });
      expect(resolveTestProjectsDelegationArgs(argv)).toBeNull();
      expect(nativeCLI(resolveImplicitVitestArgs(argv))).toEqual(nativeCLI([...config, ...argv]));
    },
  );

  it.each([
    ["--passWithNoTests=", "false"],
    ["--passWithNoTests=false", "--pass-with-no-tests=true"],
    ["--", "--passWithNoTests=true", "-x"],
  ])("enforces direct empty-file policy for %j", async (...flags) => {
    const argv = directArgs(toolingConfig, file, ...flags);
    const original = [...argv];
    const native = nativeCLI(argv);
    expect(nativeCLI(await resolveExplicitTestFileNoPassArgs(argv))).toEqual({
      ...native,
      options: { ...native.options, passWithNoTests: false },
    });
    expect(argv).toEqual(original);
  });

  it("does not force no-test failure for globs or basename filters", async () => {
    const argv = ["run", "run-vitest.test.ts", "test/**/*.test.ts"];
    expect(await resolveExplicitTestFileNoPassArgs(argv)).toBe(argv);
  });

  it("round-trips repeated native options through delegation", () => {
    const flags = ["--passWithNoTests", "--passWithNoTests"];
    const parse = (args: string[]) => {
      try {
        return nativeCLI(["run", ...args]);
      } catch (error) {
        return String(error);
      }
    };
    for (const argv of [
      [...flags, file],
      [file, ...flags],
    ]) {
      const delegated = resolveTestProjectsDelegationArgs(argv);
      expect(delegated).not.toBeNull();
      const { forwardedArgs } = parseTestProjectsArgs(delegated!);
      expect(parse(forwardedArgs)).toEqual(parse(argv));
    }
  });

  it.each<[string[], string[] | null]>([
    [
      ["--reporter=verbose", "run", file, "--", "--watch"],
      [file, "--", "--reporter=verbose", "--watch"],
    ],
    [["extensions/telegram/src/format"], ["extensions/telegram/src/format"]],
    [["extensions/codex"], ["extensions/codex"]],
    [
      [agentDir, "--sequence.shuffle", "--sequence.seed", "3"],
      [agentDir, "--", "--sequence.shuffle", "--sequence.seed", "3"],
    ],
    [["extensions/codex/src"], null],
    [
      ["src/**/*.test.ts", "src/agents/bash-tools.ts"],
      ["src/**/*.test.ts", "src/agents/bash-tools.ts"],
    ],
    [["--run", "false", file], null],
  ])("preserves ownership and operands when delegating %j", (argv, expected) => {
    expect(resolveTestProjectsDelegationArgs(argv)).toEqual(expected);
  });

  it("defers missing-file preflight to Vitest with explicit path owners", () => {
    for (const argv of [
      ["--config", gatewayConfig, "server/health-state.test.ts"],
      ["--root", "packages/example", "src/example.test.ts"],
      ["--dir=src", "example.test.ts"],
    ]) {
      expect(resolveMissingExplicitTestFiles(argv, "/repo", { existsSync: () => false })).toEqual(
        [],
      );
    }
  });

  it("keeps Sparkplug synchronous when Maglev is enabled", () => {
    expect(resolveVitestNodeArgs({ OPENCLAW_VITEST_ENABLE_MAGLEV: "1" })).toStrictEqual([
      "--no-concurrent-sparkplug",
    ]);
  });

  it.each<[string[], NodeJS.ProcessEnv, number | null]>([
    [["run", "-t", "watch"], baseEnv, 120000],
    [["--watch", "false"], baseEnv, 120000],
    [["--watch=false"], baseEnv, 120000],
    [["--no-watch"], baseEnv, 120000],
    [["src/foo.test.ts"], { ...baseEnv, CI: "true" }, 120000],
    [["run"], { ...baseEnv, OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0" }, null],
    [["run", "--config", "test/vitest/vitest.extension-codex.config.ts"], floorEnv, 2400000],
    [["run", "--config", "test/vitest/vitest.unit.config.ts"], floorEnv, 300000],
    [["run"], compileCacheEnv, 120000],
    [["run", "--coverage=false"], compileCacheEnv, 120000],
    [["--watch"], compileCacheEnv, null],
    [["src/foo.test.ts"], baseEnv, null],
    [["--config", toolingConfig, "-t", "watch"], baseEnv, null],
  ])("resolves watchdog policy for %j with %j to %s ms", (argv, env, timeout) => {
    expect(resolveRunVitestSpawnEnv(env, argv)).toEqual(
      timeout === null ? env : { ...env, ...watchdogEnv(timeout) },
    );
  });

  it("preserves inherited compile caches while pinning the child locale", () => {
    expect(resolveVitestSpawnParams(compileCacheEnv, "linux").env).toEqual({
      ...compileCacheEnv,
      ...PINNED_LOCALE,
    });
  });

  it("uses the native inline short config for its watchdog", () => {
    const argv = ["run", `-c=${e2eConfig}`];
    expect(nativeCLI(argv).options.config).toBe(e2eConfig);
    expect(resolveDefaultVitestNoOutputTimeoutMs(argv)).toBe(
      DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
    );
  });

  posixIt.for([
    { timeout: false, exitCode: 0, expectedCode: 0, nativeBun: false },
    { timeout: true, exitCode: 1, expectedCode: 2, nativeBun: false },
    { timeout: true, exitCode: null, expectedCode: null, nativeBun: false },
    { timeout: true, exitCode: 0, expectedCode: 2, nativeBun: true },
  ])(
    "settles descendants (timeout=$timeout, child=$exitCode, native=$nativeBun)",
    async (row, context) => {
      const watchedEnv = {
        OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "5000",
        ...(row.nativeBun ? { OPENCLAW_LIVE_TEST: "1", OPENCLAW_LIVE_USE_REAL_HOME: "1" } : {}),
      };
      let noOutputTimedOut = false;
      // Only watchdog timers are fake; child I/O, diagnostics, and group joins stay real.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { clock } = setTimeout as typeof setTimeout & { clock: { tick(ms: number): void } };
      let watched: ReturnType<typeof spawnWatchedVitestProcess>;
      const fixtureArgs = [
        "-e",
        descendantFixture(
          row.nativeBun
            ? "JSON.stringify({ pid, home: process.env.HOME, tmp: process.env.TMPDIR, live: process.env.OPENCLAW_LIVE_TEST, realHome: process.env.OPENCLAW_LIVE_USE_REAL_HOME })"
            : "pid",
          row.exitCode,
        ),
      ];
      const nativeCommand = row.nativeBun
        ? vi.spyOn(testRuntime, "resolveNativeBunTestCommand").mockReturnValue({
            command: process.execPath,
            args: fixtureArgs,
          })
        : undefined;
      try {
        watched = spawnWatchedVitestProcess({
          ...(row.nativeBun
            ? { nativeBunFiles: ["./test/scripts/run-vitest.test.ts"] }
            : { pnpmArgs: ["exec", "node", ...fixtureArgs] }),
          spawnParams: {
            detached: true,
            env: watchedEnv,
            stdio: ["ignore", "pipe", "pipe"],
          },
          env: watchedEnv,
          onNoOutputTimeout: () => {
            noOutputTimedOut = true;
          },
        });
      } finally {
        vi.useRealTimers();
        nativeCommand?.mockRestore();
      }
      const rawExit = childTermination(watched.child);
      let descendantPid = 0;
      let nativeTempRoot: string | undefined;
      const { lines, ready } = readyLine(watched.child, (line) => {
        // The descendant acknowledges its running loop on the watched pipe. Check
        // and signal in this notification, before a delayed poll can outlive it.
        if (row.nativeBun) {
          const state = JSON.parse(line);
          descendantPid = state.pid;
          nativeTempRoot = state.tmp;
          expect(state.home).toBe(nodePath.join(state.tmp, "home"));
          expect(fs.existsSync(state.home)).toBe(true);
          expect(state.live).toBeUndefined();
          expect(state.realHome).toBeUndefined();
        } else {
          descendantPid = Number(line);
        }
        expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);
        if (row.timeout) {
          clock.tick(Number(watchedEnv.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS));
        } else {
          process.kill(watched.child.pid!, "SIGTERM");
        }
      });

      try {
        const snapshot = await withinTest(
          Promise.all([
            awaitGateBeforeSettlement(
              ready,
              watched.completion,
              "fixture closed before reporting readiness",
            ),
            rawExit,
            watched.completion,
          ]).then(([, raw, result]) => {
            const groupStopped = isProcessGroupStopped(watched.child.pid!);
            return { groupStopped, noOutputTimedOut, raw, result };
          }),
          context.signal,
        );

        const signal = row.exitCode === null ? "SIGTERM" : null;
        expect(snapshot).toEqual({
          groupStopped: true,
          noOutputTimedOut: row.timeout,
          raw: { code: row.exitCode, signal },
          result: { code: row.expectedCode, signal, groupJoined: true },
        });
        if (nativeTempRoot) {
          expect(fs.existsSync(nativeTempRoot)).toBe(false);
        }
      } finally {
        lines.close();
        watched.teardown();
        forceKillVitestProcessGroup(watched.child);
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await watched.completion;
      }
    },
  );

  it.each<{ env: NodeJS.ProcessEnv; expected: NodeJS.ProcessEnv }>([
    {
      env: { OPENCLAW_LOCAL_CHECK: "0", LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" },
      expected: { OPENCLAW_LOCAL_CHECK: "1" },
    },
    {
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2", RAYON_NUM_THREADS: "8", TOKIO_WORKER_THREADS: "6" },
      expected: {},
    },
    {
      env: { OPENCLAW_TEST_PROJECTS_SERIAL: "1", OPENCLAW_VITEST_MAX_WORKERS: "8x" },
      expected: { RAYON_NUM_THREADS: "1", TOKIO_WORKER_THREADS: "1" },
    },
  ])("applies child scheduling policy to $env", ({ env, expected }) => {
    expect(resolveVitestSpawnParams({ ...baseEnv, ...env }, "darwin").env).toEqual({
      ...baseEnv,
      ...env,
      ...expected,
      ...PINNED_LOCALE,
    });
  });

  it("suppresses only plugin timing noise on stderr", () => {
    expect(
      shouldSuppressVitestStderrLine("\u001b[33m[PLUGIN_TIMINGS] Warning:\u001b[0m slow plugin\n"),
    ).toBe(true);
    expect(shouldSuppressVitestStderrLine("real failure output\n")).toBe(false);
  });

  it("extracts ANSI-colored unhandled errors and their origin", () => {
    const origin = "fixture.test.ts";
    const detector = createVitestUnhandledErrorDetector();
    const output = [
      "⎯⎯ Unhandled Errors ⎯⎯",
      "Vitest caught 1 unhandled error during the test run.",
      "⎯⎯ Unhandled Rejection ⎯⎯",
      "TypeError: request failed",
      'This error originated in "' + origin + '" test file.',
    ]
      .map((line) => "\u001b[31m" + line + "\u001b[0m")
      .join("\n");
    detector.observe(output);
    expect(detector.finish()).toEqual({
      count: 1,
      errorFirstLine: "TypeError: request failed",
      origin,
    });
  });

  it("adds workflow annotations only under GitHub Actions", () => {
    const result = { count: 2, origin: "fixture.test.ts", errorFirstLine: "TypeError: failed" };
    const localLog = vi.fn();
    const actionsLog = vi.fn();
    writeVitestUnhandledErrorSummary(result, {}, localLog);
    writeVitestUnhandledErrorSummary(result, { GITHUB_ACTIONS: "true" }, actionsLog);
    const summary = "[vitest] UNHANDLED ERRORS (2): fixture.test.ts — TypeError: failed";
    expect(localLog.mock.calls).toEqual([[summary]]);
    expect(actionsLog.mock.calls).toEqual([["::error::" + summary], [summary]]);
  });

  describe("idle watchdog", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function setup(options: { heartbeatMs?: number; forceKillAfterMs?: number } = {}) {
      const stdout = new EventEmitter();
      const onTimeout = vi.fn();
      const onForceKill = vi.fn();
      const log = vi.fn();
      const watchdog = installVitestNoOutputWatchdog({
        streams: [stdout],
        timeoutMs: 1000,
        forceKillAfterMs: 5000,
        onTimeout,
        onForceKill,
        log,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
        ...options,
      });
      return { stdout, onTimeout, onForceKill, log, watchdog };
    }

    it("does not cancel force-kill on late output", () => {
      const { stdout, onTimeout, onForceKill, watchdog } = setup();
      vi.advanceTimersByTime(1000);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      stdout.emit("data", "too late");
      vi.advanceTimersByTime(5000);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onForceKill).toHaveBeenCalledTimes(1);
      watchdog.teardown();
    });

    it("prints bounded heartbeats until the idle deadline", () => {
      const { stdout, onTimeout, log } = setup({ heartbeatMs: 400, forceKillAfterMs: 0 });
      vi.advanceTimersByTime(400);
      expect(log).toHaveBeenCalledWith("[vitest] still running with no output for 400ms.");
      vi.advanceTimersByTime(400);
      expect(log).toHaveBeenCalledWith("[vitest] still running with no output for 800ms.");
      stdout.emit("data", "still alive");
      vi.advanceTimersByTime(400);
      expect(log).toHaveBeenCalledWith("[vitest] still running with no output for 400ms.");
      vi.advanceTimersByTime(600);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        "[vitest] no output for 1000ms; terminating stalled Vitest process group.",
      );
    });
  });
});

function isProcessGroupStopped(pid: number) {
  const psArgs =
    process.platform === "linux" ? ["-eL", "-o", "pgid=,state="] : ["-axo", "pgid=,state="];
  const stateResult = spawnSync("ps", psArgs, { encoding: "utf8" });
  const rows = stateResult.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => /^\s*(\d+)\s+(\S+)\s*$/u.exec(line));
  return (
    !stateResult.error &&
    stateResult.signal === null &&
    stateResult.stderr.trim() === "" &&
    stateResult.status === 0 &&
    rows.every(Boolean) &&
    rows.filter((row) => Number(row?.[1]) === pid).every((row) => /^[ZX]/u.test(row?.[2] ?? ""))
  );
}
