import { describe, expect, it, vi } from "vitest";
import { raceTimeout, SUBSYSTEM_STOP_TIMEOUT_MS } from "./shutdown-timeout.js";

describe("raceTimeout", () => {
  it("resolves immediately when the promise completes before the deadline", async () => {
    let resolved = false;
    await raceTimeout(
      (async () => {
        resolved = true;
      })(),
      1_000,
      "fast-op",
    );
    expect(resolved).toBe(true);
  });

  it("resolves after the timeout when the promise hangs", async () => {
    vi.useFakeTimers();

    const warn = vi.fn();
    const hang = new Promise<void>(() => {}); // never resolves
    const done = raceTimeout(hang, 5_000, "hung-op", { warn });

    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ subsystem: "hung-op", timeoutMs: 5_000 }),
      expect.stringContaining("did not stop within 5000ms"),
    );

    vi.useRealTimers();
  });

  it("does not log when the promise settles within the deadline", async () => {
    const warn = vi.fn();
    await raceTimeout(Promise.resolve(), 5_000, "ok-op", { warn });

    expect(warn).not.toHaveBeenCalled();
  });

  it("clears the timer after the promise resolves (no leaked timers)", async () => {
    vi.useFakeTimers();

    const warn = vi.fn();
    await raceTimeout(Promise.resolve(), 5_000, "no-leak", { warn });

    // Advance well past the deadline — the warn callback must NOT fire
    // because the timer was cleared when the promise resolved.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(warn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("propagates rejections from the promise (timeout does not swallow errors)", async () => {
    await expect(
      raceTimeout(Promise.reject(new Error("subsystem crash")), 5_000, "crash-op"),
    ).rejects.toThrow("subsystem crash");
  });

  it("exports SUBSYSTEM_STOP_TIMEOUT_MS as 5000", () => {
    expect(SUBSYSTEM_STOP_TIMEOUT_MS).toBe(5_000);
  });
});
