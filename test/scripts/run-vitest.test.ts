import { spawn, spawnSync } from "node:child_process";
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
  resolveVitestNoOutputTimeoutMs,
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

const posixIt = process.platform === "win32" ? it.skip : it;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const file = "test/scripts/run-vitest.test.ts";
const toolingConfig = "test/vitest/vitest.tooling.config.ts";
const e2eConfig = "test/vitest/vitest.e2e.config.ts";
const gatewayConfig = "test/vitest/vitest.gateway-server.config.ts";
const uiFile = "ui/src/pages/chat/chat-send.test.ts";
const browserFile = "ui/src/components/markdown-mermaid.runtime.browser.test.ts";
const jsdomFile = "ui/src/components/form-controls.browser.test.ts";
const agentDir = "src/agents/embedded-agent-runner/run";
const modulesDir = "/runner/openclaw-pnpm-node-modules";
const baseEnv = { PATH: "/usr/bin" };
const PINNED_LOCALE = { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
const watchdogEnv = (timeout: number) => ({
  ...baseEnv,
  OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "30000",
  OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: String(timeout),
});

describe("scripts/run-vitest", () => {
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

  it.each([undefined, "node", "bun"] as const)(
    "selects the %s test runtime without changing the compiled bootstrap or test operands",
    async (runtime) => {
      const directory = tempDirs.make("oc-test-runtime-cache-");
      const env = Object.freeze({
        OPENCLAW_VITEST_RUNTIME: runtime,
        NODE_COMPILE_CACHE: nodePath.join(directory, "node-cache"),
        NODE_COMPILE_CACHE_PORTABLE: "1",
        NODE_DISABLE_COMPILE_CACHE: "0",
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
      });
      const parentCacheDisabled = process.env.NODE_DISABLE_COMPILE_CACHE;
      const operands = [
        "scripts/lib/vitest-worker-bootstrap.mts",
        "/compiled/generation",
        "node_modules/vitest/vitest.mjs",
        "run",
        "--testNamePattern",
        "--no-maglev",
      ];
      const flags = ["--no-maglev", "--no-concurrent-sparkplug"];
      expect(testRuntime.resolveVitestTestCommand([...flags, ...operands], env)).toEqual({
        command: runtime === "bun" ? "bun" : process.execPath,
        ...(runtime === "bun" ? { envOverrides: { NODE_DISABLE_COMPILE_CACHE: "1" } } : {}),
        args:
          runtime === "bun"
            ? [
                "--tsconfig-override",
                fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
                ...operands,
              ]
            : [...flags, ...operands],
      });
      if (runtime === undefined) {
        return;
      }
      const resolveCommand = testRuntime.resolveVitestTestCommand;
      // Keep the real runtime policy while an inert child observes the delivered environment.
      const command = vi
        .spyOn(testRuntime, "resolveVitestTestCommand")
        .mockImplementation((...args) => ({
          ...resolveCommand(...args),
          command: resolveTestNodeExecPath(),
          args: [
            "-e",
            [
              'const assert = require("node:assert/strict");',
              `assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, ${JSON.stringify(runtime === "bun" ? "1" : "0")});`,
              `assert.equal(process.env.NODE_COMPILE_CACHE, ${JSON.stringify(env.NODE_COMPILE_CACHE)});`,
              'assert.equal(process.env.NODE_COMPILE_CACHE_PORTABLE, "1");',
              "process.exitCode = 7;",
            ].join("\n"),
          ],
        }));
      try {
        const watched = spawnWatchedVitestProcess({
          pnpmArgs: ["exec", "node", ...flags, ...operands],
          spawnParams: { ...resolveVitestSpawnParams(env), stdio: ["ignore", "pipe", "pipe"] },
          env,
          homeMode: "hermetic",
        });
        expect((await watched.completion).code).toBe(7);
        expect(env.NODE_DISABLE_COMPILE_CACHE).toBe("0");
        expect(process.env.NODE_DISABLE_COMPILE_CACHE).toBe(parentCacheDisabled);
      } finally {
        command.mockRestore();
      }
    },
  );

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

  it.each(
    [
      [],
      ["test/scripts/run-vitest.test.ts"],
      ["./test/scripts"],
      ["./test/scripts/*.test.ts"],
      ["./test/scripts/run-vitest.test.ts", "--timeout=1"],
      ["./test/scripts/run-vitest.test.ts:1"],
      ["./../outside.test.ts"],
      ["./test/scripts/missing-native-bun-file.test.ts"],
    ].map((files) => ({ files })),
  )("rejects unbounded native Bun operands $files before launching", async ({ files }) => {
    const command = vi.spyOn(testRuntime, "resolveNativeBunTestCommand");
    try {
      await expect(runVitest(vi.fn(), ["--native-bun", ...files], {})).rejects.toThrow(
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

  posixIt(
    "runs the native Bun entrypoint with bounded arguments and preserves failure",
    async () => {
      const files = ["./test/scripts/run-vitest.test.ts"];
      const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
      const directory = tempDirs.make("oc-native-bun-cache-");
      const env = Object.freeze({
        NODE_COMPILE_CACHE: nodePath.join(directory, "node-cache"),
        NODE_COMPILE_CACHE_PORTABLE: "1",
        NODE_DISABLE_COMPILE_CACHE: "0",
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
      });
      const parentCacheDisabled = process.env.NODE_DISABLE_COMPILE_CACHE;
      const expectedCommand = testRuntime.resolveNativeBunTestCommand(files);
      expect(expectedCommand).toEqual({
        command: "bun",
        envOverrides: { NODE_DISABLE_COMPILE_CACHE: "1" },
        args: [
          "test",
          "--no-env-file",
          "--tsconfig-override",
          nodePath.join(repoRoot, "tsconfig.json"),
          "--preload",
          nodePath.join(repoRoot, "test/setup.env.ts"),
          "--timeout",
          "120000",
          ...files,
        ],
      });
      const command = vi.spyOn(testRuntime, "resolveNativeBunTestCommand").mockReturnValue({
        ...expectedCommand,
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
      });
      const exitCode = process.exitCode;
      try {
        await runVitest(vi.fn(), ["--native-bun", ...files], env);
        expect(command).toHaveBeenCalledWith(files);
        expect(process.exitCode).toBe(7);
        expect(env.NODE_DISABLE_COMPILE_CACHE).toBe("0");
        expect(process.env.NODE_DISABLE_COMPILE_CACHE).toBe(parentCacheDisabled);
      } finally {
        process.exitCode = exitCode;
        command.mockRestore();
      }
    },
  );

  posixIt("joins native Bun descendants when its CI parent disconnects", async ({ signal }) => {
    const fixture = [
      'const { spawn } = require("node:child_process");',
      'const descendant = spawn(process.execPath, ["-e",',
      '  "setInterval(() => {}, 1000); process.send(process.pid);",',
      '], { stdio: ["ignore", "ignore", "ignore", "ipc"] });',
      'descendant.once("message", (pid) => {',
      "  descendant.disconnect();",
      '  process.stdout.write(JSON.stringify({ child: process.pid, descendant: pid }) + "\\n");',
      "});",
      "descendant.unref();",
      "setInterval(() => {}, 1000);",
    ].join("\n");
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
        env: { ...process.env, OPENCLAW_NATIVE_BUN_PARENT_IPC: "1" },
      },
    );
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    // Explicit IPC disconnect can omit Node's aggregate close notification.
    // Observe termination and drain both pipes independently instead.
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
        child.once("error", reject);
      },
    );
    const joined = Promise.all([exited, finished(child.stdout!), finished(child.stderr!)]).then(
      ([result]) => result,
    );
    const lines = createInterface({ input: child.stdout! });
    let nativePid = 0;
    let descendantPid = 0;
    const ready = new Promise<void>((resolve, reject) => {
      lines.once("line", (line) => {
        try {
          const pids = JSON.parse(line);
          nativePid = pids.child;
          descendantPid = pids.descendant;
          expect(isProcessAlive(nativePid)).toBe(true);
          expect(isProcessAlive(descendantPid)).toBe(true);
          child.disconnect();
          resolve();
        } catch (error) {
          reject(new Error("Failed to verify native Bun child readiness", { cause: error }));
        }
      });
      lines.once("close", () => reject(new Error("native child closed before readiness")));
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
      expect(child.stdout!.readableEnded).toBe(true);
      expect(child.stderr!.readableEnded).toBe(true);
      expect(isProcessGroupStopped(child.pid!)).toBe(true);
      expect(isProcessGroupStopped(nativePid)).toBe(true);
    } finally {
      lines.close();
      forceKillVitestProcessGroup(child);
      if (nativePid) {
        forceKillVitestProcessGroup({ pid: nativePid });
      }
      await joined;
    }
  });

  it.each(["mjs", "mts"])(
    "resolves dependencies before native parsing at the %s entrypoint",
    (extension) => {
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
          nodePath.resolve(`scripts/run-vitest.${extension}`),
          "run",
          "--config",
          toolingConfig,
          file,
          "--testNamePattern=^dependency-order-no-test$",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${JSON.stringify(importUrl)}`]
              .filter(Boolean)
              .join(" "),
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Install dependencies before running scripts/run-vitest.mjs:",
      );
      expect(result.stderr).toContain("dependency request: vitest/package.json");
      expect(result.stderr).not.toContain("dependency request: vitest/node");
    },
  );

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

  it("isolates mixed directories while respecting explicit isolation", () => {
    const dirs = ["extensions/canvas", "src/node-host"];
    expect(resolveImplicitVitestArgs(dirs)).toEqual([...dirs, "--isolate"]);
    expect(resolveImplicitVitestArgs(dirs.slice(1))).toEqual(dirs.slice(1));
    expect(resolveImplicitVitestArgs([...dirs, "--no-isolate"])).toEqual([...dirs, "--no-isolate"]);
    expect(resolveImplicitVitestArgs([...dirs, "--", "--no-isolate"])).toEqual([
      ...dirs,
      "--isolate",
      "--",
      "--no-isolate",
    ]);
  });

  it("inserts bounded Gateway targets before the native separator", () => {
    const argv = ["run", "--config", gatewayConfig, "--reporter=verbose"];
    const targets = ["src/gateway/server-a.test.ts", "src/gateway/server-b.test.ts"];
    expect(
      resolveBoundedVitestInvocations([...argv, "--", "-x"], {
        env: {},
        gatewayServerTargetChunks: targets.map((target) => [target]),
      }),
    ).toEqual(targets.map((target) => argv.concat(target, "--", "-x")));
  });

  it("keeps every Gateway server file in one bounded native invocation", () => {
    const argv = ["--config", "/repo/" + gatewayConfig];
    const invocations = resolveBoundedVitestInvocations(argv, { env: { CI: "1" } });
    const targets = invocations.map((args) => args.slice(argv.length));

    expect(targets.every((files) => files.length > 0 && files.length <= 50)).toBe(true);
    expect(targets.flat()).toEqual(
      listGitTrackedFiles({ pathspecs: "src/gateway" })
        ?.filter(isGatewayServerTestFile)
        .toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("bounds the complete E2E selection without multiplying configured workers", () => {
    const argv = ["run", "--config", e2eConfig, "--maxWorkers", "2"];
    expect(resolveBoundedVitestInvocations(argv, { env: {} })).toEqual([
      [...argv, "--shard=1/4"],
      [...argv, "--shard=2/4"],
      [...argv, "--shard=3/4"],
      [...argv, "--shard=4/4"],
    ]);
  });

  it.each([
    ["doctor"],
    ["--", "doctor"],
    ["--shard=2/3"],
    ["--no-run"],
    ["--testNamePattern", "doctor"],
    ["--root", "/other"],
  ])("preserves explicit E2E execution options %j", (...options) => {
    const argv = ["run", "--config", e2eConfig, ...options];
    expect(resolveBoundedVitestInvocations(argv, { env: {} })).toEqual([argv]);
  });

  it.each([
    ["--config", gatewayConfig],
    ["watch", "--config", gatewayConfig],
    ["run", "--config", gatewayConfig, "src/gateway/server-startup.test.ts"],
    ["run", "--config", "test/vitest/vitest.gateway-core.config.ts"],
  ])("keeps direct Gateway selection %j", (...argv) => {
    expect(resolveBoundedVitestInvocations(argv, { env: {} })).toEqual([argv]);
  });

  it.each([
    ["--exclude=", file],
    ["--exclude=", "--passWithNoTests=false"],
    ["--", file],
  ])("keeps option operands out of implicit routing: %j", (...options) => {
    const argv = ["run", ...options];
    const native = parseCLI(["vitest", ...argv]);
    expect(native.filter).toEqual([]);
    expect(resolveTestProjectsDelegationArgs(argv)).toBeNull();
    expect(parseCLI(["vitest", ...resolveImplicitVitestArgs(argv)])).toEqual(native);
  });

  it("routes a positional UI test independently of excluded tooling files", () => {
    const argv = ["list", uiFile, "--exclude", file, "--passWithNoTests=false"];
    const native = parseCLI(["vitest", ...argv]);

    expect(native.filter).toEqual([uiFile]);
    expect(native.options.exclude).toEqual([file]);
    expect(native.options.passWithNoTests).toBe(false);
    expect(resolveTestProjectsDelegationArgs(argv)).toBeNull();
    expect(parseCLI(["vitest", ...resolveImplicitVitestArgs(argv)])).toEqual(
      parseCLI(["vitest", "--config", "test/vitest/vitest.ui.config.ts", ...argv]),
    );
  });

  it.each<[string, string | null]>([
    [file, toolingConfig],
    ["test/scripts/docker-build-helper.test.ts", "test/vitest/vitest.tooling-docker.config.ts"],
    ["test/plugins/bundled-provider-auth-literal-parity.test.ts", null],
  ])("routes the explicit tooling target %s", (target, config) => {
    const argv = ["run", target];
    expect(resolveImplicitVitestArgs(argv)).toEqual(
      config ? ["run", "--config", config, target] : argv,
    );
  });

  it.each([
    [],
    ["--passWithNoTests"],
    ["--passWithNoTests=", "false"],
    ["--no-passWithNoTests", "false"],
    ["--passWithNoTests=false", "--pass-with-no-tests=true"],
    ["--", "--passWithNoTests=true", "-x"],
  ])("enforces direct empty-file policy for %j", async (...flags) => {
    const argv = ["run", "--config", toolingConfig, file, ...flags];
    const original = [...argv];
    const native = parseCLI(["vitest", ...argv]);
    expect(parseCLI(["vitest", ...(await resolveExplicitTestFileNoPassArgs(argv))])).toEqual({
      ...native,
      options: { ...native.options, passWithNoTests: false },
    });
    expect(argv).toEqual(original);
  });

  it("preserves native invalid scalar errors", async () => {
    const argv = ["run", file, "--passWithNoTests", "--passWithNoTests"];
    let nativeError: unknown;
    try {
      parseCLI(["vitest", ...argv]);
    } catch (error) {
      nativeError = error;
    }
    expect(nativeError).toBeInstanceOf(Error);
    await expect(resolveExplicitTestFileNoPassArgs(argv)).rejects.toThrow(
      (nativeError as Error).message,
    );
  });

  it("does not force no-test failure for globs or basename filters", async () => {
    const argv = ["run", "run-vitest.test.ts", "test/**/*.test.ts"];
    expect(await resolveExplicitTestFileNoPassArgs(argv)).toBe(argv);
  });

  it.each([
    ["--passWithNoTests", "false"],
    ["--no-passWithNoTests", "false"],
    ["--passWithNoTests", "--passWithNoTests"],
    ["--configLoader=", "runner"],
  ])("round-trips native option ownership through delegation: %j", (...flags) => {
    const parse = (args: string[]) => {
      try {
        return parseCLI(["vitest", "run", ...args]);
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
    [[file + ":12"], null],
    [[file], [file]],
    [
      ["--reporter=verbose", "run", file, "--", "--watch"],
      [file, "--", "--reporter=verbose", "--watch"],
    ],
    [["test/scripts"], ["test/scripts"]],
    [["test/scripts/*.test.ts"], ["test/scripts/*.test.ts"]],
    [["src/agents/**/*.ts"], null],
    [["./src"], null],
    [["extensions/telegram/src/format"], ["extensions/telegram/src/format"]],
    [["extensions/codex"], ["extensions/codex"]],
    [["extensions/workboard/browser"], ["extensions/workboard/browser"]],
    [
      [agentDir, "--sequence.shuffle", "--sequence.seed", "3"],
      [agentDir, "--", "--sequence.shuffle", "--sequence.seed", "3"],
    ],
    [["extensions/codex/src"], null],
    [
      ["src/**/*.test.ts", "src/agents/bash-tools.ts"],
      ["src/**/*.test.ts", "src/agents/bash-tools.ts"],
    ],
    [["run", "--config", toolingConfig, file], null],
    [["--root", "packages/example", "src/example.test.ts"], null],
    [["--project", "tooling", file], null],
    [["related", "src/agents/bash-tools.ts"], null],
    [["--run", "false", file], null],
    [
      ["run", file, "--repeats", "19"],
      [file, "--", "--repeats", "19"],
    ],
  ])("preserves ownership and operands when delegating %j", (argv, expected) => {
    expect(resolveTestProjectsDelegationArgs(argv)).toEqual(expected);
  });

  it("reports missing explicit files before Vitest can fan out", () => {
    const source = "src/agents/bash-tools.ts";
    const missing = "extensions/codex/src/app-server/missing.ts";
    const fsImpl = { existsSync: (entry: string) => entry.replaceAll("\\", "/").endsWith(source) };
    expect(resolveMissingExplicitTestFiles([source, missing], "/repo", fsImpl)).toEqual([missing]);
  });

  it("ignores option operands and globs during missing-file preflight", () => {
    const argv = ["-t", "missing.test.ts", "basename.test.ts", "src/**/*.test.ts"];
    expect(resolveMissingExplicitTestFiles(argv, "/repo", { existsSync: () => false })).toEqual([]);
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

  it.each([
    [[browserFile], "test/vitest/vitest.ui-browser.config.ts"],
    [[jsdomFile], "test/vitest/vitest.ui.config.ts"],
    [[browserFile, jsdomFile], null],
    [["ui/src/**/*.browser.test.ts"], null],
    [["ui/src/components/markdown.progress.node.test.ts"], null],
  ])("preserves browser ownership for implicit targets %j", (targets, config) => {
    expect(resolveImplicitVitestArgs(["run", ...targets])).toEqual(
      config ? ["run", "--config", config, ...targets] : ["run", ...targets],
    );
  });

  it("keeps Sparkplug synchronous when Maglev is enabled", () => {
    expect(resolveVitestNodeArgs({ OPENCLAW_VITEST_ENABLE_MAGLEV: "1" })).toStrictEqual([
      "--no-concurrent-sparkplug",
    ]);
  });

  it("accepts only positive decimal no-output deadlines", () => {
    const timeout = (value?: string) =>
      resolveVitestNoOutputTimeoutMs({
        OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: value,
      });
    expect(timeout()).toBeNull();
    expect(timeout("2500")).toBe(2500);
    expect(timeout("0")).toBeNull();
    expect(timeout("1e3")).toBeNull();
  });

  it("defaults non-watch runs to the stall watchdog", () => {
    for (const argv of [
      ["run", "-t", "watch"],
      ["--watch", "false"],
      ["--watch=false"],
      ["--no-watch"],
    ]) {
      expect(resolveRunVitestSpawnEnv(baseEnv, argv)).toEqual(watchdogEnv(120000));
    }
    expect(resolveRunVitestSpawnEnv({ ...baseEnv, CI: "true" }, ["src/foo.test.ts"])).toEqual({
      ...watchdogEnv(120000),
      CI: "true",
    });
    const disabled = { ...baseEnv, OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0" };
    expect(resolveRunVitestSpawnEnv(disabled, ["run"])).toEqual(disabled);
  });

  it("honors measured config silence floors over smaller env timeouts", () => {
    const env = { ...baseEnv, OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "300000" };
    expect(
      resolveRunVitestSpawnEnv(env, [
        "run",
        "--config",
        "test/vitest/vitest.extension-codex.config.ts",
      ]),
    ).toEqual(watchdogEnv(2400000));
    expect(
      resolveRunVitestSpawnEnv(env, ["run", "--config", "test/vitest/vitest.unit.config.ts"]),
    ).toEqual(watchdogEnv(300000));
  });

  it("preserves inherited Node compile caches in test children", () => {
    const env = {
      ...baseEnv,
      CI: "true",
      NODE_COMPILE_CACHE: "/tmp/node-compile",
      NODE_COMPILE_CACHE_PORTABLE: "1",
    };
    for (const argv of [["run"], ["run", "--coverage=false"]]) {
      expect(resolveRunVitestSpawnEnv(env, argv)).toEqual({ ...watchdogEnv(120000), ...env });
    }
    expect(resolveRunVitestSpawnEnv(env, ["--watch"])).toEqual(env);
    expect(resolveVitestSpawnParams(env, "linux").env).toEqual({ ...env, ...PINNED_LOCALE });
  });

  describe("native config option ownership", () => {
    it.each([
      { name: "inline short", args: [`-c=${e2eConfig}`] },
      { name: "empty inline short", args: ["-c=", e2eConfig] },
    ])("uses the native $name config for its watchdog", ({ args }) => {
      const argv = ["run", ...args];
      expect(parseCLI(["vitest", ...argv]).options.config).toBe(e2eConfig);
      expect(resolveDefaultVitestNoOutputTimeoutMs(argv)).toBe(
        DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS,
      );
    });
    it.each([
      { name: "missing short inline value", args: [file, "-c="] },
      { name: "long after separator", args: [file, "--", "--config", e2eConfig] },
    ])("keeps $name with the direct native child", ({ args }) => {
      expect(resolveTestProjectsDelegationArgs(args)).toBeNull();
    });
  });

  it("leaves interactive runs without a default watchdog", () => {
    for (const argv of [["src/foo.test.ts"], ["--config", toolingConfig, "-t", "watch"]]) {
      expect(resolveRunVitestSpawnEnv(baseEnv, argv)).toEqual(baseEnv);
    }
  });

  it("detaches process groups only on Unix", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(resolveVitestSpawnParams(baseEnv, platform)).toEqual({
        env: { ...baseEnv, ...PINNED_LOCALE },
        detached: platform === "darwin",
        stdio: ["inherit", "pipe", "pipe"],
      });
    }
  });

  posixIt.for([
    { timeout: false, exitCode: 0, expectedCode: 0, nativeBun: false },
    { timeout: true, exitCode: 0, expectedCode: 1, nativeBun: false },
    { timeout: true, exitCode: 7, expectedCode: 7, nativeBun: false },
    { timeout: true, exitCode: null, expectedCode: null, nativeBun: false },
    { timeout: true, exitCode: 0, expectedCode: 1, nativeBun: true },
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
        [
          'const { spawn } = require("node:child_process");',
          row.exitCode === null
            ? ""
            : `process.once("SIGTERM", () => process.exit(${row.exitCode}));`,
          'const descendant = spawn(process.execPath, ["-e",',
          '  "setInterval(() => {}, 1000); process.send(process.pid);",',
          '], { stdio: ["ignore", "ignore", "ignore", "ipc"] });',
          'descendant.once("message", (pid) => {',
          "  descendant.disconnect();",
          row.nativeBun
            ? '  process.stdout.write(JSON.stringify({ pid, home: process.env.HOME, tmp: process.env.TMPDIR, live: process.env.OPENCLAW_LIVE_TEST, realHome: process.env.OPENCLAW_LIVE_USE_REAL_HOME }) + "\\n");'
            : "  process.stdout.write(`${pid}\\n`);",
          "});",
          "descendant.unref();",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
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
      const rawExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          watched.child.once("close", (code, closeSignal) =>
            resolve({ code, signal: closeSignal }),
          );
          watched.child.once("error", reject);
        },
      );
      let descendantPid = 0;
      let nativeTempRoot: string | undefined;
      const lines = createInterface({ input: watched.child.stdout! });
      const ready = new Promise<void>((resolve, reject) => {
        lines.once("line", (line) => {
          try {
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
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        lines.once("close", () => reject(new Error("fixture closed before reporting readiness")));
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
    { env: { LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" }, expected: {} },
    { env: { OPENCLAW_LOCAL_CHECK: "0" }, expected: { OPENCLAW_LOCAL_CHECK: "1" } },
    { env: { CI: "true", OPENCLAW_LOCAL_CHECK: "0" }, expected: {} },
    {
      env: { OPENCLAW_TEST_PROJECTS_SERIAL: "1" },
      expected: { RAYON_NUM_THREADS: "1", TOKIO_WORKER_THREADS: "1" },
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

  it.each([
    { ansi: false, origin: undefined },
    { ansi: true, origin: "fixture.test.ts" },
  ])("extracts unhandled errors (ANSI=$ansi, origin=$origin)", ({ ansi, origin }) => {
    const detector = createVitestUnhandledErrorDetector();
    const output = [
      "⎯⎯ Unhandled Errors ⎯⎯",
      "Vitest caught 1 unhandled error during the test run.",
      "⎯⎯ Unhandled Rejection ⎯⎯",
      "TypeError: request failed",
      ...(origin ? ['This error originated in "' + origin + '" test file.'] : []),
    ]
      .map((line) => (ansi ? "\u001b[31m" + line + "\u001b[0m" : line))
      .join("\n");
    detector.observe(output);
    expect(detector.finish()).toEqual({
      count: 1,
      errorFirstLine: "TypeError: request failed",
      origin,
    });
  });

  it("does not classify ordinary output as an unhandled error", () => {
    const detector = createVitestUnhandledErrorDetector();
    detector.observe("✓ fixture.test.ts (1 test)\n");
    expect(detector.finish()).toBeNull();
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

    it("resets the idle deadline on output and escalates a silent child", () => {
      const { stdout, onTimeout, onForceKill, log, watchdog } = setup();
      vi.advanceTimersByTime(900);
      expect(onTimeout).not.toHaveBeenCalled();
      stdout.emit("data", "still alive");
      vi.advanceTimersByTime(900);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        "[vitest] no output for 1000ms; terminating stalled Vitest process group.",
      );
      vi.advanceTimersByTime(5000);
      expect(onForceKill).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        "[vitest] process group still alive after 5000ms; sending SIGKILL.",
      );
      watchdog.teardown();
    });

    it.each(["output", "preparation"])("does not cancel force-kill on late %s", (activity) => {
      const { stdout, onTimeout, onForceKill, watchdog } = setup();
      vi.advanceTimersByTime(1000);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      if (activity === "output") {
        stdout.emit("data", "too late");
      } else {
        watchdog.recordActivity();
      }
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
