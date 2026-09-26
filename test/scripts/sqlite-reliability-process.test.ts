import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForReliabilityWorkerMessage } from "../../scripts/lib/sqlite-reliability-process.js";
import { waitForWriterMessage } from "../../scripts/lib/sqlite-reliability-writer.js";

function waitForReady(
  child: ChildProcess,
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

function expectWaitCleanedUp(child: ChildProcess) {
  for (const event of ["message", "error", "exit"]) {
    expect(child.listenerCount(event)).toBe(0);
  }
  expect(vi.getTimerCount()).toBe(0);
}

describe("SQLite reliability worker messages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("listens before sending, ignores other messages, and preserves other listeners", async () => {
    const child = new ChildProcess();
    const observed: unknown[] = [];
    const observe = (message: unknown) => observed.push(message);
    child.on("message", observe);
    const ready = waitForReady(child, {
      action: () => {
        child.emit("message", "unrelated");
        expect(child.listenerCount("message")).toBe(2);
        child.emit("message", "ready");
      },
    });

    await expect(ready).resolves.toBe("ready");
    expect(observed).toEqual(["unrelated", "ready"]);
    expect(child.listeners("message")).toEqual([observe]);
    child.off("message", observe);
    expectWaitCleanedUp(child);
  });

  it("rejects child errors without replacing the original error", async () => {
    const child = new ChildProcess();
    const error = new Error("IPC failed");
    const ready = waitForReady(child);
    child.emit("error", error);

    await expect(ready).rejects.toBe(error);
    expectWaitCleanedUp(child);
  });

  it("formats premature exit diagnostics when the child exits", async () => {
    const child = new ChildProcess();
    let stderr = "before";
    const ready = waitForReady(child, {
      exitMessage: (code, signal) => `exit ${code}/${signal}: ${stderr}`,
    });
    stderr = "last stderr";
    child.emit("exit", null, "SIGKILL");

    await expect(ready).rejects.toThrow("exit null/SIGKILL: last stderr");
    expectWaitCleanedUp(child);
  });

  it.each([30_000, 120_000])(
    "honors a %i ms timeout and reads final diagnostics",
    async (timeoutMs) => {
      const child = new ChildProcess();
      let stderr = "before";
      const ready = waitForReady(child, {
        timeoutMs,
        timeoutMessage: () => `timeout: ${stderr}`,
      });
      const rejected = expect(ready).rejects.toThrow("timeout: last stderr");
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(child.listenerCount("message")).toBe(1);
      stderr = "last stderr";
      await vi.advanceTimersByTimeAsync(1);

      await rejected;
      expectWaitCleanedUp(child);
    },
  );

  it.each(["action", "matches"] as const)("cleans up when %s throws", async (source) => {
    const child = new ChildProcess();
    const error = new Error(`${source} failed`);
    const ready = waitForReady(child, {
      action: () => {
        if (source === "action") {
          throw error;
        }
        child.emit("message", "ready");
      },
      matches: () => {
        throw error;
      },
    });

    await expect(ready).rejects.toBe(error);
    expectWaitCleanedUp(child);
  });

  it("rejects a writer error payload instead of waiting for the requested message", async () => {
    const child = new ChildProcess();
    const result = waitForWriterMessage({ child, stderr: [], stopped: false }, "result");
    child.emit("message", { kind: "error", error: "write failed" });

    await expect(result).rejects.toThrow("SQLite reliability writer failed: write failed");
    expectWaitCleanedUp(child);
  });

  it("returns the requested writer payload from a synchronous action reply", async () => {
    const child = new ChildProcess();
    const result = await waitForWriterMessage(
      { child, stderr: [], stopped: false },
      "result",
      () => {
        child.emit("message", { kind: "ready" });
        child.emit("message", { kind: "result", batchesCommitted: 2, rowsCommitted: 16 });
      },
    );

    expect(result.batchesCommitted).toBe(2);
    expect(result.rowsCommitted).toBe(16);
    expectWaitCleanedUp(child);
  });
});
