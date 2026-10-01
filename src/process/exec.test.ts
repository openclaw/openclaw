// Exec tests cover command execution, output capture, and cancellation behavior.
import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { setVerbose } from "../global-state.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { readPidFile } from "../test-utils/process-tree.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { attachChildProcessBridge } from "./child-process-bridge.js";
import * as execSpawn from "./exec-spawn.js";
import {
  runCommandBuffered,
  runCommandWithTimeout,
  runExec,
  runUtf8CommandWithTimeout,
} from "./exec.js";

const nodeCommand = (source: string) => [process.execPath, "-e", source];

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
afterEach(() => vi.unstubAllEnvs());

// Escaped descendants outlive the root handle; no owner exposes their exit event.
async function waitForDescendantExit(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isPidAlive(pid)) {
      await waitForProcessTick(25, undefined, { signal });
    }
  } catch (error) {
    throw new Error(`Timed out waiting for descendant ${pid} to exit`, { cause: error });
  }
}

describe("runCommandWithTimeout", () => {
  it
    .skipIf(process.platform === "win32")
    .each(["cooperative", "default-signal", "forced"] as const)(
    "reports invocation cleanup and honors the initial SIGINT signal: %s",
    async (mode) => {
      const controller = new AbortController();
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const program =
        mode === "default-signal"
          ? "setInterval(()=>{},1000); process.stdout.write('ready');"
          : `const timer=setInterval(()=>{},1000); process.on('SIGINT',()=>{${mode === "cooperative" ? "clearInterval(timer);process.stdout.write('interrupted');process.exitCode=17;" : ""}}); process.stdout.write('ready');`;
      // Keep process I/O and polling real, but don't let host scheduling consume the grace period.
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      try {
        const running = runCommandWithTimeout(nodeCommand(program), {
          signal: controller.signal,
          killProcessTree: true,
          killSignal: "SIGINT",
          killGraceMs: 100,
          timeoutMs: 5000,
          onOutputChunk: () => {
            ready();
          },
        });
        await started;
        controller.abort();
        if (mode === "forced") {
          now.mockReturnValue(1_100);
        }
        const result = await running;
        expect(result.cleanup).toBe(mode === "default-signal" ? "cooperative" : mode);
        expect(result.killIssuedByAbort).toBe(true);
        if (mode === "default-signal") {
          expect(result).toMatchObject({ code: null, signal: "SIGINT", termination: "signal" });
        }
        if (mode === "cooperative") {
          expect(result.code).toBe(17);
          expect(result.stdout).toContain("interrupted");
        }
      } finally {
        now.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "joins owned descendants even when a successful root closes its output",
    async ({ signal }) => {
      let descendant: number | undefined;
      let running: ReturnType<typeof runCommandWithTimeout> | undefined;
      try {
        running = runCommandWithTimeout(
          nodeCommand(`const {spawn}=require('node:child_process');
          const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')"],{stdio:['ignore','ignore','ignore','ipc']});
          child.once('message',()=>{process.stdout.write(String(child.pid));child.disconnect();child.unref();});`),
          {
            killProcessTree: true,
            requireProcessTreeExtinction: true,
            signal,
            killGraceMs: 50,
            timeoutMs: 10_000,
            onOutputChunk: (chunk) => {
              descendant = Number(chunk.toString());
            },
          },
        );
        const result = await withinTest(running, signal);
        expect(Number.isSafeInteger(descendant) && descendant! > 0).toBe(true);
        expect(result.code).toBe(0);
        expect(result.cleanup).toBe("forced");
        // Forced settlement is recorded only after exec-termination observes the group absent.
        expect(isPidAlive(descendant!)).toBe(false);
      } finally {
        await running?.catch(() => undefined);
        if (descendant && isPidAlive(descendant)) {
          process.kill(descendant, "SIGKILL");
          await waitForDescendantExit(descendant, signal);
        }
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["SIGKILL", 9] as const)(
    "reports normal extinction after a successful native-style command with timeout signal %s",
    async (killSignal) => {
      const result = await runCommandWithTimeout(
        nodeCommand("process.stdout.write('enabled\\n')"),
        {
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          killSignal,
          timeoutMs: 5_000,
        },
      );
      expect(result).toMatchObject({
        termination: "exit",
        code: 0,
        signal: null,
        stdout: "enabled\n",
        stderr: "",
        cleanup: "normal",
      });
    },
  );

  it("does not restore parent variables excluded from the child environment", async () => {
    const key = "OPENCLAW_EXECA_PARENT_ONLY_TEST";
    vi.stubEnv(key, "parent-value");
    const result = await runCommandWithTimeout(
      nodeCommand(`process.stdout.write(process.env.${key} ?? "missing")`),
      { timeoutMs: 2_000, baseEnv: {} },
    );
    expect(result.stdout).toBe("missing");
  });

  it("returns without spawning when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runCommandWithTimeout(nodeCommand("process.exit(99)"), {
        timeoutMs: 2_000,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      code: null,
      killed: false,
      noOutputTimedOut: false,
      signal: null,
      stderr: "",
      stdout: "",
      termination: "signal",
    });
  });

  it.each([
    [undefined, 2],
    [0, 0],
    [1, 1],
  ])(
    "preserves matching output up to quota %s while tail capture continues",
    async (limit, count) => {
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          [
            "process.stdout.write('Visit https://example.com/device and enter code ABCD-EFGH\\n')",
            "process.stdout.write('x'.repeat(10_000) + 'enter code TAIL')",
          ].join(";"),
        ],
        {
          timeoutMs: 3_000,
          maxOutputBytes: 24,
          maxPreservedOutputLines: limit,
          preserveOutputLine: (line) => line.includes("enter code"),
        },
      );

      const tail = `${"x".repeat(9)}enter code TAIL`;
      expect(result.stdout).toBe(tail);
      expect(result.stdoutTruncatedBytes).toBeGreaterThan(0);
      expect(result.preservedStdoutLines).toEqual(
        count
          ? ["Visit https://example.com/device and enter code ABCD-EFGH", tail].slice(0, count)
          : undefined,
      );
    },
  );

  it("supports independent stdout head and stderr tail caps", async () => {
    const result = await runUtf8CommandWithTimeout(
      nodeCommand("process.stdout.write('a😀z'); process.stderr.write('b😀y')"),
      {
        maxOutputBytes: { stdout: 3, stderr: 3 },
        outputCapture: { stdout: "head", stderr: "tail" },
        timeoutMs: 3_000,
      },
    );

    expect(result.stdout).toBe("a");
    expect(result.stderr).toBe("y");
    expect(result.stdoutTruncatedBytes).toBe(5);
    expect(result.stderrTruncatedBytes).toBe(5);
  });

  it("keeps the combined output tail when tail capture is selected", async () => {
    const result = await runCommandWithTimeout(nodeCommand("process.stdout.write('abcdefgh')"), {
      maxCombinedOutputBytes: 4,
      maxOutputBytes: 16,
      outputCapture: "tail",
      timeoutMs: 3_000,
    });

    expect(result.stdout).toBe("efgh");
    expect(result.stdoutTruncatedBytes).toBe(4);
  });

  it("does not treat combined overflow as a selected stream overflow", async () => {
    const result = await runCommandWithTimeout(
      nodeCommand(
        "process.stderr.write('abcdefgh'); setImmediate(() => process.stdout.write('x'))",
      ),
      {
        maxCombinedOutputBytes: 8,
        maxOutputBytes: 16,
        outputCapture: "head",
        terminateOnOutputLimit: { stdout: true },
        timeoutMs: 3_000,
      },
    );

    expect(result.termination).toBe("exit");
    expect(result.outputLimitExceeded).toBeUndefined();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("abcdefgh");
  });

  it("terminates commands that exceed a selected stream cap", async () => {
    const result = await runCommandWithTimeout(
      nodeCommand("process.stdout.write('x'.repeat(100)); setInterval(() => {}, 1000)"),
      {
        maxOutputBytes: { stdout: 16, stderr: 16 },
        outputCapture: "head",
        terminateOnOutputLimit: { stdout: true },
        timeoutMs: 3_000,
      },
    );

    expect(result.outputLimitExceeded).toBe(true);
    expect(result.termination).toBe("signal");
    expect(result.stdout).toBe("x".repeat(16));
  });

  it("rejects mixed capture modes under a combined cap", async () => {
    await expect(
      runCommandWithTimeout(nodeCommand("process.exit(0)"), {
        maxCombinedOutputBytes: 16,
        outputCapture: { stdout: "head", stderr: "tail" },
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow("maxCombinedOutputBytes requires matching stdout and stderr capture modes");
  });

  it("observes discarded output and stops without retaining it", async () => {
    let observedBytes = 0;
    const result = await runCommandWithTimeout(
      nodeCommand("process.stdout.write('x'.repeat(1024 * 1024)); setInterval(() => {}, 1000)"),
      {
        onOutputChunk: (chunk, stream) => {
          if (stream !== "stdout") {
            return true;
          }
          observedBytes += chunk.byteLength;
          return observedBytes < 32 * 1024;
        },
        outputCapture: { stdout: "discard", stderr: "tail" },
        timeoutMs: 3_000,
      },
    );

    expect(observedBytes).toBeGreaterThanOrEqual(32 * 1024);
    expect(result.stdout).toBe("");
    expect(result.stdoutTruncatedBytes).toBeGreaterThanOrEqual(observedBytes);
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.termination).toBe("signal");
  });

  it.each([
    {
      input: Buffer.from([0x61, 0xff, 0x62, 0xe2, 0x82, 0xac, 0x7a]),
      cap: 5,
      output: "a�b�",
      dropped: 2,
    },
    { input: Buffer.from("😀"), cap: 3, output: "", dropped: 4 },
  ])(
    "handles malformed or entirely partial UTF-8 heads ($cap bytes)",
    async ({ input, cap, output, dropped }) => {
      const result = await runUtf8CommandWithTimeout(
        nodeCommand("process.stdin.pipe(process.stdout)"),
        { input, maxOutputBytes: cap, outputCapture: "head", timeoutMs: 3_000 },
      );
      expect(result.stdout).toBe(output);
      expect(result.stdoutTruncatedBytes).toBe(dropped);
    },
  );

  it("keeps argv values out of transport errors", async () => {
    const privateArg = "private-command-argument";
    const error = await runCommandWithTimeout(
      [`openclaw-missing-${process.pid}-${Date.now()}`, "--token", privateArg],
      { timeoutMs: 3_000 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(privateArg);
    expect(error).toMatchObject({ code: "ENOENT" });
  });
});

describe("runCommandBuffered", () => {
  it("caps stdout and stderr under one aggregate output budget", async () => {
    const result = await runCommandBuffered(
      nodeCommand("process.stdout.write('abcd'); setImmediate(() => process.stderr.write('efgh'))"),
      {
        maxCombinedOutputBytes: 6,
        maxOutputBytes: 8,
        timeoutMs: 3_000,
      },
    );

    expect(result.termination).toBe("output-limit");
    expect(result.outputLimitStream).toBe("stderr");
    expect(result.stdout).toEqual(Buffer.from("abcd"));
    expect(result.stderr).toEqual(Buffer.from("ef"));
  });

  it("maps timeout and pre-aborted signals without throwing", async () => {
    const timedOut = await runCommandBuffered(nodeCommand("setInterval(() => {}, 1_000)"), {
      timeoutMs: 20,
    });
    expect(timedOut.termination).toBe("timeout");

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      runCommandBuffered(nodeCommand("process.exit(99)"), {
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ code: null, termination: "signal", error: new Error("stop") });
  });

  it.runIf(process.platform !== "win32").for([
    { exitCode: 0, escaped: false, timeoutMs: 50 },
    { exitCode: 7, escaped: false, timeoutMs: 50 },
    { exitCode: 0, escaped: true, timeoutMs: 250 },
  ])(
    "drains descendants on failure or the post-success timeout (exit $exitCode, escaped=$escaped)",
    { timeout: 5_000 },
    async ({ exitCode, escaped, timeoutMs }, { signal }) =>
      withTempDir("openclaw-exec-descendant-", async (dir) => {
        const pidPath = path.join(dir, "descendant.pid");
        const termPath = path.join(dir, "sigterm");
        // Acknowledge only after the handler and keepalive exist. Stay quiet so
        // inherited-pipe release cannot kill the descendant through EPIPE.
        const descendantSource = [
          "import { writeFileSync } from 'node:fs'",
          fixtureReceiptClientSource(receipts.endpoint),
          `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(termPath)}, 'handled'); sendReceipt(${JSON.stringify(termPath)}, 'handled'); })`,
          "setInterval(() => {}, 1_000)",
          "process.send('ready')",
        ].join(";");
        const parentSource = [
          "const { spawn } = require('node:child_process')",
          "const { writeFileSync } = require('node:fs')",
          `const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(descendantSource)}], { detached: ${escaped}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })`,
          `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
          `child.once('message', () => process.exit(${exitCode}))`,
        ].join(";");
        const spawnSpy = vi.spyOn(execSpawn, "spawnCommandWithInvocation");
        let parent: ChildProcess | undefined;
        let descendantPid: number | undefined;
        let command: ReturnType<typeof runCommandBuffered> | undefined;
        // Freeze deadlines, not subprocess I/O: Node startup must not consume the
        // timeout or the 100ms inherited-pipe idle grace. Receipts stay real.
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        try {
          let settled = false;
          command = runCommandBuffered(nodeCommand(parentSource), {
            timeoutMs,
          }).then((result) => {
            settled = true;
            return result;
          });
          const spawnResult = spawnSpy.mock.results[0];
          if (spawnResult?.type !== "return") {
            throw new Error("command did not spawn");
          }
          parent = spawnResult.value.child.nodeChildProcess;
          if (!parent) {
            throw new Error("command did not expose a child process");
          }
          expect(
            await withinTest(
              awaitGateBeforeSettlement(
                once(parent, "exit", { signal }),
                command,
                "command settled before root exit",
              ),
              signal,
            ),
          ).toEqual([exitCode, null]);
          descendantPid = await readPidFile(pidPath);
          expect(isPidAlive(descendantPid)).toBe(true);
          expect(settled).toBe(false);

          if (escaped) {
            // This pipe holder has its own group: root-group termination cannot
            // close its pipes. Quiet successful output still belongs to the deadline.
            await vi.advanceTimersByTimeAsync(101);
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(parent.stdout?.destroyed).toBe(false);
            expect(parent.stderr?.destroyed).toBe(false);
            expect(settled).toBe(false);
            expect(isPidAlive(descendantPid)).toBe(true);
            expect(existsSync(termPath)).toBe(false);

            // The test signal unwinds cleanup if output release never reaches close.
            const closed = once(parent, "close");
            await vi.advanceTimersByTimeAsync(timeoutMs - 101);
            await vi.advanceTimersToNextTimerAsync();
            await vi.advanceTimersByTimeAsync(100);
            await vi.advanceTimersToNextTimerAsync();
            await vi.advanceTimersByTimeAsync(100);
            // Output release runs in the next timers phase so buffered pipe I/O
            // gets a poll turn on both Node and Bun.
            await vi.advanceTimersByTimeAsync(1);
            await withinTest(closed, signal);
            expect(await withinTest(command, signal)).toMatchObject({
              code: null,
              termination: "timeout",
            });
            expect(isPidAlive(descendantPid)).toBe(true);
            expect(existsSync(termPath)).toBe(false);
            return;
          }

          if (exitCode === 0) {
            expect(existsSync(termPath)).toBe(false);
            await vi.advanceTimersByTimeAsync(50);
            await vi.advanceTimersToNextTimerAsync();
            await vi.advanceTimersByTimeAsync(100);
            await vi.advanceTimersToNextTimerAsync();
          }
          // Receipt delivery is independent of command completion. The handler writes
          // its durable marker first, so that marker decides if completion wins the race.
          await withinTest(
            Promise.race([
              receipts.waitFor(termPath, "handled"),
              command.then(() => {
                expect(existsSync(termPath)).toBe(true);
              }),
            ]),
            signal,
          );
          expect(existsSync(termPath)).toBe(true);
          expect(isPidAlive(descendantPid)).toBe(true);
          expect(settled).toBe(false);

          await vi.advanceTimersByTimeAsync(execSpawn.COMMAND_PROCESS_TREE_KILL_GRACE_MS);
          // Force delivery now has a separate bounded exit-observation phase.
          await vi.advanceTimersByTimeAsync(execSpawn.COMMAND_PROCESS_TREE_KILL_GRACE_MS);
          expect(await withinTest(command, signal)).toMatchObject(
            exitCode === 0
              ? { code: null, termination: "timeout" }
              : { code: exitCode, termination: "exit" },
          );
          vi.useRealTimers();
          await waitForDescendantExit(descendantPid, signal);
          expect(isPidAlive(descendantPid)).toBe(false);
        } finally {
          try {
            // Record the spawned descendant before its readiness acknowledgement,
            // so even an early root/IPC failure can reap the explicitly owned group.
            if (descendantPid === undefined && existsSync(pidPath)) {
              descendantPid = await readPidFile(pidPath);
            }
            for (const groupPid of [parent?.pid, escaped ? descendantPid : undefined]) {
              if (groupPid === undefined || !Number.isInteger(groupPid) || groupPid <= 0) {
                continue;
              }
              try {
                process.kill(-groupPid, "SIGKILL");
              } catch {
                // Already gone.
              }
            }
            if (vi.isFakeTimers()) {
              await vi.runAllTimersAsync();
            }
          } finally {
            vi.useRealTimers();
            spawnSpy.mockRestore();
          }
          await command;
          if (parent?.pid) {
            // Command completion has already joined this root's close event.
            expect(isPidAlive(parent.pid)).toBe(false);
          }
          if (descendantPid !== undefined) {
            await waitForDescendantExit(descendantPid, signal);
            expect(isPidAlive(descendantPid)).toBe(false);
          }
        }
      }),
  );

  it.runIf(process.platform !== "win32")(
    "preserves a child-requested signal in buffered results",
    async () => {
      const result = await runCommandBuffered(nodeCommand("process.kill(process.pid, 'SIGTERM')"), {
        timeoutMs: 2_000,
      });

      expect(result).toMatchObject({ code: null, signal: "SIGTERM", termination: "signal" });
      expect(result.error).toBeUndefined();
    },
  );

  it("can discard a diagnostic stream without applying its byte cap", async () => {
    const result = await runCommandBuffered(
      nodeCommand("process.stderr.write('x'.repeat(1024)); process.stdout.write('ok')"),
      {
        discardOutput: { stderr: true },
        maxOutputBytes: { stdout: 32, stderr: 8 },
        timeoutMs: 3_000,
      },
    );

    expect(result).toMatchObject({ code: 0, termination: "exit" });
    expect(result.stdout).toEqual(Buffer.from("ok"));
    expect(result.stderr).toEqual(Buffer.alloc(0));
  });

  it("keeps argv values out of buffered transport errors", async () => {
    const privateArg = "private-buffered-argument";
    const result = await runCommandBuffered(
      [`openclaw-missing-${process.pid}-${Date.now()}`, privateArg],
      { timeoutMs: 3_000 },
    );

    expect(result).toMatchObject({ code: null, termination: "error" });
    expect(result.error).toMatchObject({ code: "ENOENT" });
    expect(result.error?.message).not.toContain(privateArg);
  });
});

describe("runExec", () => {
  it("supports stdin and an explicit base environment", async () => {
    const { stdout, stderr } = await runExec(
      process.execPath,
      [
        "-e",
        "process.stdin.pipe(process.stdout); process.stderr.write(process.env.OPENCLAW_RUN_EXEC_TEST ?? 'missing')",
      ],
      {
        baseEnv: { OPENCLAW_RUN_EXEC_TEST: "base" },
        input: Buffer.from("input"),
        timeoutMs: 3_000,
      },
    );
    expect(stdout).toBe("input");
    expect(stderr).toBe("base");
  });

  it("supports an inherited file descriptor as stdin", async () => {
    const descriptor = openSync(fileURLToPath(import.meta.url), "r");
    let running: ReturnType<typeof runExec>;
    try {
      running = runExec(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
        stdinFileDescriptor: descriptor,
        timeoutMs: 3_000,
      });
    } finally {
      // The child must own stdin before control returns to the caller.
      closeSync(descriptor);
    }
    const { stdout } = await running;
    expect(stdout).toContain("// Exec tests cover command execution");
  });

  it("can keep sensitive output out of verbose logs", async () => {
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setVerbose(true);
    try {
      await runExec(
        process.execPath,
        ["-e", "process.stdout.write('private-out'); process.stderr.write('private-err')"],
        { logOutput: false },
      );
      await expect(
        runExec(
          process.execPath,
          ["-e", "process.stderr.write('private-failure'); process.exit(2)"],
          { logOutput: false },
        ),
      ).rejects.toMatchObject({ code: 2 });
    } finally {
      setVerbose(false);
    }

    expect(stdoutSpy.mock.calls.flat().join(" ")).not.toContain("private-out");
    expect(stderrSpy.mock.calls.flat().join(" ")).not.toMatch(/private-err|private-failure/u);
  });
});

describe("attachChildProcessBridge", () => {
  it("forwards SIGTERM to the wrapped child and detaches on exit", () => {
    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const child = new EventEmitter() as EventEmitter & ChildProcess;
    const kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);
    child.kill = kill as ChildProcess["kill"];
    const observedSignals: NodeJS.Signals[] = [];

    const { detach } = attachChildProcessBridge(child, {
      signals: ["SIGTERM"],
      onSignal: (signal) => observedSignals.push(signal),
    });
    const addedSigterm = process
      .listeners("SIGTERM")
      .find((listener) => !beforeSigterm.has(listener));
    if (!addedSigterm) {
      throw new Error("expected SIGTERM listener");
    }

    addedSigterm("SIGTERM");
    expect(observedSignals).toEqual(["SIGTERM"]);
    expect(kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("exit");
    expect(process.listeners("SIGTERM")).toHaveLength(beforeSigterm.size);
    detach();
  });
});
