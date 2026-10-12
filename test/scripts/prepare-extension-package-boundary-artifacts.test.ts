// Prepare Extension Package Boundary Artifacts tests cover prepare extension package boundary artifacts script behavior.
import { spawn } from "node:child_process";
import { getEventListeners, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as managedChildProcess from "../../scripts/lib/managed-child-process.mts";
import * as processMemory from "../../scripts/lib/process-memory.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import {
  createPrefixedOutputWriter,
  parseMode,
  resolveBoundaryRootShimsTimeoutMs,
  runNodeStep as runNodeStepImpl,
  runNodeSteps as runNodeStepsImpl,
  runNodeStepsInParallel as runNodeStepsInParallelImpl,
} from "../../scripts/prepare-extension-package-boundary-artifacts.mts";
import { prepareTsgoCommand } from "../../scripts/run-tsgo.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";

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

  it.runIf(process.platform !== "win32")(
    "forwards wrapper termination to detached prep step groups",
    ({ signal }) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-boundary-signal-group-");
        const descendantPidPath = path.join(rootDir, "descendant.pid");
        let descendantPid = 0;
        const moduleHref = pathToFileURL(
          path.resolve("scripts/prepare-extension-package-boundary-artifacts.mts"),
        ).href;
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
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const runnerScript = [
          `import { runNodeStep } from ${JSON.stringify(moduleHref)};`,
          `await runNodeStep("signal-group-prep", ["--eval", ${JSON.stringify(parentScript)}], 60_000, { abortKillGraceMs: 100 });`,
        ].join("\n");
        const runner = spawn(process.execPath, ["--input-type=module", "--eval", runnerScript], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        const runnerPid = runner.pid ?? 0;
        const runnerClosed = fixture.track(once(runner, "close"));
        const ready = observeFixtureLine("[signal-group-prep] ready");
        const output = createInterface({ input: runner.stdout });
        output.on("line", ready.onStdoutLine);

        try {
          await withinTest(
            awaitGateBeforeSettlement(
              ready.promise,
              runnerClosed,
              `Timed out waiting for ${descendantPidPath}`,
            ),
            signal,
          );
          descendantPid = Number.parseInt(fs.readFileSync(descendantPidPath, "utf8"), 10);
          runner.kill("SIGTERM");

          expect(await withinTest(runnerClosed, signal)).toEqual([143, null]);
          expect(isProcessAlive(descendantPid)).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            if (runnerPid && isProcessAlive(runnerPid)) {
              runner.kill("SIGTERM");
            }
            await runnerClosed;
            output.close();
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

  it("does not admit work after sibling cancellation", () =>
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
          { abortController },
        ),
      ).rejects.toThrow("canceled before starting");
      expect(fs.existsSync(startedPath)).toBe(false);
    }));

  it.runIf(process.platform !== "win32")(
    "keeps cancellation a failure when the child handles SIGTERM with exit zero",
    ({ signal }) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-boundary-canceled-zero-");
        const readyPath = path.join(rootDir, "ready");
        const stoppedPath = path.join(rootDir, "stopped");
        const abortController = new AbortController();
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
          abortController.abort();
          await withinTest(
            expect(command).rejects.toThrow("canceled-zero canceled after sibling failure"),
            signal,
          );
          expect(fs.readFileSync(stoppedPath, "utf8")).toBe("zero");
          expect(isProcessAlive(pid)).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            abortController.abort();
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

  it.each([true])("runs the declared compiler directly (invalid args=%s)", (invalid) =>
    fixture.run(async () => {
      const command = prepareTsgoCommand([invalid ? "--invalid-boundary-proof" : "--version"]);
      expect(command).not.toBeNull();
      if (!command) {
        throw new Error("compiler unexpectedly skipped");
      }
      const result = runNodeStep("compiler-prep", command.args, 10_000, command);
      if (invalid) {
        await expect(result).rejects.toThrow("compiler-prep failed with exit code 1");
      } else {
        await expect(result).resolves.toBeUndefined();
      }
    }),
  );

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
