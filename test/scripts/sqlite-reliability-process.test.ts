import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForReliabilityWorkerMessage } from "../../scripts/lib/sqlite-reliability-process.js";
import { waitForWriterMessage } from "../../scripts/lib/sqlite-reliability-writer.js";

let child: ChildProcess;
function waitForReady(
  overrides: Partial<Parameters<typeof waitForReliabilityWorkerMessage>[0]> = {},
) {
  return waitForReliabilityWorkerMessage({
    child,
    matches: (message) => message === "ready",
    timeoutMs: 30_000,
    timeoutMessage: () => "worker timed out",
    exitMessage: (code, signal) => `worker exited: ${code}/${signal}`,
    ...overrides,
  });
}

describe("SQLite reliability worker messages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    child = new ChildProcess();
  });
  afterEach(() => {
    const timers = vi.getTimerCount();
    vi.useRealTimers();
    expect(["message", "error", "exit"].map((event) => child.listenerCount(event))).toEqual([
      0, 0, 0,
    ]);
    expect(timers).toBe(0);
  });

  it.each(["exit", "timeout"])("reads final diagnostics on %s", async (event) => {
    const timeoutMs = 120_000;
    let stderr = "before";
    const ready = waitForReady({
      timeoutMs,
      timeoutMessage: () => `timeout: ${stderr}`,
      exitMessage: (code, signal) => `exit ${code}/${signal}: ${stderr}`,
    });
    const prefix = event === "exit" ? "exit null/SIGKILL" : "timeout";
    const rejected = expect(ready).rejects.toThrow(`${prefix}: last stderr`);
    if (event === "timeout") {
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(child.listenerCount("message")).toBe(1);
    }
    stderr = "last stderr";
    if (event === "exit") {
      child.emit("exit", null, "SIGKILL");
    } else {
      await vi.advanceTimersByTimeAsync(1);
    }
    await rejected;
  });

  it("cleans up when action throws", async () => {
    const error = new Error("action failed");
    const ready = waitForReady({
      action: () => {
        throw error;
      },
    });

    await expect(ready).rejects.toBe(error);
  });

  it("rejects a writer error payload instead of waiting for the requested message", async () => {
    const result = waitForWriterMessage({ child, stderr: [], stopped: false }, "result");
    child.emit("message", { kind: "error", error: "write failed" });

    await expect(result).rejects.toThrow("SQLite reliability writer failed: write failed");
  });

  it("waits for the synchronous writer reply while preserving other listeners", async () => {
    const observed: unknown[] = [];
    const observe = (message: unknown) => observed.push(message);
    child.on("message", observe);
    const payload = { kind: "result", batchesCommitted: 2, rowsCommitted: 16 };
    const result = await waitForWriterMessage(
      { child, stderr: [], stopped: false },
      "result",
      () => {
        child.emit("message", { kind: "ready" });
        expect(child.listenerCount("message")).toBe(2);
        child.emit("message", payload);
      },
    );

    expect(result).toBe(payload);
    expect(observed).toEqual([{ kind: "ready" }, payload]);
    expect(child.listeners("message")).toEqual([observe]);
    child.off("message", observe);
  });
});
