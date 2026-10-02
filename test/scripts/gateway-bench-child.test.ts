import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { stopChild } from "../../scripts/lib/gateway-bench-child.ts";

function childFixture() {
  const state: { exitCode: number | null; signalCode: NodeJS.Signals | null } = {
    exitCode: null,
    signalCode: null,
  };
  return Object.assign(new EventEmitter(), state, { kill: vi.fn(() => true) });
}

function pipedChildFixture() {
  return Object.assign(childFixture(), {
    stderr: { destroy: vi.fn() },
    stdin: { destroy: vi.fn() },
    stdout: { destroy: vi.fn() },
    unref: vi.fn(),
  });
}

describe("gateway benchmark child teardown", () => {
  it("classifies a queued child failure before sending teardown signals", async () => {
    const child = childFixture();
    const stopped = stopChild(child as unknown as ChildProcess);
    queueMicrotask(() => {
      child.exitCode = 7;
      child.emit("exit", 7, null);
    });
    await expect(stopped).resolves.toEqual({
      exitedBeforeTeardown: true,
      exitCode: 7,
      signal: null,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("classifies failed teardown signaling as a pre-teardown child exit", async () => {
    const child = childFixture();
    child.kill.mockImplementation(() => {
      setImmediate(() => {
        child.exitCode = 8;
        child.emit("exit", 8, null);
      });
      return false;
    });
    await expect(stopChild(child as unknown as ChildProcess)).resolves.toEqual({
      exitedBeforeTeardown: true,
      exitCode: 8,
      signal: null,
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bounds teardown and releases IPC when the child ignores termination signals", async () => {
    const child = Object.assign(pipedChildFixture(), { channel: { unref: vi.fn() } });
    await expect(
      stopChild(child as unknown as ChildProcess, { killGraceMs: 1, teardownGraceMs: 1 }),
    ).resolves.toEqual({
      exitedBeforeTeardown: false,
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
    expect(child.channel.unref).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32").each([true, false])(
    "joins the process group after wrapper exit with exitedBeforeTeardown=%s",
    async (exitedBeforeTeardown) => {
      const child = Object.assign(pipedChildFixture(), { pid: 4444 });
      const queueExit = () => {
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        });
      };
      let emittedExit = false;
      let processGroupAlive = true;
      const processKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        expect(pid).toBe(-child.pid);
        if (!exitedBeforeTeardown && signal === "SIGTERM" && !emittedExit) {
          emittedExit = true;
          queueExit();
        }
        if (signal === "SIGKILL") {
          processGroupAlive = false;
          return true;
        }
        if (signal === 0 && !processGroupAlive) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        return true;
      });
      try {
        const stopped = stopChild(child as unknown as ChildProcess, {
          killGraceMs: 50,
          teardownGraceMs: 1,
        });
        if (exitedBeforeTeardown) {
          queueExit();
        }
        await expect(stopped).resolves.toEqual({ exitedBeforeTeardown, exitCode: 0, signal: null });
        expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
        expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
        expect(child.kill).not.toHaveBeenCalled();
        expect(child.stdin.destroy).not.toHaveBeenCalled();
        expect(child.stdout.destroy).not.toHaveBeenCalled();
        expect(child.stderr.destroy).not.toHaveBeenCalled();
        expect(child.unref).not.toHaveBeenCalled();
      } finally {
        processKill.mockRestore();
      }
    },
  );
});
