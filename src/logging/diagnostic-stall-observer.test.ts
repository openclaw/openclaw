import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";

const observer = vi.hoisted(() => ({
  heartbeat: new BigInt64Array(new SharedArrayBuffer(24)),
  write: vi.fn(),
  post: vi.fn(),
  message: vi.fn(),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  writeSync: observer.write,
}));
vi.mock("node:worker_threads", async (original) => ({
  ...(await original<typeof import("node:worker_threads")>()),
  workerData: {
    heartbeat: observer.heartbeat.buffer,
    port: { postMessage: observer.message },
    packageRoot: null,
    timeOrigin: performance.timeOrigin,
  },
}));
vi.mock("node:inspector/promises", async (original) => ({
  ...(await original<typeof import("node:inspector/promises")>()),
  Session: class {
    connectToMainThread() {}
    disconnect() {}
    post = observer.post;
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([false, true, null])(
  "recovers a continuous five-minute stall (inspector=%s)",
  async (initialInspection) => {
    let inspecting = initialInspection;
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    observer.write.mockReset();
    observer.heartbeat[0] = 1_000n;
    observer.heartbeat[2] = 0n;
    observer.heartbeat[1] = process.versions.bun && inspecting ? 1n : 0n;
    observer.post.mockImplementation((_method: string, params: { expression: string }) =>
      inspecting !== null && params.expression.includes("inspector")
        ? Promise.resolve({ result: { value: inspecting } })
        : new Promise(() => {}),
    );
    await import("./diagnostic-stall-observer.worker.js");
    const tick = async (at: number) => {
      vi.advanceTimersByTime(at - Date.now());
      await vi.advanceTimersByTimeAsync(0);
    };
    await tick(300_750);
    expect(kill).not.toHaveBeenCalled();
    if (inspecting === false) {
      // A suspended observer cannot diagnose a main-thread wedge on laptop wake.
      vi.setSystemTime(Date.now() + 600_000);
      await tick(Date.now() + 250);
      expect(kill).not.toHaveBeenCalled();
    }
    // A completed turn resets the deadline; separate short stalls never accumulate.
    const resumedAt = Date.now();
    observer.heartbeat[0] = BigInt(resumedAt);
    await tick(resumedAt + 299_750);
    expect(kill).not.toHaveBeenCalled();
    await tick(resumedAt + 300_000);
    if (inspecting === null) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    if (inspecting) {
      expect(kill).not.toHaveBeenCalled();
      inspecting = false;
      observer.heartbeat[1] = 0n;
      await tick(Date.now() + 60_000);
    }
    expect(observer.write).toHaveBeenCalledWith(
      2,
      expect.stringContaining("main-thread stall recovery:"),
    );
    expect(observer.write.mock.invocationCallOrder.at(-1)).toBeLessThan(
      kill.mock.invocationCallOrder[0]!,
    );
    expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, "SIGKILL");
  },
);

it.skipIf(Boolean(process.versions.bun) || Number(process.versions.node.split(".")[0]) >= 26)(
  "bounds interrupted stacks and rejects captures dispatched after native work returns",
  async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    observer.heartbeat.set([1_000n, 0n, 3n]);
    observer.message.mockReset();
    let dispatchDelay = 101;
    observer.post.mockImplementation(() =>
      Promise.resolve({
        result: { value: { stacks: [{ at: Date.now() + dispatchDelay, frames: [] }] } },
      }),
    );
    await import("./diagnostic-stall-observer.worker.js");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observer.message).not.toHaveBeenCalled();
    expect(observer.heartbeat[2]).toBe(3n);
    dispatchDelay = 0;
    observer.heartbeat[0] = BigInt(Date.now());
    await vi.advanceTimersByTimeAsync(1_250);
    expect(observer.message).toHaveBeenCalledTimes(3);
    expect(observer.heartbeat[2]).toBe(0n);
    observer.heartbeat[0] = BigInt(Date.now());
    await vi.advanceTimersByTimeAsync(1_250);
    expect(observer.message).toHaveBeenCalledTimes(3);
  },
);
