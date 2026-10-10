import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { runCommandWithTimeout } from "./exec-runner.js";
import { runExec } from "./exec.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("./exec-spawn.js", () => ({
  COMMAND_PROCESS_TREE_KILL_GRACE_MS: 300,
  resolveCommandProcessSignal: (signal?: AbortSignal) => signal,
  retainCommandProcessCleanup: vi.fn(),
  waitForCommandSpawn: vi.fn(),
  spawnCommand: spawnMock,
  spawnCommandWithInvocation: (...args: unknown[]) => ({
    child: spawnMock(...args),
    invocation: { usesWindowsExitCodeShim: false },
  }),
}));

class CommandChild extends ChildProcess {
  override stdout = new PassThrough();
  override stderr = new PassThrough();
  // The fixture delivers the native state changes behind Node's read-only public fields.
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;
  override killed = false;
}

function createCommand() {
  const child = new CommandChild();
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk: Buffer) => (output.stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output.stderr += chunk.toString()));
  const completion = createDeferredCore<{
    exitCode: number | undefined;
    signal: NodeJS.Signals | undefined;
    failed: boolean;
    isTerminated: boolean;
    stdout: Buffer;
    stderr: Buffer;
  }>();
  const emitExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
  };
  const settle = () => {
    completion.resolve({
      exitCode: child.exitCode ?? undefined,
      signal: child.signalCode ?? undefined,
      failed: child.exitCode !== 0,
      isTerminated: child.signalCode !== null,
      stdout: Buffer.from(output.stdout),
      stderr: Buffer.from(output.stderr),
    });
  };
  const exit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    emitExit(code, signal);
    settle();
  };
  const kill = vi.fn(() => {
    child.killed = true;
    if (child.exitCode === null && child.signalCode === null) {
      exit(null, "SIGTERM");
    }
    return true;
  });
  spawnMock.mockImplementation((_argv, options: { cancelSignal?: AbortSignal }) => {
    options.cancelSignal?.addEventListener("abort", kill, { once: true });
    return Object.assign(completion.promise, {
      nodeChildProcess: child,
      pid: 1234,
      stdout: child.stdout,
      stderr: child.stderr,
      kill,
    });
  });
  return { child, exit, emitExit, settle, kill };
}

describe("command deadline event ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { runner: "command", deadline: "timeoutMs", refresh: false },
    { runner: "command", deadline: "noOutputTimeoutMs", refresh: false },
    { runner: "command", deadline: "noOutputTimeoutMs", refresh: true },
    { runner: "exec", deadline: "timeoutMs", refresh: false },
  ] as const)(
    "preserves $runner success behind $deadline (refresh=$refresh)",
    async ({ runner, deadline, refresh }) => {
      const command = createCommand();
      const result =
        runner === "exec"
          ? runExec(process.execPath, ["--version"], { timeoutMs: 20, logOutput: false })
          : runCommandWithTimeout([process.execPath, "--version"], { [deadline]: 20 });
      // Exit/output may already be pending when Node delivers the deadline callback.
      vi.advanceTimersByTime(20);
      command.child.stdout.emit("data", Buffer.from("version\n"));
      command.child.stderr.emit("data", Buffer.from("diagnostic\n"));
      if (refresh) {
        await vi.advanceTimersByTimeAsync(19);
        expect(command.kill).not.toHaveBeenCalled();
      }
      command.exit(0);
      await vi.runAllTimersAsync();
      if (runner === "exec") {
        await expect(result).resolves.toEqual({ stdout: "version\n", stderr: "diagnostic\n" });
      } else {
        await expect(result).resolves.toMatchObject({
          code: 0,
          termination: "exit",
          stdout: "version\n",
          stderr: "diagnostic\n",
          killed: false,
        });
      }
      expect(command.kill).not.toHaveBeenCalled();
    },
  );

  it.each(["timeoutMs", "noOutputTimeoutMs", "exec"] as const)(
    "terminates running work after %s",
    async (deadline) => {
      const command = createCommand();
      if (deadline === "exec") {
        command.kill.mockImplementation(() => {
          command.exit(0);
          return true;
        });
      }
      const result =
        deadline === "exec"
          ? runExec(process.execPath, [], { timeoutMs: 20, logOutput: false })
          : runCommandWithTimeout([process.execPath], { [deadline]: 20 });
      const assertion =
        deadline === "exec"
          ? expect(result).rejects.toMatchObject({ timedOut: true, exitCode: 0 })
          : expect(result).resolves.toMatchObject({
              code: 124,
              termination: deadline === "timeoutMs" ? "timeout" : "no-output-timeout",
              signal: "SIGTERM",
              killed: true,
            });
      await vi.runAllTimersAsync();
      await assertion;
      expect(command.kill).toHaveBeenCalledOnce();
    },
  );

  it.each(["command", "tree", "exec"] as const)(
    "preserves %s success when exit precedes the deadline decision and EOF follows it",
    async (runner) => {
      const command = createCommand();
      const result =
        runner === "exec"
          ? runExec(process.execPath, [], { timeoutMs: 20, logOutput: false })
          : runCommandWithTimeout([process.execPath], {
              timeoutMs: 20,
              killProcessTree: runner === "tree",
            });
      command.emitExit(0);
      await vi.advanceTimersByTimeAsync(21);
      command.child.stdout?.end("complete");
      command.child.stderr?.end();
      await vi.advanceTimersByTimeAsync(101);
      command.settle();

      await expect(result).resolves.toMatchObject({
        stdout: "complete",
        ...(runner !== "exec" ? { code: 0, termination: "exit" } : {}),
      });
      expect(command.kill).not.toHaveBeenCalled();
    },
  );

  it.each([
    { deadline: "timeoutMs", stream: "stdout" },
    { deadline: "noOutputTimeoutMs", stream: "stderr" },
  ] as const)(
    "times out owned $stream held past the bounded EOF grace after $deadline",
    async ({ deadline, stream }) => {
      const command = createCommand();
      const result = runCommandWithTimeout([process.execPath], {
        [deadline]: 20,
        killProcessTree: true,
      });
      command.emitExit(0);
      command.child[stream === "stdout" ? "stderr" : "stdout"].end();
      await vi.advanceTimersByTimeAsync(21);
      await vi.advanceTimersByTimeAsync(100);
      const pipeStillOpen = !command.child[stream].destroyed;
      expect(command.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      command.settle();
      await expect(result).resolves.toMatchObject({
        code: 124,
        termination: deadline === "timeoutMs" ? "timeout" : "no-output-timeout",
      });
      expect(pipeStillOpen).toBe(true);
      expect(command.kill).toHaveBeenCalledOnce();
    },
  );
});
