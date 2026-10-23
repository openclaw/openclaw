import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

beforeEach(() => {
  vi.useFakeTimers();
  spawnMock.mockReset();
});
afterEach(() => vi.useRealTimers());

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
  ["command", "timeoutMs", "pending"],
  ["command", "noOutputTimeoutMs", "refresh"],
  ["exec", "timeoutMs", "pending"],
  ["command", "timeoutMs", "drained"],
  ["tree", "timeoutMs", "drained"],
  ["exec", "timeoutMs", "drained"],
  ["command", "timeoutMs", "running"],
  ["command", "noOutputTimeoutMs", "running"],
  ["exec", "timeoutMs", "running"],
  ["tree", "timeoutMs", "stdout"],
  ["tree", "noOutputTimeoutMs", "stderr"],
] as const)("%s %s deadline with %s output", async (runner, deadline, phase) => {
  const command = createCommand();
  const success = phase === "pending" || phase === "refresh" || phase === "drained";
  const args = phase === "pending" || phase === "refresh" ? ["--version"] : [];
  if (runner === "exec" && !success) {
    command.kill.mockImplementation(() => {
      command.exit(0);
      return true;
    });
  }
  const result =
    runner === "exec"
      ? runExec(process.execPath, args, { timeoutMs: 20, logOutput: false })
      : runCommandWithTimeout([process.execPath, ...args], {
          [deadline]: 20,
          killProcessTree: runner === "tree",
        });
  const assertion = success
    ? undefined
    : runner === "exec"
      ? expect(result).rejects.toMatchObject({ timedOut: true, exitCode: 0 })
      : expect(result).resolves.toMatchObject({
          code: 124,
          termination: deadline === "timeoutMs" ? "timeout" : "no-output-timeout",
          ...(phase === "running" ? { signal: "SIGTERM", killed: true } : {}),
        });
  if (phase === "pending" || phase === "refresh") {
    vi.advanceTimersByTime(20);
    command.child.stdout.emit("data", Buffer.from("version\n"));
    command.child.stderr.emit("data", Buffer.from("diagnostic\n"));
    if (phase === "refresh") {
      await vi.advanceTimersByTimeAsync(19);
    }
    command.exit(0);
    await vi.runAllTimersAsync();
  } else if (phase === "running") {
    await vi.runAllTimersAsync();
  } else {
    command.emitExit(0);
    if (phase !== "drained") {
      command.child[phase === "stdout" ? "stderr" : "stdout"].end();
    }
    await vi.advanceTimersByTimeAsync(21);
    if (phase === "drained") {
      command.child.stdout.end("complete");
      command.child.stderr.end();
      await vi.advanceTimersByTimeAsync(101);
    } else {
      await vi.advanceTimersByTimeAsync(100);
      expect(command.child[phase].destroyed).toBe(false);
      expect(command.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    }
    command.settle();
  }
  if (success) {
    if (phase === "drained") {
      await expect(result).resolves.toMatchObject({
        stdout: "complete",
        ...(runner !== "exec" ? { code: 0, termination: "exit" } : {}),
      });
    } else {
      const output = { stdout: "version\n", stderr: "diagnostic\n" };
      await expect(result).resolves.toEqual(
        runner === "exec"
          ? output
          : expect.objectContaining({ ...output, code: 0, termination: "exit", killed: false }),
      );
    }
    expect(command.kill).not.toHaveBeenCalled();
  } else {
    await assertion;
    expect(command.kill).toHaveBeenCalledOnce();
  }
});
