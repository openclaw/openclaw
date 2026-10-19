// Prepare Extension Package Boundary Artifacts tests cover prepare extension package boundary artifacts script behavior.
import { spawn } from "node:child_process";
import { getEventListeners, once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveDistArtifactLockPath,
  withDistArtifactOwnership,
} from "../../scripts/lib/dist-artifact-lock.mts";
import * as managedChildProcess from "../../scripts/lib/managed-child-process.mts";
import * as processMemory from "../../scripts/lib/process-memory.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import {
  createPrefixedOutputWriter,
  parseMode,
  resolveBoundaryRootShimsTimeoutMs,
  resolveDeclarationCompilerEnv,
  runNodeStep as runNodeStepImpl,
  runNodeSteps as runNodeStepsImpl,
  runNodeStepsInParallel as runNodeStepsInParallelImpl,
} from "../../scripts/prepare-extension-package-boundary-artifacts.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";
import { resolveInstalledNativeCompiler } from "./native-boundary-fixture.js";

const fixture = createFixtureLifetime();
const { createTempDir } = fixture;
afterEach(() => fixture.cleanup());

const runNodeStep = (...args: Parameters<typeof runNodeStepImpl>) =>
  fixture.track(runNodeStepImpl(...args));
const runNodeSteps = (...args: Parameters<typeof runNodeStepsImpl>) =>
  fixture.track(runNodeStepsImpl(...args));
const runNodeStepsInParallel = (...args: Parameters<typeof runNodeStepsInParallelImpl>) =>
  fixture.track(runNodeStepsInParallelImpl(...args));

function observeFixtureLine(expected: string) {
  const gate = createDeferred();
  return {
    promise: gate.promise,
    onStdoutLine: (line: string) => {
      if (line.trim() === expected) {
        gate.resolve();
        return false;
      }
      return true;
    },
  };
}

// Emergency cleanup has only a foreign PID after the product's group owner settled.
// No retained ChildProcess can report its exit; the test signal bounds this final check.
async function waitForDescendantExit(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isProcessAlive(pid)) {
      await delay(5, undefined, { signal });
    }
  } catch (cause) {
    throw new Error(`process still alive: ${pid}`, { cause });
  }
}

// Keep the real CLI and owned entry intact; intercept only generator checkpoints
// and the terminal compiler workload. Retry executes the real native compiler.
function createPreparationCli(workload = "", preparationCheckpoint = "") {
  const root = fs.realpathSync.native(createTempDir("openclaw-preparation-cli-"));
  const write = (relative: string, content: string) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  fs.mkdirSync(path.join(root, ".git"));
  write("package.json", '{"name":"openclaw","type":"module"}');
  write("pnpm-workspace.yaml", "packages: []\n");
  write("src/plugin-sdk/qa-channel-protocol.ts", "export const value = 1;\n");
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "es2023",
        module: "nodenext",
        lib: ["es5"],
        types: [],
        skipLibCheck: true,
      },
    }),
  );
  write(
    "packages/plugin-sdk/tsconfig.json",
    JSON.stringify({
      extends: "../../tsconfig.json",
      include: ["../../src/plugin-sdk/**/*.ts"],
    }),
  );
  installDistArtifactScripts(
    root,
    [
      "prepare-extension-package-boundary-artifacts.mts",
      "compile-extension-boundary.mts",
      "run-tsgo.mts",
      "run-tsgo.mjs",
    ],
    { dependencies: ["tsx", "@openclaw/fs-safe", "@openclaw/proc-safe"] },
  );
  write("src/shared/deferred.ts", fs.readFileSync("src/shared/deferred.ts", "utf8"));
  fs.renameSync(
    path.join(root, "scripts/generate-kysely-types.mts"),
    path.join(root, "scripts/generate-kysely-types.actual.mts"),
  );
  write(
    "scripts/generate-kysely-types.mts",
    `
import fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { ensureKyselyTypes as ensure } from "./generate-kysely-types.actual.mts";
export async function ensureKyselyTypes(...args) {
  fs.writeFileSync(new URL("../preparation.pid", import.meta.url), String(process.pid));
  await ensure(...args);
  ${preparationCheckpoint}
}
`,
  );
  fs.renameSync(
    path.join(root, "scripts/compile-extension-boundary.mts"),
    path.join(root, "scripts/compile-extension-boundary.actual.mts"),
  );
  write(
    "scripts/compile-extension-boundary.mts",
    `
import fs from "node:fs";
import { spawn } from "node:child_process";
fs.writeFileSync(new URL("../compiler-started", import.meta.url), String(process.pid));
${workload}
await import("./compile-extension-boundary.actual.mts");
`,
  );
  // Model only the enclosing updater owner; the actual entry owns cancellation.
  write(
    "owner.mts",
    `
import path from "node:path";
import { withDistArtifactOwnership, distArtifactEntryArgs } from "./scripts/lib/dist-artifact-ownership.mts";
import { runManagedCommand } from "./scripts/lib/managed-child-process.mts";
process.exitCode = await withDistArtifactOwnership(process.cwd(), () => runManagedCommand({
  bin: process.execPath,
  args: distArtifactEntryArgs(path.resolve("scripts/prepare-extension-package-boundary-artifacts.mts"), ["--mode=package-boundary"]),
  cwd: process.cwd(), stdio: "inherit", requireProcessTreeExit: true,
}));
`,
  );
  const processes: Array<{ child: ReturnType<typeof spawn>; closed: Promise<unknown> }> = [];
  const start = () => {
    const child = spawn(resolveTestNodeExecPath(), ["--import", "./scripts/tsx.mjs", "owner.mts"], {
      cwd: root,
      env: { ...process.env, OPENCLAW_ALLOW_LIVE_DIST_BUILD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const closed = fixture.track(once(child, "close"));
    processes.push({ child, closed });
    return { child, closed, output: () => output };
  };
  const ownerPath = path.join(resolveDistArtifactLockPath(root), "owner.json");
  const recordPath = path.join(root, ".artifacts/extension-package-boundary/plugin-sdk.json");
  const declarationPath = path.join(
    root,
    "packages/plugin-sdk/dist/src/plugin-sdk/qa-channel-protocol.d.ts",
  );
  const cleanup = async () => {
    for (const { child } of processes) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }
    await Promise.all(processes.map(({ closed }) => closed));
  };
  return { root, write, start, cleanup, ownerPath, recordPath, declarationPath };
}

describe("prepare-extension-package-boundary-artifacts", () => {
  it("prefixes each completed line and flushes the trailing partial line", () => {
    let output = "";
    const writer = createPrefixedOutputWriter("boundary", {
      write(chunk: string) {
        output += chunk;
      },
    });

    writer.write("first line\nsecond");
    writer.write(" line\nthird");
    writer.flush();

    expect(output).toBe("[boundary] first line\n[boundary] second line\n[boundary] third");
  });

  it.runIf(process.platform !== "win32")(
    "force-kills aborted sibling step process groups",
    ({ signal }) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-boundary-abort-group-");
        const descendantPidPath = path.join(rootDir, "descendant.pid");
        const failPath = path.join(rootDir, "fail");
        const ready = observeFixtureLine("ready");
        let descendantPid = 0;
        const descendantScript = [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
          "process.stdout.write('ready\\n');",
        ].join("\n");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          `spawn(process.execPath, ["--eval", ${JSON.stringify(descendantScript)}], { stdio: "inherit" });`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n");

        // The test releases failure after observing the descendant's installed handler.
        const failWhenRequested = [
          "const fs = require('node:fs');",
          "setInterval(() => {",
          `  if (fs.existsSync(${JSON.stringify(failPath)})) process.exit(2);`,
          "}, 25);",
        ].join("\n");

        const command = runNodeStepsInParallel([
          {
            label: "delayed-fail",
            args: ["--eval", failWhenRequested],
            timeoutMs: 30_000,
          },
          {
            label: "abort-group-prep",
            args: ["--eval", parentScript],
            abortKillGraceMs: 100,
            timeoutMs: 60_000,
            onStdoutLine: ready.onStdoutLine,
          },
        ]);
        const outcome = command.catch((error: unknown) => error);
        const expectedFailure = fixture.track(
          expect(command).rejects.toThrow("delayed-fail failed with exit code 2"),
        );
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              ready.promise,
              outcome,
              `Timed out waiting for ${descendantPidPath}`,
            ),
            signal,
          );
          descendantPid = Number.parseInt(fs.readFileSync(descendantPidPath, "utf8"), 10);
          fs.writeFileSync(failPath, "fail");

          await withinTest(expectedFailure, signal);
          expect(isProcessAlive(descendantPid)).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            fs.writeFileSync(failPath, "fail");
            await outcome;
            if (fs.existsSync(descendantPidPath)) {
              descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
            }
            if (descendantPid && isProcessAlive(descendantPid)) {
              process.kill(descendantPid, "SIGKILL");
              await waitForDescendantExit(descendantPid, signal);
            }
          });
        }
      }),
  );

  it
    .runIf(process.platform !== "win32")
    .for(["normal", "observation failure", "cancellation", "cleanup write failure"])(
    "lets aborted sibling descendants drain during kill grace (%s)",
    async (mode, { signal: contextSignal }) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([contextSignal, controller.signal]);
      const observationFailure = new Error("drain observation failed");
      const originalNow = Date.now;
      // Only the injected fixture-write failure owns a separate namespace.
      // Real step claims and their cleanup failures still belong to the outer fixture.
      const retainedOwner =
        mode === "cleanup write failure"
          ? createVitestResourceOwner(createTempDir("boundary-cleanup-owner-"))
          : undefined;
      const driverFixture = retainedOwner ? createFixtureLifetime(retainedOwner.root) : fixture;
      const rootDir = driverFixture.createTempDir("openclaw-boundary-abort-drain-");
      let descendantPid = 0;
      let command: ReturnType<typeof runNodeStepsInParallel> | undefined;
      let outcome: Promise<unknown> | undefined;
      let rescue: Promise<void> | undefined;
      let joined = false;
      let requiredRescue = false;
      let heldAtRescue = false;
      const driver = driverFixture.run(async () => {
        const readyPath = path.join(rootDir, "descendant.ready");
        const drainedPath = path.join(rootDir, "descendant.drained");
        const failPath = path.join(rootDir, "fail");
        const terminatingPath = path.join(rootDir, "terminating");
        const ready = observeFixtureLine("ready");
        const terminating = observeFixtureLine("terminating");
        const descendantScript = [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {",
          `  fs.writeFileSync(${JSON.stringify(terminatingPath)}, 'terminating');`,
          "  process.stdout.write('terminating\\n');",
          `  if (${JSON.stringify(mode)} !== 'normal') return;`,
          "  setTimeout(() => {",
          `    fs.writeFileSync(${JSON.stringify(drainedPath)}, 'drained');`,
          "    process.exit(0);",
          "  }, 50);",
          "});",
          `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
          "process.stdout.write('ready\\n');",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          `spawn(process.execPath, ["--eval", ${JSON.stringify(descendantScript)}], { stdio: "inherit" });`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const failWhenRequested = [
          "const fs = require('node:fs');",
          "setInterval(() => {",
          `  if (fs.existsSync(${JSON.stringify(failPath)})) process.exit(2);`,
          "}, 25);",
        ].join("\n");
        command = runNodeStepsInParallel([
          {
            label: "delayed-fail",
            args: ["--eval", failWhenRequested],
            timeoutMs: 30_000,
          },
          {
            label: "abort-group-drain",
            args: ["--eval", parentScript],
            abortKillGraceMs: 100,
            timeoutMs: 60_000,
            onStdoutLine(line) {
              return ready.onStdoutLine(line) && terminating.onStdoutLine(line);
            },
          },
        ]);
        outcome = command
          .catch((error: unknown) => error)
          .finally(() => {
            joined = true;
          });
        const clock = vi.spyOn(Date, "now");
        const abort = () => clock.mockRestore();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
        try {
          await withinTest(
            awaitGateBeforeSettlement(ready.promise, outcome, `Timed out waiting for ${readyPath}`),
            signal,
          );
          descendantPid = Number(fs.readFileSync(readyPath, "utf8"));
          // Hold the supervisor's grace clock, not the real child's cleanup timer.
          // Separate force-kill tests cover expiry; this case proves graceful drain.
          clock.mockReturnValue(Date.now());
          fs.writeFileSync(failPath, "fail");
          if (mode !== "normal") {
            await withinTest(
              awaitGateBeforeSettlement(
                terminating.promise,
                outcome,
                `Timed out waiting for ${terminatingPath}`,
              ),
              signal,
            );
            expect(fs.readFileSync(terminatingPath, "utf8")).toBe("terminating");
            expect(isProcessAlive(descendantPid)).toBe(true);
            if (mode === "observation failure") {
              throw observationFailure;
            }
            if (mode === "cancellation") {
              controller.abort(observationFailure);
            }
          }
          if (mode !== "cleanup write failure") {
            // The managed outcome joins the group after the leaf writes its drain marker.
            await withinTest(outcome, signal);
            expect(fs.readFileSync(drainedPath, "utf8")).toBe("drained");
          }
        } finally {
          // Cleanup needs the supervisor's real deadline, including when a gate
          // write fails or the test is canceled before observing child drainage.
          clock.mockRestore();
          signal.removeEventListener("abort", abort);
          if (mode !== "normal") {
            // Diagnose the frozen-clock unwind before rescuing the real child.
            // The repaired finalizer must need no help on this next event-loop turn.
            rescue = new Promise<void>((resolve) => {
              setImmediate(() => {
                requiredRescue = Date.now !== originalNow;
                heldAtRescue = !joined && isProcessAlive(descendantPid) && fs.existsSync(rootDir);
                if (requiredRescue) {
                  clock.mockRestore();
                }
                resolve();
              });
            });
          }
          await driverFixture.verifyCleanup(async () => {
            try {
              fs.writeFileSync(mode === "cleanup write failure" ? rootDir : failPath, "fail");
            } finally {
              await outcome;
              if (fs.existsSync(readyPath)) {
                descendantPid = Number(fs.readFileSync(readyPath, "utf8"));
              }
              if (descendantPid && isProcessAlive(descendantPid)) {
                process.kill(descendantPid, "SIGKILL");
                await waitForDescendantExit(descendantPid, contextSignal);
              }
            }
          });
        }
      });
      const error = await driver.catch((failure: unknown) => failure);
      // The diagnostic rescue never substitutes for an actual command/group join.
      await rescue;
      await outcome;
      expect(isProcessAlive(descendantPid)).toBe(false);
      expect(fs.existsSync(rootDir)).toBe(true);
      expect(Date.now).toBe(originalNow);
      expect(getEventListeners(signal, "abort")).toEqual([]);
      if (mode === "cleanup write failure") {
        expect(error).toHaveProperty("code", "EISDIR");
        try {
          await expect(driverFixture.cleanup()).rejects.toThrow("Fixture cleanup unverified");
          expect(fs.existsSync(rootDir)).toBe(true);
          expect(() => retainedOwner!.assertReleased()).toThrow("Unreleased Vitest resource claim");
        } finally {
          // Only the injected filesystem failure is disposable, after the real join.
          fs.rmSync(rootDir, { recursive: true, force: true });
        }
      } else if (mode === "normal") {
        await driver;
      } else {
        expect(error).toBe(observationFailure);
      }
      expect(command).toBeDefined();
      await expect(command).rejects.toThrow("delayed-fail failed with exit code 2");
      expect(requiredRescue, JSON.stringify({ heldAtRescue, joined })).toBe(false);
    },
  );

  it("clamps oversized prep step timers before scheduling", () =>
    fixture.run(async () => {
      await expect(
        runNodeStep(
          "slow-success",
          ["--eval", "setTimeout(() => process.exit(0), 25);"],
          MAX_TIMER_TIMEOUT_MS + 1,
        ),
      ).resolves.toBeUndefined();
    }));

  it.runIf(process.platform !== "win32").for(["spawn", "execFileSync"])(
    "joins timed-out prep groups launched with %s",
    (launch, { signal }) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-boundary-timeout-group-");
        const descendantPidPath = path.join(rootDir, "descendant.pid");
        const ready = observeFixtureLine("ready");
        let descendantPid = 0;
        const nativeSetTimeout = globalThis.setTimeout;
        let triggerStepTimeout: (() => void) | undefined;
        const setTimeoutSpy = vi
          .spyOn(globalThis, "setTimeout")
          .mockImplementation((callback, timeout, ...args) => {
            if (timeout === 2_000 && !triggerStepTimeout) {
              triggerStepTimeout = () => callback(...args);
              return nativeSetTimeout(() => undefined, 60_000);
            }
            return nativeSetTimeout(callback, timeout, ...args);
          });
        const descendantScript = [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
          "process.stdout.write('ready\\n');",
        ].join("\n");
        const parentScript = [
          `const { ${launch} } = require('node:child_process');`,
          `${launch}(process.execPath, ["--eval", ${JSON.stringify(descendantScript)}], { stdio: "inherit" });`,
          "setInterval(() => {}, 1000);",
        ].join("\n");

        const abortController = new AbortController();
        const command = runNodeStep("hung-group-prep", ["--eval", parentScript], 2_000, {
          abortController,
          onStdoutLine: ready.onStdoutLine,
        });
        const expectedFailure = fixture.track(
          expect(command).rejects.toThrow("hung-group-prep timed out after 2000ms"),
        );
        const outcome = command.catch((error: unknown) => error);
        try {
          // The leaf publishes readiness after installing its signal handler. The
          // synchronous case matches the native CLI's fallback when execve is absent.
          await withinTest(
            awaitGateBeforeSettlement(
              ready.promise,
              outcome,
              `Timed out waiting for ${descendantPidPath}`,
            ),
            signal,
          );
          descendantPid = Number.parseInt(fs.readFileSync(descendantPidPath, "utf8"), 10);
          expect(triggerStepTimeout).toBeDefined();
          triggerStepTimeout?.();

          await withinTest(expectedFailure, signal);
          expect(isProcessAlive(descendantPid)).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            abortController.abort();
            await outcome;
            setTimeoutSpy.mockRestore();
            if (fs.existsSync(descendantPidPath)) {
              descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
            }
            if (descendantPid && isProcessAlive(descendantPid)) {
              process.kill(descendantPid, "SIGKILL");
              await waitForDescendantExit(descendantPid, signal);
            }
          });
        }
      }),
  );

  it.runIf(process.platform !== "win32").for(["SIGINT", "SIGTERM"] as const)(
    "preparation CLI joins detached groups and releases ownership after %s",
    (termination, { signal }) =>
      fixture.run(async () => {
        const descendantScript = `
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
require("node:fs").writeFileSync("descendant.pid", String(process.pid));
setInterval(() => {}, 1000);
process.stdout.write("ready\\n");
`;
        const f = createPreparationCli(`
if (!fs.existsSync("retry")) {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  spawn(process.execPath, ["--eval", ${JSON.stringify(descendantScript)}], { stdio: "inherit" });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
`);
        const runner = f.start();
        const ready = observeFixtureLine("[plugin-sdk boundary dts] ready");
        const output = createInterface({ input: runner.child.stdout });
        output.on("line", ready.onStdoutLine);
        let descendantPid = 0;
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              ready.promise,
              runner.closed,
              "Compiler did not reach its checkpoint",
            ),
            signal,
          );
          descendantPid = Number(fs.readFileSync(path.join(f.root, "descendant.pid"), "utf8"));
          expect(fs.existsSync(f.ownerPath)).toBe(true);
          expect(
            fs.readdirSync(path.dirname(f.ownerPath)).filter((name) => name.startsWith("child-")),
          ).toHaveLength(1);
          process.kill(
            Number(fs.readFileSync(path.join(f.root, "preparation.pid"), "utf8")),
            termination,
          );
          expect(await withinTest(runner.closed, signal), runner.output()).toEqual([
            termination === "SIGINT" ? 130 : 143,
            null,
          ]);
          expect(isProcessAlive(descendantPid)).toBe(false);
          expect(
            fs.readdirSync(path.dirname(f.ownerPath)),
            "Joined cancellation must release owner and inherited claim",
          ).toEqual([]);
          expect(fs.existsSync(f.recordPath)).toBe(false);
          f.write("retry", "");
          const retry = f.start();
          expect(await withinTest(retry.closed, signal), retry.output()).toEqual([0, null]);
          expect(fs.readFileSync(f.declarationPath, "utf8")).toContain("value = 1");
          expect(fs.existsSync(f.recordPath)).toBe(true);
          expect(fs.readdirSync(path.dirname(f.ownerPath))).toEqual([]);
        } finally {
          await fixture.verifyCleanup(async () => {
            await f.cleanup();
            output.close();
            if (fs.existsSync(path.join(f.root, "descendant.pid"))) {
              descendantPid = Number(fs.readFileSync(path.join(f.root, "descendant.pid"), "utf8"));
            }
            if (descendantPid && isProcessAlive(descendantPid)) {
              process.kill(descendantPid, "SIGKILL");
              await waitForDescendantExit(descendantPid, signal);
            }
          });
        }
      }),
  );

  it.runIf(process.platform !== "win32")(
    "preparation CLI cancels the asynchronous pre-compiler gap without admission or publication",
    ({ signal }) =>
      fixture.run(async () => {
        const connected = createDeferred<{ socket: net.Socket; ready: Promise<unknown[]> }>();
        const server = net.createServer((socket) =>
          connected.resolve({ socket, ready: once(socket, "data") }),
        );
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing checkpoint port");
        }
        const f = createPreparationCli(
          "",
          `
if (!fs.existsSync("retry")) {
  const socket = net.connect(${address.port}, "127.0.0.1");
  await once(socket, "connect");
  // A next-turn acknowledgment lets the real command owner's abort microtask run
  // before the test releases this terminal generator checkpoint.
  process.once("SIGTERM", () => setImmediate(() => socket.write("observed")));
  const released = once(socket, "data");
  socket.write("ready");
  await released;
  socket.end();
}
`,
        );
        const runner = f.start();
        let socket: net.Socket | undefined;
        try {
          const checkpoint = await withinTest(
            awaitGateBeforeSettlement(
              connected.promise,
              runner.closed,
              "Generator did not reach its checkpoint",
            ),
            signal,
          );
          socket = checkpoint.socket;
          await withinTest(checkpoint.ready, signal);
          const observed = once(socket, "data");
          expect(fs.existsSync(f.ownerPath)).toBe(true);
          expect(fs.existsSync(path.join(f.root, "compiler-started"))).toBe(false);
          process.kill(
            Number(fs.readFileSync(path.join(f.root, "preparation.pid"), "utf8")),
            "SIGTERM",
          );
          await withinTest(observed, signal);
          socket.write("continue");
          expect(await withinTest(runner.closed, signal), runner.output()).toEqual([143, null]);
          expect(
            fs.existsSync(path.join(f.root, "compiler-started")),
            "Canceled preparation must not admit a compiler",
          ).toBe(false);
          expect(fs.existsSync(f.declarationPath)).toBe(false);
          expect(fs.existsSync(f.recordPath)).toBe(false);
          expect(fs.readdirSync(path.dirname(f.ownerPath))).toEqual([]);
          f.write("retry", "");
          const retry = f.start();
          expect(await withinTest(retry.closed, signal), retry.output()).toEqual([0, null]);
          expect(fs.readFileSync(f.declarationPath, "utf8")).toContain("value = 1");
          expect(fs.existsSync(f.recordPath)).toBe(true);
        } finally {
          await fixture.verifyCleanup(async () => {
            socket?.end("continue");
            await f.cleanup();
            socket?.destroy();
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
            });
          });
        }
      }),
  );

  it.runIf(process.platform !== "win32").for([0])(
    "rejects and joins descendants left behind by a step exiting %s",
    (exitCode, { signal }) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-boundary-unjoined-");
        const pidFile = path.join(rootDir, "descendant.pid");
        const leafScript = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.send("ready");
process.disconnect();
`;
        const parentScript = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["--eval", ${JSON.stringify(leafScript)}], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
child.once("message", () => process.exit(${exitCode}));
`;
        try {
          await expect(
            runNodeStep("unjoined-prep", ["--eval", parentScript], 10_000),
          ).rejects.toMatchObject({
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: "terminated",
          });
          // The leaf writes before IPC readiness; its parent exits only after that message.
          expect(isProcessAlive(Number(fs.readFileSync(pidFile, "utf8")))).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            if (fs.existsSync(pidFile)) {
              const pid = Number(fs.readFileSync(pidFile, "utf8"));
              if (pid && isProcessAlive(pid)) {
                process.kill(pid, "SIGKILL");
                await waitForDescendantExit(pid, signal);
              }
            }
          });
        }
      }),
  );

  it.for(["sibling", "command"] as const)("does not admit work after %s cancellation", (origin) =>
    fixture.run(async () => {
      const rootDir = createTempDir("openclaw-boundary-canceled-");
      const startedPath = path.join(rootDir, "started");
      const abortController = new AbortController();
      abortController.abort();
      await expect(
        runNodeStep(
          "late-prep",
          ["--eval", `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started")`],
          1_000,
          origin === "sibling" ? { abortController } : { signal: abortController.signal },
        ),
      ).rejects.toThrow(origin === "sibling" ? "canceled before starting" : "aborted");
      expect(fs.existsSync(startedPath)).toBe(false);
    }),
  );

  it.runIf(process.platform !== "win32").for(["sibling", "command"] as const)(
    "keeps %s cancellation a failure when the child handles SIGTERM with exit zero",
    (origin, { signal }) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-boundary-canceled-zero-");
        const readyPath = path.join(rootDir, "ready");
        const stoppedPath = path.join(rootDir, "stopped");
        const abortController = new AbortController();
        const commandController = new AbortController();
        const cancellation = origin === "sibling" ? abortController : commandController;
        const ready = observeFixtureLine("ready");
        const script = [
          'const fs = require("node:fs");',
          `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(stoppedPath)}, "zero"); process.exit(0); });`,
          `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
          "process.stdout.write('ready\\n');",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const command = runNodeStep("canceled-zero", ["--eval", script], 10_000, {
          abortController,
          signal: commandController.signal,
          onStdoutLine: ready.onStdoutLine,
        });
        const outcome = command.catch((error: unknown) => error);
        let pid = 0;
        try {
          await withinTest(
            awaitGateBeforeSettlement(ready.promise, outcome, `Timed out waiting for ${readyPath}`),
            signal,
          );
          pid = Number(fs.readFileSync(readyPath, "utf8"));
          cancellation.abort();
          await withinTest(expect(command).rejects.toMatchObject({ code: "ABORT_ERR" }), signal);
          expect(fs.readFileSync(stoppedPath, "utf8")).toBe("zero");
          expect(isProcessAlive(pid)).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            cancellation.abort();
            await outcome;
            if (fs.existsSync(readyPath)) {
              pid = Number(fs.readFileSync(readyPath, "utf8"));
            }
            if (pid && isProcessAlive(pid)) {
              process.kill(pid, "SIGKILL");
              await waitForDescendantExit(pid, signal);
            }
          });
        }
      }),
  );

  it("releases artifact ownership after a failed native compiler and permits retry", () =>
    fixture.run(async () => {
      const root = createTempDir("openclaw-boundary-failed-compiler-");
      fs.mkdirSync(path.join(root, ".git"));
      const bin = resolveInstalledNativeCompiler();
      await expect(
        withDistArtifactOwnership(root, () =>
          runNodeStep("compiler-prep", ["--invalid-boundary-proof"], 10_000, { bin }),
        ),
      ).rejects.toThrow("compiler-prep failed with exit code 1");
      expect(fs.readdirSync(resolveDistArtifactLockPath(root))).toEqual([]);
      const output = path.join(root, "retry");
      await withDistArtifactOwnership(root, async () => fs.writeFileSync(output, "completed"));
      expect(fs.readFileSync(output, "utf8")).toBe("completed");
    }));

  it("runs boundary prep steps serially for local checks", () =>
    fixture.run(async () => {
      const rootDir = createTempDir("openclaw-boundary-serial-");
      const logPath = path.join(rootDir, "steps.log");
      const appendScript = (label: string) =>
        `const fs=require("node:fs");` +
        `const log=${JSON.stringify(logPath)};` +
        `fs.appendFileSync(log, ${JSON.stringify(`${label}-start\n`)});` +
        `setTimeout(()=>{fs.appendFileSync(log, ${JSON.stringify(`${label}-end\n`)});}, 50);`;

      await runNodeSteps(
        [
          { label: "first", args: ["--eval", appendScript("first")], timeoutMs: 5_000 },
          { label: "second", args: ["--eval", appendScript("second")], timeoutMs: 5_000 },
        ],
        { OPENCLAW_LOCAL_CHECK: "1" },
      );

      expect(fs.readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
        "first-start",
        "first-end",
        "second-start",
        "second-end",
      ]);
    }));

  it.each([
    { cpus: 8, memoryGiB: 24, local: undefined, expected: 2 },
    { cpus: 8, memoryGiB: null, local: undefined, expected: 1 },
    { cpus: 8, memoryGiB: 24, local: "1", expected: 1 },
  ])(
    "bounds CI declaration children to $expected ($cpus CPUs, $memoryGiB GiB, local=$local)",
    async ({ cpus, memoryGiB, local, expected }) => {
      const children = Array.from({ length: 4 }, () => {
        let start!: () => void;
        let finish!: (code: number) => void;
        const started = new Promise<void>((resolve) => {
          start = resolve;
        });
        const finished = new Promise<number>((resolve) => {
          finish = resolve;
        });
        return { started, finished, start, finish };
      });
      const commands: string[] = [];
      const capacityBytes = memoryGiB === null ? null : memoryGiB * 1024 ** 3;
      vi.spyOn(os, "availableParallelism").mockReturnValue(cpus);
      vi.spyOn(os, "totalmem").mockReturnValue(64 * 1024 ** 3);
      vi.spyOn(processMemory, "readProcessMemoryCapacity").mockReturnValue({
        capacityBytes,
        limitBytes: capacityBytes,
        availableBytes: capacityBytes,
        unresolved: memoryGiB === null,
        usageKnown: false,
      });
      vi.spyOn(managedChildProcess, "runManagedCommand").mockImplementation(({ args }) => {
        const index = args?.[0];
        if (index === undefined) {
          throw new Error("Missing compiler fixture ID");
        }
        commands.push(index);
        const child = children[Number(index)]!;
        child.start();
        return child.finished;
      });
      const count = process.platform === "linux" ? expected : 1;
      const running = runNodeSteps(
        children.map((_, index) => ({
          label: String(index),
          args: [String(index)],
          timeoutMs: 5_000,
        })),
        { CI: "true", OPENCLAW_LOCAL_CHECK: local },
      );
      try {
        for (let offset = 0; offset < children.length; offset += count) {
          await children[offset]!.started;
          expect(commands).toEqual(
            Array.from({ length: offset + count }, (_, index) => String(index)),
          );
          for (const child of children.slice(offset, offset + count)) {
            child.finish(0);
          }
        }
        await running;
      } finally {
        for (const child of children) {
          child.finish(0);
        }
        await running;
        vi.restoreAllMocks();
      }
    },
  );

  it("parses prep mode and rejects unknown values", () => {
    expect(parseMode([])).toBe("all");
    expect(parseMode(["--mode=package-boundary"])).toBe("package-boundary");
    expect(() => parseMode(["--mode=nope"])).toThrow("Unknown mode: nope");
  });

  it("sizes serial CI declaration compilers to the constrained runner", () => {
    const gib = 1024 ** 3;
    const host = { logicalCpuCount: 4, totalMemoryBytes: 15 * gib, memoryCapacityBytes: 15 * gib };
    const pick = (env: NodeJS.ProcessEnv) => {
      const { GOMAXPROCS, GOGC, GOMEMLIMIT } = env;
      return { GOMAXPROCS, GOGC, GOMEMLIMIT };
    };

    expect(pick(resolveDeclarationCompilerEnv({ CI: "true" }, host))).toEqual({
      GOMAXPROCS: "4",
      GOGC: "100",
      GOMEMLIMIT: "11520MiB",
    });
    expect(pick(resolveDeclarationCompilerEnv({ CI: "true", GOMAXPROCS: "3" }, host))).toEqual({
      GOMAXPROCS: "3",
      GOGC: "100",
      GOMEMLIMIT: "11520MiB",
    });
    // Unknown cgroup ownership keeps the conservative constrained-runner limits.
    expect(
      pick(resolveDeclarationCompilerEnv({ CI: "true" }, { ...host, memoryCapacityBytes: null })),
    ).toEqual({ GOMAXPROCS: "2", GOGC: "30", GOMEMLIMIT: "3GiB" });
  });

  it("gives cold root shim generation macOS runner headroom", () => {
    expect(resolveBoundaryRootShimsTimeoutMs({})).toBe(300_000);
    expect(
      resolveBoundaryRootShimsTimeoutMs({
        OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS: "450000",
      }),
    ).toBe(450_000);
    expect(() =>
      resolveBoundaryRootShimsTimeoutMs({
        OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS: "120s",
      }),
    ).toThrow("OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS must be a positive integer");
    expect(() =>
      resolveBoundaryRootShimsTimeoutMs({
        OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS: "0",
      }),
    ).toThrow("OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS must be a positive integer");
  });
});
