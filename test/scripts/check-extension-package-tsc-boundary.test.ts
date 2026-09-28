// Check Extension Package Tsc Boundary tests cover check extension package tsc boundary script behavior.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it as test } from "vitest";
import {
  formatBoundaryCheckSuccessSummary,
  formatSlowCompileSummary,
  formatSkippedCompileProgress,
  formatStepFailure,
  runNodeStepAsync,
  runNodeSteps,
} from "../../scripts/check-extension-package-tsc-boundary.mts";
import {
  isProcessAlive,
  waitForChildClose,
  waitForDead,
  waitForPidFile,
} from "../helpers/process-wait.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import {
  hasSemanticTestBackend,
  materializeNativeCompiler,
  semanticFixtureEnv,
  stopSemanticFixtureScopes,
} from "./native-boundary-fixture.js";

const tempRoots = new Set<string>();
// Only compiler executions require a kernel backend; formatting tests remain portable.
const it = test.runIf(hasSemanticTestBackend());

function createTempExtensionRoot(extensionId = "demo") {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-canary-"));
  tempRoots.add(rootDir);
  const extensionRoot = path.join(rootDir, "extensions", extensionId);
  fs.mkdirSync(extensionRoot, { recursive: true });
  return { rootDir, extensionRoot };
}

afterEach(() => {
  for (const rootDir of tempRoots) {
    stopSemanticFixtureScopes(rootDir);
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
  tempRoots.clear();
});

describe("check-extension-package-tsc-boundary", () => {
  it("compiles package roots and tracks exports and inherited paths", () => {
    const root = fs.realpathSync.native(createTempExtensionRoot().rootDir);
    const write = (file: string, contents: string) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
      fs.utimesSync(target, new Date(1000), new Date(1000));
    };
    write("package.json", '{"type":"module"}');
    write("pnpm-workspace.yaml", "packages: []\n");
    write("tsconfig.json", '{"compilerOptions":{"module":"NodeNext","strict":true,"types":[]}}');
    const pathsConfig = "extensions/tsconfig.package-boundary.paths.json";
    const config = {
      extends: "../tsconfig.json",
      compilerOptions: {
        paths: { "openclaw/plugin-sdk/*": ["../packages/plugin-sdk/dist/src/plugin-sdk/*.d.ts"] },
      },
    };
    write(pathsConfig, JSON.stringify(config));
    write(
      "extensions/tsconfig.package-boundary.base.json",
      '{"extends":"./tsconfig.package-boundary.paths.json","compilerOptions":{"rootDir":"${configDir}"},"include":["${configDir}/*.ts","${configDir}/src/**/*.ts"]}',
    );
    write("extensions/demo/tsconfig.json", '{"extends":"../tsconfig.package-boundary.base.json"}');
    write(
      "packages/plugin-sdk/dist/src/plugin-sdk/core.d.ts",
      "export type DemoContract = { ok: boolean };\n",
    );
    write(
      "extensions/demo/index.ts",
      'import type { DemoContract } from "openclaw/plugin-sdk/core";\nexport const demo: DemoContract = { ok: true };\nexport const marker: "ambient" = boundaryMarker;\n',
    );
    write("extensions/demo/src/environment.d.ts", 'declare const boundaryMarker: "ambient";\n');
    write(
      "extensions/larger/tsconfig.json",
      '{"extends":"../tsconfig.package-boundary.base.json"}',
    );
    write("extensions/larger/index.ts", 'export { value } from "./src/value.js";\n');
    write(
      "extensions/larger/src/value.ts",
      `export const value = ${JSON.stringify("x".repeat(2000))};\n`,
    );
    const demoPackage = {
      name: "@openclaw/demo",
      exports: { ".": "./dist/index.js" },
      openclaw: {
        extensions: ["./index.ts"],
        build: { workerEntries: ["./src/worker.ts"] },
      },
    };
    write("extensions/demo/package.json", JSON.stringify(demoPackage));
    write("extensions/demo/openclaw.plugin.json", '{"id":"demo"}');
    write("extensions/larger/package.json", '{"name":"@openclaw/larger"}');
    write("extensions/demo/src/worker.ts", "export const worker = true;\n");
    write("extensions/demo/test-api.ts", 'export * from "./src/private.test-helper.js";\n');
    write(
      "extensions/demo/src/private.test-helper.ts",
      'export const value: number = "invalid";\n',
    );
    // Hold preparation fixed; scheduling, config parsing, and compilation remain real.
    write(
      "scripts/prepare-extension-package-boundary-artifacts.mts",
      "export async function prepareExtensionPackageBoundaryArtifacts() {}\n",
    );
    for (const file of [
      "check-extension-package-tsc-boundary.mts",
      "compile-extension-boundary.mts",
      "check-file-utils.ts",
      "tsx.mjs",
      "windows-cmd-helpers.mjs",
    ]) {
      write(`scripts/${file}`, fs.readFileSync(path.resolve("scripts", file), "utf8"));
    }
    materializeNativeCompiler(root);
    for (const file of [
      "scripts/lib",
      "packages/normalization-core/src",
      "packages/normalization-core/package.json",
      "src/shared/non-packaged-plugin-dirs.ts",
      "src/plugins/package-entrypoints.ts",
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.cpSync(path.resolve(file), path.join(root, file), { recursive: true });
    }
    for (const name of ["tsx", "@openclaw/fs-safe", "p-map"]) {
      const file = `node_modules/${name}`;
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.symlinkSync(path.resolve(file), path.join(root, file));
    }
    const run = () =>
      spawnSync(
        process.execPath,
        ["scripts/check-extension-package-tsc-boundary.mts", "--mode=compile"],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 20_000,
          env: semanticFixtureEnv(root),
        },
      );
    const cold = run();
    expect(cold.error, cold.stderr).toBeUndefined();
    expect(cold.status, cold.stdout + cold.stderr).toBe(0);
    expect(cold.stdout).toContain("compiled plugins: 2");
    expect(cold.stdout.indexOf("] larger")).toBeLessThan(cold.stdout.indexOf("] demo"));
    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(root, ".artifacts/extension-package-boundary/compile/demo.inputs.json"),
        "utf8",
      ),
    );
    expect(receipt.inputs.some((file: string) => file.endsWith("/demo/src/worker.ts"))).toBe(true);
    const warm = run();
    expect(warm.status, warm.stdout + warm.stderr).toBe(0);
    expect(warm.stdout).toContain("compiled plugins: 0");
    expect(warm.stdout).toContain("skipped plugins: 2");
    write(
      "extensions/demo/package.json",
      JSON.stringify({
        ...demoPackage,
        exports: { ...demoPackage.exports, "./test-api.js": "./test-api.ts" },
      }),
    );
    const exportedTestApi = run();
    expect(exportedTestApi.status, exportedTestApi.stdout + exportedTestApi.stderr).toBe(1);
    expect(exportedTestApi.stderr).toContain("TS2322");
    write("extensions/demo/package.json", JSON.stringify(demoPackage));
    write("extensions/outside.ts", "export const outside = true;\n");
    write("extensions/demo/src/worker.ts", 'export { outside } from "../../outside.js";\n');
    const escapingWorker = run();
    expect(escapingWorker.status, escapingWorker.stdout + escapingWorker.stderr).toBe(1);
    expect(escapingWorker.stderr).toContain("TS6059");
    write("extensions/demo/src/worker.ts", "export const worker = true;\n");
    config.compilerOptions.paths["openclaw/plugin-sdk/*"] = ["../missing-sdk/*.d.ts"];
    write(pathsConfig, JSON.stringify(config));
    const changed = run();
    expect(changed.error, changed.stderr).toBeUndefined();
    expect(changed.status, changed.stdout + changed.stderr).toBe(1);
    expect(changed.stderr).toContain("TS2307");
    expect(
      fs.existsSync(path.join(root, ".artifacts/extension-package-boundary/compile/demo.json")),
    ).toBe(false);
  }, 30_000);
  it("keeps matching canary diagnostics classified as a timeout when the compiler never exits", async () => {
    const diagnostic = "TS6059 src/plugins/contracts/rootdir-boundary-canary.ts";
    await expect(
      runNodeStepAsync(
        "canary fixture",
        ["-e", `console.log(${JSON.stringify(diagnostic)});setInterval(()=>{},1000);`],
        2000,
      ),
    ).rejects.toMatchObject({ kind: "timeout", fullOutput: expect.stringContaining(diagnostic) });
  });
  test("summarizes long failure output with the useful tail", () => {
    const stdout = Array.from({ length: 45 }, (_, index) => `stdout ${index + 1}`).join("\n");
    const stderr = Array.from({ length: 3 }, (_, index) => `stderr ${index + 1}`).join("\n");

    const message = formatStepFailure("demo-plugin", {
      stdout,
      stderr,
      kind: "timeout",
      elapsedMs: 4_321,
      note: "demo-plugin timed out after 5000ms",
    });
    const messageLines = message.split("\n");

    expect(message).toContain("demo-plugin");
    expect(message).toContain("[... 5 earlier lines omitted ...]");
    expect(message).toContain("kind: timeout");
    expect(message).toContain("elapsed: 4321ms");
    expect(message).toContain("stdout 45");
    expect(messageLines).not.toContain("stdout 1");
    expect(message).toContain("stderr:\nstderr 1\nstderr 2\nstderr 3");
    expect(message).toContain("demo-plugin timed out after 5000ms");
  });

  test("formats a success summary with counts and elapsed time", () => {
    expect(
      formatBoundaryCheckSuccessSummary({
        mode: "all",
        compileCount: 84,
        skippedCompileCount: 13,
        canaryCount: 12,
        prepElapsedMs: 12_345,
        compileElapsedMs: 54_321,
        canaryElapsedMs: 6_789,
        elapsedMs: 54_321,
      }),
    ).toBe(
      [
        "extension package boundary check passed",
        "mode: all",
        "compiled plugins: 84",
        "skipped plugins: 13",
        "canary plugins: 12",
        "prep elapsed: 12345ms",
        "compile elapsed: 54321ms",
        "canary elapsed: 6789ms",
        "elapsed: 54321ms",
        "",
      ].join("\n"),
    );
  });

  test("omits phase timings that never ran", () => {
    expect(
      formatBoundaryCheckSuccessSummary({
        mode: "compile",
        compileCount: 97,
        skippedCompileCount: 0,
        canaryCount: 0,
        prepElapsedMs: 12_345,
        compileElapsedMs: 54_321,
        canaryElapsedMs: 0,
        elapsedMs: 66_666,
      }),
    ).toBe(
      [
        "extension package boundary check passed",
        "mode: compile",
        "compiled plugins: 97",
        "canary plugins: 0",
        "prep elapsed: 12345ms",
        "compile elapsed: 54321ms",
        "elapsed: 66666ms",
        "",
      ].join("\n"),
    );
  });

  test("formats skipped compile progress concisely", () => {
    expect(
      formatSkippedCompileProgress({
        skippedCount: 13,
        totalCount: 97,
      }),
    ).toBe("skipped 13 fresh plugin compiles before running 84 stale plugin checks\n");

    expect(
      formatSkippedCompileProgress({
        skippedCount: 97,
        totalCount: 97,
      }),
    ).toBe("skipped 97 fresh plugin compiles\n");
  });

  test("formats the slowest plugin compiles in descending order", () => {
    expect(
      formatSlowCompileSummary({
        compileTimings: [
          { extensionId: "quick", elapsedMs: 40 },
          { extensionId: "slow", elapsedMs: 900 },
          { extensionId: "medium", elapsedMs: 250 },
        ],
        limit: 2,
      }),
    ).toBe(["slowest plugin compiles:", "- slow: 900ms", "- medium: 250ms", ""].join("\n"));
  });

  it("keeps full failure output on the thrown error for canary detection", async () => {
    const failure = await runNodeStepAsync(
      "demo-plugin",
      [
        "--eval",
        [
          "console.log('src/plugins/contracts/rootdir-boundary-canary.ts');",
          "for (let index = 1; index <= 45; index += 1) console.log(`stdout ${index}`);",
          "console.error('TS6059');",
          "process.exit(2);",
        ].join(" "),
      ],
      20_000,
    ).then(
      () => {
        throw new Error("expected demo-plugin step to fail");
      },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected failed canary step to reject with an Error");
    }
    expect(failure.message).toContain("[... 6 earlier lines omitted ...]");
    const failureMetadata = failure as {
      elapsedMs?: unknown;
      fullOutput?: unknown;
      kind?: unknown;
      exitCode?: unknown;
    };
    expect(failureMetadata.fullOutput).toContain(
      "src/plugins/contracts/rootdir-boundary-canary.ts",
    );
    expect(failureMetadata.kind).toBe("nonzero-exit");
    expect(failureMetadata.exitCode).toBe(2);
    const elapsedMs = failureMetadata.elapsedMs;
    expect(typeof elapsedMs).toBe("number");
    if (typeof elapsedMs !== "number") {
      throw new Error("expected failure elapsedMs to be a number");
    }
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("clamps oversized async node step timers before scheduling", async () => {
    await expect(
      runNodeStepAsync(
        "slow-success",
        ["--eval", "setTimeout(() => process.exit(0), 25);"],
        Number.MAX_SAFE_INTEGER,
      ),
    ).resolves.toMatchObject({
      stderr: "",
      stdout: "",
    });
  });

  it("keeps async node step failure output bounded", async () => {
    const failure = await runNodeStepAsync(
      "noisy-plugin",
      [
        "--eval",
        [
          "process.stdout.write('stdout-begin-' + 'x'.repeat(300000) + '-stdout-end');",
          "process.stderr.write('stderr-begin-' + 'y'.repeat(300000) + '-stderr-end');",
          "process.exitCode = 2;",
        ].join("\n"),
      ],
      20_000,
    ).then(
      () => {
        throw new Error("expected noisy-plugin step to fail");
      },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected failed noisy step to reject with an Error");
    }
    expect(failure.message).toContain("[output truncated");
    expect(failure.message).toContain("stdout-end");
    expect(failure.message).toContain("stderr-end");
    expect(failure.message).not.toContain("stdout-begin");
    expect(failure.message).not.toContain("stderr-begin");
    const fullOutput = (failure as { fullOutput?: unknown }).fullOutput;
    expect(typeof fullOutput).toBe("string");
    if (typeof fullOutput !== "string") {
      throw new Error("expected failure fullOutput to be a string");
    }
    expect(fullOutput.length).toBeLessThan(600_000);
  }, 30_000);

  test.runIf(hasSemanticTestBackend())(
    "waits for timed-out async node step process groups",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-tsc-timeout-"));
      tempRoots.add(root);
      const childPidPath = path.join(root, "child.pid");
      let childPid = 0;
      const childScript = ["process.on('SIGTERM', () => {});", "setInterval(() => {}, 1000);"].join(
        "",
      );
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("");

      const releaseAndWait = startProcessWatchdogFixture(() =>
        runNodeStepAsync("hung-step-group", ["--eval", parentScript], 100),
      );
      try {
        childPid = await waitForPidFile(childPidPath, 2_000);
        expect(isProcessAlive(childPid)).toBe(true);

        await expect(releaseAndWait()).rejects.toThrow("hung-step-group timed out after 100ms");
        await waitForDead(childPid, 2_000);
      } finally {
        await releaseAndWait().catch(() => undefined);
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }
    },
  );

  it("joins each compiler before starting the next and stops after failure", async () => {
    const order: string[] = [];
    await expect(
      runNodeSteps(
        [0, 2, 0].map((exitCode, index) => ({
          label: "step-" + index,
          args: ["--eval", "process.exitCode = " + exitCode],
          timeoutMs: 20_000,
          onStart() {
            order.push("start-" + index);
          },
          onSuccess() {
            order.push("done-" + index);
          },
        })),
      ),
    ).rejects.toMatchObject({ kind: "nonzero-exit", exitCode: 2 });
    expect(order).toEqual(["start-0", "done-0", "start-1"]);
  });

  it("joins an aborted compiler's descendants before returning", async ({ signal }) => {
    const { rootDir: root } = createTempExtensionRoot("abort-group");
    const childPidPath = path.join(root, "child.pid");
    const controller = new AbortController();
    const source = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
      "fs.writeFileSync(" + JSON.stringify(childPidPath) + ", String(child.pid));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("");
    const command = runNodeStepAsync("aborted-step-group", ["--eval", source], 60_000, {
      signal: AbortSignal.any([signal, controller.signal]),
    });
    const outcome = command.catch((error: unknown) => error);
    try {
      const childPid = await waitForPidFile(childPidPath, Number.POSITIVE_INFINITY, (ms) =>
        delay(ms, undefined, { signal }),
      );
      expect(isProcessAlive(childPid)).toBe(true);
      controller.abort();
      expect(await outcome).toMatchObject({ kind: "canceled" });
      await waitForDead(childPid, 2_000);
    } finally {
      controller.abort();
      await outcome;
    }
  });

  it("cleans active async node step descendants before forwarding parent SIGTERM", async ({
    signal,
  }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-tsc-signal-"));
    tempRoots.add(root);
    const childPidPath = path.join(root, "child.pid");
    const scriptUrl = pathToFileURL(
      path.resolve("scripts/check-extension-package-tsc-boundary.mts"),
    ).href;
    let childPid = 0;
    let runner: ReturnType<typeof spawn> | undefined;
    const childScript = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      // Write the pid atomically: writeFileSync makes the file visible at open() (0 bytes)
      // before the content lands, so an existsSync-then-read poller can catch an empty file
      // and parse NaN. Rename only publishes the path once the pid is fully written.
      `const pidPath = ${JSON.stringify(childPidPath)};`,
      "fs.writeFileSync(pidPath + '.tmp', String(process.pid));",
      "fs.renameSync(pidPath + '.tmp', pidPath);",
      "setInterval(() => {}, 1000);",
    ].join("");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGTERM', () => process.exit(0));",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'inherit'] });`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const runnerScript = [
      `import { runNodeStepAsync } from ${JSON.stringify(scriptUrl)};`,
      `import { runCancelableCommand } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/cancelable-command.mts")).href)};`,
      // Exercise cold startup beyond the former two-second readiness deadline.
      "await new Promise((resolve) => setTimeout(resolve, 3100));",
      `process.exitCode = await runCancelableCommand(async (signal) => { await runNodeStepAsync('parent-signal-step-group', ['--eval', ${JSON.stringify(parentScript)}], 60_000, { signal }); return 0; });`,
    ].join("\n");

    const runnerEnded = new AbortController();
    const readinessSignal = AbortSignal.any([signal, runnerEnded.signal]);
    try {
      runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "inherit"],
        env: semanticFixtureEnv(root),
      });
      runner.once("exit", () => runnerEnded.abort(new Error("Runner exited before readiness")));
      runner.once("error", (error) => runnerEnded.abort(error));

      // The child publishes readiness after both signal handlers are installed.
      // Observe that state under the test/runner lifetime, not delayed FS notices.
      childPid = await waitForPidFile(childPidPath, Number.POSITIVE_INFINITY, (ms) =>
        delay(ms, undefined, { signal: readinessSignal }),
      );
      readinessSignal.throwIfAborted();
      expect(isProcessAlive(childPid)).toBe(true);

      // Managed cancellation allows a five-second grace before force-kill, followed
      // by scope drainage. Observe close under the test lifetime, not a competing fuse.
      const closed = once(runner, "close", { signal });
      runner.kill("SIGTERM");
      await expect(closed).resolves.toEqual([143, null]);
      await waitForDead(childPid, 2_000);
    } finally {
      if (runner?.pid && isProcessAlive(runner.pid)) {
        runner.kill("SIGKILL");
        await waitForChildClose(runner);
      }
      stopSemanticFixtureScopes(root);
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  });

  it("passes successful step timing metadata to onSuccess handlers", async () => {
    const elapsedTimes: number[] = [];

    await runNodeSteps([
      {
        label: "demo-step",
        args: ["--eval", "process.exit(0)"],
        timeoutMs: 20_000,
        onSuccess(result: { elapsedMs: number }) {
          elapsedTimes.push(result.elapsedMs);
        },
      },
    ]);

    expect(elapsedTimes).toHaveLength(1);
    expect(elapsedTimes[0]).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
