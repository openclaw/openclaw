import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { stopChild } from "../../scripts/lib/gateway-bench-child.ts";

class ChildFixture extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
  exit(code = 0) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
  stop = stopChild.bind(null, this as unknown as ChildProcess);
}

class PipedChild extends ChildFixture {
  stderr = { destroy: vi.fn() };
  stdin = { destroy: vi.fn() };
  stdout = { destroy: vi.fn() };
  unref = vi.fn();
}

function expectReleased(child: PipedChild, count: number) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    expect(stream.destroy).toHaveBeenCalledTimes(count);
  }
  expect(child.unref).toHaveBeenCalledTimes(count);
}

afterEach(() => vi.restoreAllMocks());

it.each([true, false])("classifies pre-teardown failure with queued=%s", async (queued) => {
  const child = new ChildFixture();
  const exitCode = queued ? 7 : 8;
  const exit = () => child.exit(exitCode);
  if (!queued) {
    child.kill.mockImplementation(() => {
      setImmediate(exit);
      return false;
    });
  }
  const stopped = child.stop();
  if (queued) {
    queueMicrotask(exit);
  }
  await expect(stopped).resolves.toEqual({ exitedBeforeTeardown: true, exitCode, signal: null });
  expect(child.kill.mock.calls).toEqual(queued ? [] : [["SIGTERM"]]);
});

it("bounds teardown and releases IPC when the child ignores termination signals", async () => {
  const child = Object.assign(new PipedChild(), { channel: { unref: vi.fn() } });
  const result = await child.stop({ killGraceMs: 1, teardownGraceMs: 1 });
  expect(result).toEqual({ exitedBeforeTeardown: false, exitCode: null, signal: "SIGKILL" });
  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  expectReleased(child, 1);
  expect(child.channel.unref).toHaveBeenCalledOnce();
});

it.skipIf(process.platform === "win32").each([true, false])(
  "joins the process group after wrapper exit with exitedBeforeTeardown=%s",
  async (exitedBeforeTeardown) => {
    const child = Object.assign(new PipedChild(), { pid: 4444 });
    let emittedExit = false;
    let processGroupAlive = true;
    const processKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(-child.pid);
      if (!exitedBeforeTeardown && signal === "SIGTERM" && !emittedExit) {
        emittedExit = true;
        queueMicrotask(() => child.exit());
      }
      if (signal === "SIGKILL") {
        processGroupAlive = false;
      }
      if (signal === 0 && !processGroupAlive) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });
    const stopped = child.stop({ killGraceMs: 50, teardownGraceMs: 1 });
    if (exitedBeforeTeardown) {
      queueMicrotask(() => child.exit());
    }
    await expect(stopped).resolves.toEqual({ exitedBeforeTeardown, exitCode: 0, signal: null });
    expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    expect(processKill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
    expectReleased(child, 0);
  },
);
