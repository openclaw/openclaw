import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";

const observer = vi.hoisted(() => ({
  heartbeat: new BigInt64Array(new SharedArrayBuffer(16)),
  write: vi.fn(),
  post: vi.fn(),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  writeSync: observer.write,
}));
vi.mock("node:worker_threads", async (original) => ({
  ...(await original<typeof import("node:worker_threads")>()),
  workerData: {
    heartbeat: observer.heartbeat.buffer,
    port: { postMessage() {} },
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
