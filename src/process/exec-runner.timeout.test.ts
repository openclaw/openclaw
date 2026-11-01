import { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withWorktreeGitConfig } from "../agents/worktrees/checkout-git-config.js";
import { materializeManagedWorktree } from "../agents/worktrees/checkout-materialize.js";
import { captureSettledGitHubPublicationWorkspaceSnapshot } from "../gateway/github-publication-git-transport.js";
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

function createCommand(install = true) {
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
  const spawn = (_argv: unknown, options: { cancelSignal?: AbortSignal }) => {
    options.cancelSignal?.addEventListener("abort", kill, { once: true });
    return Object.assign(completion.promise, {
      nodeChildProcess: child,
      pid: 1234,
      stdout: child.stdout,
      stderr: child.stderr,
      kill,
    });
  };
  if (install) {
    spawnMock.mockImplementation(spawn);
  }
  return { child, exit, emitExit, settle, kill, spawn };
}

beforeEach(() => {
  vi.useFakeTimers();
  spawnMock.mockReset();
});
afterEach(() => vi.useRealTimers());

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it.each([
  ["progress", 240_000],
  ["managed", 240_000],
  ["idle", 180_001],
  ["absolute", 600_000],
] as const)(
  "publication snapshot bounds %s staging without changing the source index",
  async (ending, duration) => {
    const success = ending === "progress" || ending === "managed";
    const cwd = tempDirs.make("publication-timeout-");
    const index = path.join(cwd, "index");
    await fs.writeFile(index, "source index");
    const staged = createDeferredCore<ReturnType<typeof createCommand>>();
    spawnMock.mockImplementation((argv: string[], options: { cancelSignal?: AbortSignal }) => {
      const command = createCommand(false);
      const result = command.spawn(argv, options);
      if (argv.includes("add")) {
        staged.resolve(command);
      } else {
        const output =
          argv.includes("HEAD^{commit}") || argv.includes("write-tree")
            ? "b".repeat(40)
            : argv.at(-1) === "index"
              ? index
              : argv.at(-1)?.startsWith("info/")
                ? path.join(cwd, "absent")
                : "";
        void Promise.resolve().then(() => {
          command.child.stdout.end(output);
          command.child.stderr.end();
          command.exit(argv.includes("config") ? 1 : 0);
        });
      }
      return result;
    });
    const result = withWorktreeGitConfig(cwd, false, {}, (policy) =>
      captureSettledGitHubPublicationWorkspaceSnapshot(
        { cwd },
        ending === "managed" ? policy : undefined,
      ),
    ).catch((error: unknown) => error);
    const command = await staged.promise;
    for (let elapsed = 0; elapsed < duration; elapsed += 40_000) {
      await vi.advanceTimersByTimeAsync(Math.min(40_000, duration - elapsed));
      if (ending !== "idle") {
        command.child.stdout.emit("data", Buffer.from("add 'artifact.txt'\n"));
      }
    }
    if (success) {
      command.child.stdout.end();
      command.child.stderr.end();
      command.exit(0);
    } else {
      await vi.runAllTimersAsync();
    }
    await expect(result).resolves.toMatchObject(
      success
        ? { workspaceTree: "b".repeat(40) }
        : {
            message: expect.stringMatching(
              ending === "idle"
                ? /snapshot.*timed out waiting for output.*retry/isu
                : /snapshot.*timed out after 600 seconds.*retry/isu,
            ),
          },
    );
    expect(command.kill).toHaveBeenCalledTimes(success ? 0 : 1);
    expect(await fs.readFile(index, "utf8")).toBe("source index");
  },
);

it.each([
  ["idle", "no-output-timeout"],
  ["absolute", "timeout"],
] as const)("checkout progress honors %s completion", async (outcome, termination) => {
  const command = createCommand();
  const absolute = outcome === "absolute";
  const result = materializeManagedWorktree(
    {
      destination: "/fixture",
      commit: "HEAD",
      ...(absolute ? { executionTimeoutMs: 600_000 } : {}),
    },
    { timeoutMs: 300_000, killProcessTree: true },
  );
  await vi.advanceTimersByTimeAsync(absolute ? 540_000 : 240_000);
  if (!absolute) {
    command.child.stderr.emit("data", Buffer.from("Updating files: 20%\r"));
    await vi.advanceTimersByTimeAsync(240_000);
  }
  command.child.stderr.emit("data", Buffer.from("Updating files: 40%\r"));
  expect(command.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(absolute ? 60_001 : 300_001);
  await vi.runAllTimersAsync();
  await expect(result).resolves.toMatchObject({ termination, killed: true });
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
    const output =
      phase === "drained"
        ? { stdout: "complete" }
        : { stdout: "version\n", stderr: "diagnostic\n" };
    await expect(result).resolves.toEqual(
      runner === "exec"
        ? phase === "drained"
          ? expect.objectContaining(output)
          : output
        : expect.objectContaining({ ...output, code: 0, termination: "exit", killed: false }),
    );
    expect(command.kill).not.toHaveBeenCalled();
  } else {
    await assertion;
    expect(command.kill).toHaveBeenCalledOnce();
  }
});
