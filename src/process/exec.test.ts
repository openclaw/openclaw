// Exec tests cover command execution, output capture, and cancellation behavior.
import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { waitForDead } from "../../test/helpers/process-wait.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setVerbose } from "../global-state.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { readPidFile } from "../test-utils/process-tree.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { attachChildProcessBridge } from "./child-process-bridge.js";
import { hasCommandProcessCleanupError } from "./exec-result.js";
import * as execSpawn from "./exec-spawn.js";
import { resolveCommandEnv } from "./exec-spawn.js";
import {
  runCommandBuffered,
  runCommandWithTimeout,
  runExec,
  runUtf8CommandWithTimeout,
  type CommandOptions,
  type RunExecOptions,
  type SpawnResult,
} from "./exec.js";

const nodeCommand = (source: string) => [process.execPath, "-e", source];
const runNode = (source: string, options: CommandOptions = {}) =>
  runCommandWithTimeout(nodeCommand(source), { timeoutMs: 3_000, ...options });
const bufferNode = (source: string, options: Parameters<typeof runCommandBuffered>[1] = {}) =>
  runCommandBuffered(nodeCommand(source), { timeoutMs: 3_000, ...options });
const execNode = (source: string, options?: RunExecOptions) =>
  runExec(process.execPath, ["-e", source], options);
async function advanceTime(...steps: (number | "next")[]) {
  for (const step of steps) {
    await (step === "next"
      ? vi.advanceTimersToNextTimerAsync()
      : vi.advanceTimersByTimeAsync(step));
  }
}

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());
afterEach(() => vi.unstubAllEnvs());

describe("runCommandWithTimeout", () => {
  it.skipIf(process.platform === "win32").each(["cooperative", "forced"] as const)(
    "reports invocation cleanup and honors the initial SIGINT signal: %s",
    async (mode) => {
      const controller = new AbortController();
      const started = createDeferred();
      const program = `const timer=setInterval(()=>{},1000); process.on('SIGINT',()=>{${mode === "cooperative" ? "clearInterval(timer);process.stdout.write('interrupted');process.exitCode=17;" : ""}}); process.stdout.write('ready');`;
      // Keep process I/O and polling real, but don't let host scheduling consume the grace period.
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      try {
        const running = runNode(program, {
          signal: controller.signal,
          killProcessTree: true,
          killSignal: "SIGINT",
          killGraceMs: 100,
          timeoutMs: 5000,
          onOutputChunk: () => started.resolve(undefined),
        });
        await started.promise;
        controller.abort();
        if (mode === "forced") {
          now.mockReturnValue(1_100);
        }
        const result = await running;
        expect(result).toMatchObject({ cleanup: mode, killIssuedByAbort: true });
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
        running = runNode(
          `const {spawn}=require('node:child_process');
          const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')"],{stdio:['ignore','ignore','ignore','ipc']});
          child.once('message',()=>{process.stdout.write(String(child.pid));child.disconnect();child.unref();});`,
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
        expect(result).toMatchObject({ code: 0, cleanup: "forced" });
        expect(isPidAlive(descendant!)).toBe(false);
      } finally {
        await running?.catch(() => undefined);
        if (descendant && isPidAlive(descendant)) {
          process.kill(descendant, "SIGKILL");
          await waitForDead(descendant, signal);
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports normal extinction after a successful native-style command with a SIGKILL timeout",
    async () => {
      const result = await runNode("process.stdout.write('enabled\\n')", {
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        killSignal: "SIGKILL",
        timeoutMs: 5_000,
      });
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
    const result = await runNode(`process.stdout.write(process.env.${key} ?? "missing")`, {
      timeoutMs: 2_000,
      baseEnv: {},
    });
    expect(result.stdout).toBe("missing");
  });

  it("returns without spawning when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runNode("process.exit(99)", {
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
      const result = await runNode(
        [
          "process.stdout.write('Visit https://example.com/device and enter code ABCD-EFGH\\n')",
          "process.stdout.write('x'.repeat(10_000) + 'enter code TAIL')",
        ].join(";"),
        {
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

    expect(result).toMatchObject({
      stdout: "a",
      stderr: "y",
      stdoutTruncatedBytes: 5,
      stderrTruncatedBytes: 5,
    });
  });

  it.each<[string, string, CommandOptions, Partial<SpawnResult>]>([
    [
      "keeps the combined tail",
      "process.stdout.write('abcdefgh')",
      { maxCombinedOutputBytes: 4, maxOutputBytes: 16, outputCapture: "tail" },
      { stdout: "efgh", stdoutTruncatedBytes: 4 },
    ],
    [
      "does not treat combined overflow as selected-stream overflow",
      "process.stderr.write('abcdefgh'); setImmediate(() => process.stdout.write('x'))",
      {
        maxCombinedOutputBytes: 8,
        maxOutputBytes: 16,
        outputCapture: "head",
        terminateOnOutputLimit: { stdout: true },
      },
      {
        termination: "exit",
        stdout: "",
        stderr: "abcdefgh",
        outputLimitExceeded: undefined,
      },
    ],
    [
      "terminates on selected-stream overflow",
      "process.stdout.write('x'.repeat(100)); setInterval(() => {}, 1000)",
      {
        maxOutputBytes: { stdout: 16, stderr: 16 },
        outputCapture: "head",
        terminateOnOutputLimit: { stdout: true },
      },
      { outputLimitExceeded: true, termination: "signal", stdout: "x".repeat(16) },
    ],
  ])("%s", async (_name, source, options, expected) => {
    expect(await runNode(source, options)).toMatchObject(expected);
  });

  it("rejects mixed capture modes under a combined cap", async () => {
    await expect(
      runNode("process.exit(0)", {
        maxCombinedOutputBytes: 16,
        outputCapture: { stdout: "head", stderr: "tail" },
      }),
    ).rejects.toThrow("maxCombinedOutputBytes requires matching stdout and stderr capture modes");
  });

  it("observes discarded output and stops without retaining it", async () => {
    let observedBytes = 0;
    const result = await runNode(
      "process.stdout.write('x'.repeat(1024 * 1024)); setInterval(() => {}, 1000)",
      {
        onOutputChunk: (chunk, stream) => {
          if (stream !== "stdout") {
            return true;
          }
          observedBytes += chunk.byteLength;
          return observedBytes < 32 * 1024;
        },
        outputCapture: { stdout: "discard", stderr: "tail" },
      },
    );

    expect(observedBytes).toBeGreaterThanOrEqual(32 * 1024);
    expect(result.stdoutTruncatedBytes).toBeGreaterThanOrEqual(observedBytes);
    expect(result).toMatchObject({ stdout: "", outputLimitExceeded: true, termination: "signal" });
  });

  it("retires a failed launch before its scope closes and keeps argv out of the error", async () => {
    const privateArg = "private-command-argument";
    const reservation = { spawned: vi.fn(), settled: vi.fn() };
    await execSpawn.withCommandProcessScope(
      async () => {
        const error = await runCommandWithTimeout(
          [`openclaw-missing-${process.pid}-${Date.now()}`, "--token", privateArg],
          { timeoutMs: 3_000 },
        ).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain(privateArg);
        expect(error).toMatchObject({ code: "ENOENT" });
        expect(reservation.spawned).not.toHaveBeenCalled();
        expect(reservation.settled).toHaveBeenCalledOnce();
      },
      undefined,
      { reserve: () => reservation },
    );
  });
});

describe("runCommandBuffered", () => {
  it.each([
    {
      name: "preserves ordinary nonzero exit and output",
      source: "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7",
      options: {},
      expected: { code: 7, signal: null, termination: "exit" },
      output: ["out", "err"],
    },
    {
      name: "caps stdout and stderr under one aggregate budget",
      source: "process.stdout.write('abcd'); setImmediate(() => process.stderr.write('efgh'))",
      options: { maxCombinedOutputBytes: 6, maxOutputBytes: 8 },
      expected: { termination: "output-limit", outputLimitStream: "stderr" },
      output: ["abcd", "ef"],
    },
    {
      name: "discards stderr without applying its byte cap",
      source: "process.stderr.write('x'.repeat(1024)); process.stdout.write('ok')",
      options: { discardOutput: { stderr: true }, maxOutputBytes: { stdout: 32, stderr: 8 } },
      expected: { code: 0, termination: "exit" },
      output: ["ok", ""],
    },
  ])("$name", async ({ source, options, expected, output }) => {
    const result = await bufferNode(source, options);
    expect(result).toMatchObject(expected);
    expect([result.stdout, result.stderr]).toEqual(output.map((text) => Buffer.from(text)));
    expect(result.error).toBeUndefined();
  });

  it("maps timeout and pre-aborted signals without throwing", async () => {
    const timedOut = await bufferNode("setInterval(() => {}, 1_000)", {
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
        const bounded = <T>(work: PromiseLike<T>) => withinTest(work, signal);
        const pidPath = path.join(dir, "descendant.pid");
        const termPath = path.join(dir, "sigterm");
        // Stay quiet so inherited-pipe release cannot kill the descendant through EPIPE.
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
        // Freeze deadlines so startup cannot consume timeout/pipe grace; receipts stay real.
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
        try {
          let settled = false;
          command = bufferNode(parentSource, {
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
          const rootExit = awaitGateBeforeSettlement(
            once(parent, "exit", { signal }),
            command,
            "command settled before root exit",
          );
          expect(await bounded(rootExit)).toEqual([exitCode, null]);
          descendantPid = await readPidFile(pidPath);
          expect(isPidAlive(descendantPid)).toBe(true);
          expect(settled).toBe(false);

          if (escaped) {
            // The escaped pipe holder is outside root-group termination; wait for the deadline.
            await vi.advanceTimersByTimeAsync(101);
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(parent.stdout?.destroyed).toBe(false);
            expect(parent.stderr?.destroyed).toBe(false);
            expect(settled).toBe(false);
            expect(isPidAlive(descendantPid)).toBe(true);
            expect(existsSync(termPath)).toBe(false);

            const closed = once(parent, "close");
            await advanceTime(timeoutMs - 101, "next", 100, "next", 100);
            // Give Node/Bun pipe I/O its poll turn before release.
            await vi.advanceTimersByTimeAsync(1);
            await bounded(closed);
            expect(await bounded(command)).toMatchObject({
              code: null,
              termination: "timeout",
            });
            expect(isPidAlive(descendantPid)).toBe(true);
            expect(existsSync(termPath)).toBe(false);
            return;
          }

          if (exitCode === 0) {
            expect(existsSync(termPath)).toBe(false);
            await advanceTime(50, "next", 100, "next");
          }
          // The durable marker precedes the receipt and arbitrates completion races.
          await bounded(
            Promise.race([
              receipts.waitFor(termPath, "handled"),
              command.then(() => {
                expect(existsSync(termPath)).toBe(true);
              }),
            ]),
          );
          expect(existsSync(termPath)).toBe(true);
          expect(isPidAlive(descendantPid)).toBe(true);
          expect(settled).toBe(false);

          await vi.advanceTimersByTimeAsync(execSpawn.COMMAND_PROCESS_TREE_KILL_GRACE_MS);
          // Force delivery now has a separate bounded exit-observation phase.
          await vi.advanceTimersByTimeAsync(execSpawn.COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS);
          expect(await bounded(command)).toMatchObject(
            exitCode === 0
              ? { code: null, termination: "timeout" }
              : { code: exitCode, termination: "exit" },
          );
          vi.useRealTimers();
          await waitForDead(descendantPid, signal);
        } finally {
          try {
            // Recover ownership even after an early root/IPC failure.
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
            // Escaped descendants outlive the root handle; no owner exposes their exit event.
            await waitForDead(descendantPid, signal);
          }
        }
      }),
  );

  it.runIf(process.platform !== "win32")(
    "preserves cleanup uncertainty alongside a child-requested signal and buffered output",
    async () => {
      const result = await bufferNode(
        "require('node:fs').writeSync(1, 'out'); require('node:fs').writeSync(2, 'err'); process.kill(process.pid, 'SIGTERM')",
        { timeoutMs: 2_000 },
      );

      expect(result).toMatchObject({ code: null, signal: "SIGTERM", termination: "signal" });
      expect([result.stdout, result.stderr]).toEqual([Buffer.from("out"), Buffer.from("err")]);
      expect(hasCommandProcessCleanupError(result.error)).toBe(true);
    },
  );

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
    const { stdout, stderr } = await execNode(
      "process.stdin.pipe(process.stdout); process.stderr.write(process.env.OPENCLAW_RUN_EXEC_TEST ?? 'missing')",
      {
        baseEnv: { OPENCLAW_RUN_EXEC_TEST: "base" },
        input: Buffer.from("input"),
        timeoutMs: 3_000,
      },
    );
    expect({ stdout, stderr }).toEqual({ stdout: "input", stderr: "base" });
  });

  it("supports an inherited file descriptor as stdin", async () => {
    const descriptor = openSync(fileURLToPath(import.meta.url), "r");
    const running = execNode("process.stdin.pipe(process.stdout)", {
      stdinFileDescriptor: descriptor,
      timeoutMs: 3_000,
    });
    // runExec is async; even startup errors reject, so close before awaiting it.
    closeSync(descriptor);
    const { stdout } = await running;
    expect(stdout).toContain("// Exec tests cover command execution");
  });

  it("can keep sensitive output out of verbose logs", async () => {
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setVerbose(true);
    try {
      await execNode("process.stdout.write('private-out'); process.stderr.write('private-err')", {
        logOutput: false,
      });
      await expect(
        execNode("process.stderr.write('private-failure'); process.exit(2)", { logOutput: false }),
      ).rejects.toMatchObject({ code: 2 });
    } finally {
      setVerbose(false);
    }

    expect(stdoutSpy.mock.calls.flat().join(" ")).not.toContain("private-out");
    expect(stderrSpy.mock.calls.flat().join(" ")).not.toMatch(/private-err|private-failure/u);
  });
});

it("preserves existing signal handlers when the child bridge detaches after close", () => {
  const existing = () => {};
  process.on("SIGTERM", existing);
  const before = process.listeners("SIGTERM");
  const child = new ChildProcess();
  const { detach } = attachChildProcessBridge(child);
  try {
    child.emit("close", 0, null);
    expect(process.listeners("SIGTERM")).toEqual(before);
  } finally {
    detach();
    process.off("SIGTERM", existing);
  }
});

describe("package manager runtime", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  const require = createRequire(import.meta.url);

  it.skipIf(process.platform === "win32")(
    "hands an explicit Node runtime to npm preinstall children",
    async ({ signal }) => {
      const root = dirs.make("npm-lifecycle-node-");
      const privateBin = path.join(root, "private", "bin");
      const systemBin = path.join(root, "system", "bin");
      await fs.mkdir(privateBin, { recursive: true });
      await fs.mkdir(systemBin, { recursive: true });
      const nodeExecPath = resolveTestNodeExecPath();
      const privateNode = path.join(privateBin, "node");
      await fs.symlink(nodeExecPath, privateNode);
      await fs.writeFile(path.join(systemBin, "node"), "#!/bin/sh\necho v22.22.3\n", {
        mode: 0o755,
      });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "runtime-handoff-fixture",
          version: "1.0.0",
          scripts: { preinstall: 'node -p "process.execPath"' },
        }),
      );
      const npmCli = path.join(
        path.dirname(require.resolve("npm/package.json")),
        "bin",
        "npm-cli.js",
      );
      // Runtime handoff is the contract; host scheduling must not consume its deadline.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      try {
        const result = await runCommandWithTimeout(
          [
            privateNode,
            npmCli,
            "install",
            "--offline",
            "--no-audit",
            "--no-fund",
            "--package-lock=false",
          ],
          {
            cwd: root,
            signal,
            timeoutMs: 10_000,
            baseEnv: {},
            env: {
              HOME: root,
              OPENCLAW_STATE_DIR: path.join(root, "state"),
              PATH: [systemBin, process.env.PATH].join(path.delimiter),
              npm_config_cache: path.join(root, "cache"),
              npm_config_userconfig: path.join(root, "empty-npmrc"),
              npm_config_globalconfig: path.join(root, "empty-global-npmrc"),
            },
          },
        );
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain(nodeExecPath);
        expect(result.stdout).not.toContain("v22.22.3");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["pnpm.cjs", "pnpm.js"])(
    "preserves Windows PATH casing and npm config for an explicit %s runtime",
    (cli) => {
      const env = { Path: "C:\\system;C:\\private", npm_config_node: "operator-choice" };
      const result = resolveCommandEnv({
        argv: ["C:\\private\\node.exe", `C:\\tools\\${cli}`, "install"],
        baseEnv: {},
        env,
        platform: "win32",
      });
      expect(result).toMatchObject({
        Path: "C:\\private;C:\\system",
        npm_config_node: "operator-choice",
      });
      expect(result.PATH).toBeUndefined();
      expect(env.Path).toBe("C:\\system;C:\\private");
    },
  );

  it("keeps the caller's runtime selection for plain npm", () => {
    const env = { PATH: "/selected/bin:/system/bin", npm_config_node: "operator-choice" };
    const result = resolveCommandEnv({ argv: ["npm", "install"], baseEnv: {}, env });
    expect(result).toMatchObject(env);
  });
});
