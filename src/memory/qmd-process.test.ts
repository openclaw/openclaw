import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const killProcessTreeMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: (...args: unknown[]) => killProcessTreeMock(...args),
}));

const { runCliCommand } = await import("./qmd-process.js");

function createChildProcessMock(pid = 12345) {
  const child = new EventEmitter() as EventEmitter & ChildProcess;
  child.pid = pid;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  child.kill = vi.fn(() => true) as ChildProcess["kill"];
  return child;
}

describe("runCliCommand abort handling", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    killProcessTreeMock.mockReset();
  });

  it("rejects immediately without spawning when the abort signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort(new Error("stop"));

    await expect(
      runCliCommand({
        commandSummary: "qmd update",
        spawnInvocation: { command: "qmd", argv: ["update"] },
        env: {},
        cwd: "/tmp",
        maxOutputChars: 10_000,
        abortSignal: abort.signal,
      }),
    ).rejects.toThrow("qmd update aborted");

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("kills the process tree and rejects promptly when aborted mid-run", async () => {
    const child = createChildProcessMock();
    spawnMock.mockReturnValue(child);
    const abort = new AbortController();

    const commandPromise = runCliCommand({
      commandSummary: "qmd update",
      spawnInvocation: { command: "qmd", argv: ["update"] },
      env: {},
      cwd: "/tmp",
      maxOutputChars: 10_000,
      abortSignal: abort.signal,
    });

    abort.abort(new Error("stop"));

    await expect(commandPromise).rejects.toThrow("qmd update aborted");
    expect(killProcessTreeMock).toHaveBeenCalledWith(12345, { graceMs: 0 });
  });
});
