import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, expect, it, type TestContext } from "vitest";
import {
  formatBoundaryCheckSuccessSummary,
  formatSlowCompileSummary,
  formatSkippedCompileProgress,
  installCanaryArtifactCleanup,
  resolveCompileConcurrency,
  resolveCanaryArtifactPaths,
  runNodeStepAsync,
  runNodeStepsWithConcurrency,
} from "../../scripts/check-extension-package-tsc-boundary.mts";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { withinTest } from "../helpers/promise.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";
import { materializeNativeCompiler } from "./native-boundary-fixture.js";

const tempRoots = createTempDirTracker();
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

async function fixturePidBeforeSettlement(pidPath: string, operation: PromiseLike<unknown>) {
  const readPid = (error: unknown = new Error(`timeout waiting for pid in ${pidPath}`)) => {
    const pid = fs.existsSync(pidPath) ? Number(fs.readFileSync(pidPath, "utf8")) : 0;
    if (!Number.isInteger(pid) || pid <= 0) {
      throw error;
    }
    return pid;
  };
  // The fixture writes the PID before its receipt; a separate output/exit can arrive first.
  const settled = Promise.resolve(operation).then(
    () => readPid(),
    (error: unknown) => readPid(error),
  );
  return await Promise.race([receipts.waitFor(pidPath, "ready").then(() => readPid()), settled]);
}

async function waitForFixtureExit(pid: number, signal: AbortSignal) {
  // Strict group cleanup can leave Darwin zombies awaiting the OS reaper. These foreign
  // PIDs have no child handle; only the test lifetime bounds their final disappearance.
  while (isProcessAlive(pid)) {
    await delay(5, undefined, { signal }).catch((error: unknown) => {
      throw new Error(`process still alive: ${pid}`, { cause: error });
    });
  }
}

function expectCompile(result: SpawnSyncReturns<string>, status: number, ...output: string[]) {
  expect(result.status, result.stdout + result.stderr).toBe(status);
  for (const text of output) {
    expect(status === 0 ? result.stdout : result.stderr).toContain(text);
  }
}

async function failedStep(label: string, source: string) {
  const failure: unknown = await runNodeStepAsync(label, ["--eval", source], 20_000).then(
    () => {
      throw new Error("expected step to reject");
    },
    (error: unknown) => error,
  );
  assert(failure instanceof Error, "expected failed step to reject with an Error");
  return failure;
}

function descendantScript(childPidPath: string, atomic = false) {
  return [
    fixtureReceiptClientSource(receipts.endpoint),
    "import fs from 'node:fs';",
    "process.on('SIGTERM', () => {});",
    `const pidPath = ${JSON.stringify(childPidPath)};`,
    // The signal test publishes atomically before its parent can observe the file.
    atomic
      ? "fs.writeFileSync(pidPath + '.tmp', String(process.pid)); fs.renameSync(pidPath + '.tmp', pidPath);"
      : "fs.writeFileSync(pidPath, String(process.pid));",
    "sendReceipt(pidPath, 'ready');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

function parentScript(childScript: string, exitOnSignal = true) {
  return [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'inherit'] });`,
    exitOnSignal ? "process.on('SIGTERM', () => process.exit(0));" : "",
    "setInterval(() => {}, 1000);",
  ].join("");
}

async function runningGroup(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  root: string,
  operation: PromiseLike<unknown>,
  settle: () => PromiseLike<unknown>,
) {
  let childPid = 0;
  context.onTestFinished(async () => {
    await settle();
    if (childPid && isProcessAlive(childPid)) {
      process.kill(childPid, "SIGKILL");
    }
  });
  childPid = await withinTest(
    fixturePidBeforeSettlement(path.join(root, "child.pid"), operation),
    context.signal,
  );
  expect(isProcessAlive(childPid)).toBe(true);
  return () => waitForFixtureExit(childPid, context.signal);
}

beforeEach(({ onTestFinished }) => {
  // Register first so process cleanup runs before removing files still owned by a child.
  onTestFinished(tempRoots.cleanup);
});

it("compiles packaged roots and invalidates them when exports or inherited paths change", () => {
  const root = tempRoots.make("openclaw-boundary-canary-");
  const write = (file: string, contents: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    fs.utimesSync(target, new Date(1000), new Date(1000));
  };
  const pathsConfig = "extensions/tsconfig.package-boundary.paths.json";
  const config = {
    extends: "../tsconfig.json",
    compilerOptions: {
      paths: { "openclaw/plugin-sdk/*": ["../packages/plugin-sdk/dist/src/plugin-sdk/*.d.ts"] },
    },
  };
  const demoPackage = {
    name: "@openclaw/demo",
    exports: { ".": "./dist/index.js" },
    openclaw: { extensions: ["./index.ts"], build: { workerEntries: ["./src/worker.ts"] } },
  };
  for (const [file, source] of Object.entries({
    "package.json": '{"type":"module"}',
    "pnpm-workspace.yaml": "packages: []\n",
    "tsconfig.json": '{"compilerOptions":{"module":"NodeNext","strict":true,"types":[]}}',
    [pathsConfig]: JSON.stringify(config),
    "extensions/tsconfig.package-boundary.base.json":
      '{"extends":"./tsconfig.package-boundary.paths.json","compilerOptions":{"rootDir":"${configDir}"},"include":["${configDir}/*.ts","${configDir}/src/**/*.ts"]}',
    "extensions/demo/tsconfig.json": '{"extends":"../tsconfig.package-boundary.base.json"}',
    "packages/plugin-sdk/dist/src/plugin-sdk/core.d.ts":
      "export type DemoContract = { ok: boolean };\n",
    "extensions/demo/index.ts":
      'import type { DemoContract } from "openclaw/plugin-sdk/core";\nexport const demo: DemoContract = { ok: true };\nexport const marker: "ambient" = boundaryMarker;\n',
    "extensions/demo/src/environment.d.ts": 'declare const boundaryMarker: "ambient";\n',
    "extensions/larger/tsconfig.json": '{"extends":"../tsconfig.package-boundary.base.json"}',
    "extensions/larger/index.ts": 'export { value } from "./src/value.js";\n',
    "extensions/larger/src/value.ts": `export const value = ${JSON.stringify("x".repeat(2000))};\n`,
    "extensions/demo/package.json": JSON.stringify(demoPackage),
    "extensions/demo/openclaw.plugin.json": '{"id":"demo"}',
    "extensions/larger/package.json": '{"name":"@openclaw/larger"}',
    "extensions/demo/src/worker.ts": "export const worker = true;\n",
    "extensions/demo/test-api.ts": 'export * from "./src/private.test-helper.js";\n',
    "extensions/demo/src/private.test-helper.ts": 'export const value: number = "invalid";\n',
  })) {
    write(file, source);
  }
  // Hold preparation fixed; scheduling, config parsing, and compilation remain real.
  write("scripts/prepare-extension-package-boundary-artifacts.mts", "export {};\n");
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
        env: { ...process.env, OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY: "1" },
      },
    );
  const cold = run();
  expect(cold.error, cold.stderr).toBeUndefined();
  expectCompile(cold, 0, "compiled plugins: 2");
  expect(cold.stdout.indexOf("] larger")).toBeLessThan(cold.stdout.indexOf("] demo"));
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(root, ".artifacts/extension-package-boundary/compile/demo.inputs.json"),
      "utf8",
    ),
  );
  expect(receipt.inputs.some((file: string) => file.endsWith("/demo/src/worker.ts"))).toBe(true);
  expectCompile(run(), 0, "compiled plugins: 0", "skipped plugins: 2");
  write("test/new-unrelated.test.ts", 'export const unrelated: number = "invalid";\n');
  expectCompile(run(), 0, "compiled plugins: 0", "skipped plugins: 2");
  write(
    "extensions/demo/package.json",
    JSON.stringify({
      ...demoPackage,
      exports: { ...demoPackage.exports, "./test-api.js": "./test-api.ts" },
    }),
  );
  expectCompile(run(), 1, "TS2322");
  write("extensions/demo/package.json", JSON.stringify(demoPackage));
  write("extensions/outside.ts", "export const outside = true;\n");
  write("extensions/demo/src/worker.ts", 'export { outside } from "../../outside.js";\n');
  expectCompile(run(), 1, "TS6059");
  write("extensions/demo/src/worker.ts", "export const worker = true;\n");
  config.compilerOptions.paths["openclaw/plugin-sdk/*"] = ["../missing-sdk/*.d.ts"];
  write(pathsConfig, JSON.stringify(config));
  const changed = run();
  expect(changed.error, changed.stderr).toBeUndefined();
  expectCompile(changed, 1, "TS2307");
  expect(
    fs.existsSync(path.join(root, ".artifacts/extension-package-boundary/compile/demo.json")),
  ).toBe(false);
}, 30_000);
it("cleans stale artifacts for every extension id passed to the cleanup hook", () => {
  const rootDir = tempRoots.make("openclaw-boundary-canary-");
  const artifacts = ["demo-a", "demo-b"].flatMap((id) => {
    const { canaryPath, tsconfigPath } = resolveCanaryArtifactPaths(id, rootDir);
    fs.mkdirSync(path.dirname(canaryPath), { recursive: true });
    fs.writeFileSync(canaryPath, "export {};\n", "utf8");
    fs.writeFileSync(tsconfigPath, '{ "extends": "./tsconfig.json" }\n', "utf8");
    return [canaryPath, tsconfigPath];
  });
  const processObject = new EventEmitter();
  const teardown = installCanaryArtifactCleanup(["demo-a", "demo-b"], {
    processObject,
    rootDir,
  });

  processObject.emit("exit");
  teardown();

  expect(artifacts.map((file) => fs.existsSync(file))).toEqual([false, false, false, false]);
});

it("parses extension boundary compile concurrency strictly", () => {
  expect(resolveCompileConcurrency({ OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY: "4" }, 32)).toBe(4);
  expect(resolveCompileConcurrency({}, 12)).toBe(6);
  expect(resolveCompileConcurrency({}, 3)).toBe(1);
  expect(resolveCompileConcurrency({ OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY: "16" }, 16)).toBe(8);
  expect(resolveCompileConcurrency({ OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY: "16" }, 2)).toBe(1);
  for (const value of ["4x", "0", "1e3"]) {
    expect(() =>
      resolveCompileConcurrency({ OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY: value }, 32),
    ).toThrow("OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY must be a positive integer");
  }
});

it("formats a success summary with counts and elapsed time", () => {
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
  ).toBe(`extension package boundary check passed
mode: all
compiled plugins: 84
skipped plugins: 13
canary plugins: 12
prep elapsed: 12345ms
compile elapsed: 54321ms
canary elapsed: 6789ms
elapsed: 54321ms
`);
});

it("formats skipped compile progress concisely", () => {
  expect(formatSkippedCompileProgress({ skippedCount: 13, totalCount: 97 })).toBe(
    "skipped 13 fresh plugin compiles before running 84 stale plugin checks\n",
  );
  expect(formatSkippedCompileProgress({ skippedCount: 97, totalCount: 97 })).toBe(
    "skipped 97 fresh plugin compiles\n",
  );
});

it("formats the slowest plugin compiles in descending order", () => {
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
  const failure = await failedStep(
    "demo-plugin",
    [
      "console.log('src/plugins/contracts/rootdir-boundary-canary.ts');",
      "for (let index = 1; index <= 45; index += 1) console.log(`stdout ${index}`);",
      "console.error('TS6059');",
      "process.exit(2);",
    ].join(" "),
  );
  expect(failure.message).toContain("[... 6 earlier lines omitted ...]");
  expect(failure.message.split("\n")).not.toContain("stdout 1");
  expect(failure.message).toContain("stdout 45");
  expect(failure.message).toContain("stderr:\nTS6059");
  const failureMetadata = failure as {
    elapsedMs?: unknown;
    fullOutput?: unknown;
    kind?: unknown;
    status?: unknown;
  };
  expect(failureMetadata.fullOutput).toContain("src/plugins/contracts/rootdir-boundary-canary.ts");
  expect(failureMetadata.kind).toBe("nonzero-exit");
  expect(failureMetadata.status).toBeUndefined();
  const elapsedMs = failureMetadata.elapsedMs;
  assert(typeof elapsedMs === "number", "expected failure elapsedMs to be a number");
  expect(elapsedMs).toBeGreaterThanOrEqual(0);
}, 30_000);

it("keeps async node step failure output bounded", async () => {
  const failure = await failedStep(
    "noisy-plugin",
    [
      "process.stdout.write('stdout-begin-' + 'x'.repeat(300000) + '-stdout-end');",
      "process.stderr.write('stderr-begin-' + 'y'.repeat(300000) + '-stderr-end');",
      "process.exitCode = 2;",
    ].join("\n"),
  );
  expect(failure.message).toContain("[output truncated");
  expect(failure.message).toContain("stdout-end");
  expect(failure.message).toContain("stderr-end");
  expect(failure.message).not.toContain("stdout-begin");
  expect(failure.message).not.toContain("stderr-begin");
  const fullOutput = (failure as { fullOutput?: unknown }).fullOutput;
  assert(typeof fullOutput === "string", "expected failure fullOutput to be a string");
  expect(fullOutput.length).toBeLessThan(600_000);
}, 30_000);

it.skipIf(process.platform === "win32").for(["timeout", "sibling abort"])(
  "waits for async node step descendants after %s",
  async (mode, context) => {
    const root = tempRoots.make("openclaw-extension-tsc-group-");
    const script = parentScript(descendantScript(path.join(root, "child.pid")), mode !== "timeout");
    const abortAckPath = path.join(root, "abort.ack");
    let command: Promise<unknown>;
    let release: () => Promise<unknown>;
    if (mode === "timeout") {
      release = startProcessWatchdogFixture(
        () => (command = runNodeStepAsync("hung-step-group", ["--eval", script], 100)),
      );
    } else {
      // Fail only after the child-alive assertion, not on a wall-clock race.
      const failAfterTestAckScript = [
        "const fs = require('node:fs');",
        `const ackPath = ${JSON.stringify(abortAckPath)};`,
        "const wait = () => { if (fs.existsSync(ackPath)) process.exit(2); else setTimeout(wait, 10); };",
        "wait();",
      ].join("");
      command = runNodeStepsWithConcurrency(
        [
          { label: "fail-fast", args: ["--eval", failAfterTestAckScript], timeoutMs: 5_000 },
          { label: "aborted-step-group", args: ["--eval", script], timeoutMs: 60_000 },
        ],
        2,
      );
      release = () => {
        fs.writeFileSync(abortAckPath, "go");
        return command;
      };
    }
    const exited = await runningGroup(context, root, command!, () =>
      release().catch(() => undefined),
    );
    await expect(withinTest(release(), context.signal)).rejects.toThrow(
      mode === "timeout" ? "hung-step-group timed out after 100ms" : "fail-fast",
    );
    await exited();
  },
);

it.skipIf(process.platform === "win32")(
  "cleans active async node step descendants before forwarding parent SIGTERM",
  async (context) => {
    const root = tempRoots.make("openclaw-extension-tsc-signal-");
    const childPidPath = path.join(root, "child.pid");
    const scriptUrl = pathToFileURL(
      path.resolve("scripts/check-extension-package-tsc-boundary.mts"),
    ).href;
    const script = parentScript(descendantScript(childPidPath, true));
    const runnerScript = [
      `import { runNodeStepAsync } from ${JSON.stringify(scriptUrl)};`,
      // Exercise cold startup beyond the former two-second readiness deadline.
      "await new Promise((resolve) => setTimeout(resolve, 3100));",
      `try { await runNodeStepAsync('parent-signal-step-group', ['--eval', ${JSON.stringify(
        script,
      )}], 60_000); } catch (error) { if (process.exitCode !== 143) { console.error(error); process.exitCode = 1; } }`,
    ].join("\n");

    const runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "inherit"],
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        runner.once("error", reject);
        runner.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
      },
    );
    const exited = await runningGroup(context, root, closed, async () => {
      if (runner.pid && isProcessAlive(runner.pid)) {
        runner.kill("SIGTERM");
      }
      await closed;
    });
    runner.kill("SIGTERM");
    await expect(withinTest(closed, context.signal)).resolves.toEqual({ code: 143, signal: null });
    await exited();
  },
);

it("clamps oversized step timers and passes successful output and timing to onSuccess", async () => {
  const elapsedTimes: number[] = [];

  await runNodeStepsWithConcurrency(
    [
      {
        label: "demo-step",
        args: ["--eval", "setTimeout(() => process.exit(0), 25);"],
        timeoutMs: Number.MAX_SAFE_INTEGER,
        onSuccess(result) {
          expect(result).toMatchObject({ stdout: "", stderr: "" });
          elapsedTimes.push(result.elapsedMs);
        },
      },
    ],
    1,
  );

  expect(elapsedTimes).toHaveLength(1);
  expect(elapsedTimes[0]).toBeGreaterThanOrEqual(0);
}, 30_000);
