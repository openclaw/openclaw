import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { materializeManagedWorktree } from "../agents/worktrees/checkout-materialize.js";
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
  const snapshot = () => ({
    exitCode: child.exitCode ?? undefined,
    signal: child.signalCode ?? undefined,
    failed: child.exitCode !== 0,
    isTerminated: child.signalCode !== null,
    stdout: Buffer.from(output.stdout),
    stderr: Buffer.from(output.stderr),
  });
  const completion = createDeferredCore<ReturnType<typeof snapshot>>();
  const emitExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
  };
  const settle = () => completion.resolve(snapshot());
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
    ["complete", "exit"],
    ["idle", "no-output-timeout"],
    ["cancel", "signal"],
    ["absolute", "timeout"],
  ] as const)("checkout progress honors %s completion", async (outcome, termination) => {
    const command = createCommand();
    const abort = new AbortController();
    const absolute = outcome === "absolute";
    const result = materializeManagedWorktree(
      {
        destination: "/fixture",
        commit: "HEAD",
        ...(absolute ? { executionTimeoutMs: 600_000 } : {}),
      },
      absolute
        ? { killProcessTree: true }
        : { timeoutMs: 300_000, signal: abort.signal, killProcessTree: true },
    );
    await vi.advanceTimersByTimeAsync(absolute ? 540_000 : 240_000);
    if (!absolute) {
      command.child.stderr.emit("data", Buffer.from("Updating files: 20%\r"));
      await vi.advanceTimersByTimeAsync(240_000);
    }
    if (absolute) {
      expect(command.kill).not.toHaveBeenCalled();
    }
    command.child.stderr.emit("data", Buffer.from("Updating files: 40%\r"));
    expect(command.kill).not.toHaveBeenCalled();
    if (outcome === "complete") {
      command.exit(0);
    } else if (outcome === "cancel") {
      abort.abort();
    } else {
      await vi.advanceTimersByTimeAsync(absolute ? 60_001 : 300_001);
    }
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({
      termination,
      killed: outcome !== "complete",
    });
    if (absolute) {
      expect(command.kill).toHaveBeenCalledOnce();
    }
    expect(spawnMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["read-tree", "--verbose", "-u", "HEAD"]),
    );
  });

  it.each([
    { runner: "command", deadline: "timeoutMs", timing: "pending" },
    { runner: "command", deadline: "noOutputTimeoutMs", timing: "pending" },
    { runner: "command", deadline: "noOutputTimeoutMs", timing: "refresh" },
    { runner: "exec", deadline: "timeoutMs", timing: "pending" },
    { runner: "command", deadline: "timeoutMs", timing: "before deadline" },
    { runner: "tree", deadline: "timeoutMs", timing: "before deadline" },
    { runner: "exec", deadline: "timeoutMs", timing: "before deadline" },
  ] as const)("$runner success: $deadline, $timing exit", async ({ runner, deadline, timing }) => {
    const command = createCommand();
    const earlyExit = timing === "before deadline";
    const args = earlyExit ? [] : ["--version"];
    const result =
      runner === "exec"
        ? runExec(process.execPath, args, { timeoutMs: 20, logOutput: false })
        : runCommandWithTimeout([process.execPath, ...args], {
            [deadline]: 20,
            ...(earlyExit ? { killProcessTree: runner === "tree" } : {}),
          });
    if (earlyExit) {
      command.emitExit(0);
      await vi.advanceTimersByTimeAsync(21);
      command.child.stdout.end("complete");
      command.child.stderr.end();
      await vi.advanceTimersByTimeAsync(101);
      command.settle();
      await expect(result).resolves.toMatchObject({
        stdout: "complete",
        ...(runner !== "exec" ? { code: 0, termination: "exit" } : {}),
      });
    } else {
      // Pending exit/output must beat a delivered deadline; idle output refreshes its budget.
      vi.advanceTimersByTime(20);
      command.child.stdout.emit("data", Buffer.from("version\n"));
      command.child.stderr.emit("data", Buffer.from("diagnostic\n"));
      if (timing === "refresh") {
        await vi.advanceTimersByTimeAsync(19);
        expect(command.kill).not.toHaveBeenCalled();
      }
      command.exit(0);
      await vi.runAllTimersAsync();
      const output = { stdout: "version\n", stderr: "diagnostic\n" };
      if (runner === "exec") {
        await expect(result).resolves.toEqual(output);
      } else {
        await expect(result).resolves.toMatchObject({
          ...output,
          code: 0,
          termination: "exit",
          killed: false,
        });
      }
    }
    expect(command.kill).not.toHaveBeenCalled();
  });
  it.each([
    { deadline: "timeoutMs", stream: undefined },
    { deadline: "noOutputTimeoutMs", stream: undefined },
    { deadline: "exec", stream: undefined },
    { deadline: "timeoutMs", stream: "stdout" },
    { deadline: "noOutputTimeoutMs", stream: "stderr" },
  ] as const)(
    "$deadline terminates running work or held $stream EOF",
    async ({ deadline, stream }) => {
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
          : runCommandWithTimeout([process.execPath], {
              [deadline]: 20,
              ...(stream ? { killProcessTree: true } : {}),
            });
      const assertion =
        deadline === "exec"
          ? expect(result).rejects.toMatchObject({ timedOut: true, exitCode: 0 })
          : expect(result).resolves.toMatchObject({
              code: 124,
              termination: deadline === "timeoutMs" ? "timeout" : "no-output-timeout",
              ...(!stream ? { signal: "SIGTERM", killed: true } : {}),
            });
      let pipeStillOpen: boolean | undefined;
      if (stream) {
        command.emitExit(0);
        command.child[stream === "stdout" ? "stderr" : "stdout"].end();
        await vi.advanceTimersByTimeAsync(21);
        await vi.advanceTimersByTimeAsync(100);
        pipeStillOpen = !command.child[stream].destroyed;
        expect(command.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        command.settle();
      } else {
        await vi.runAllTimersAsync();
      }
      await assertion;
      if (stream) {
        expect(pipeStillOpen).toBe(true);
      }
      expect(command.kill).toHaveBeenCalledOnce();
    },
  );
});
