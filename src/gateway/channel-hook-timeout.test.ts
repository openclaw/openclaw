import { afterEach, describe, expect, it, vi } from "vitest";
import {
  raceChannelHookWithTimeout,
  runChannelHookTasksWithTimeout,
} from "./channel-hook-timeout.js";

describe("raceChannelHookWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns hook values", async () => {
    await expect(
      raceChannelHookWithTimeout({ timeoutMs: 50, run: async () => "ok" }),
    ).resolves.toEqual({ kind: "value", value: "ok" });
  });

  it("returns hook failures without rejecting", async () => {
    const error = new Error("probe failed");

    await expect(
      raceChannelHookWithTimeout({
        timeoutMs: 50,
        run: async () => {
          throw error;
        },
      }),
    ).resolves.toEqual({ kind: "error", error });
  });

  it("host-bounds a hook that ignores its timeout hint", async () => {
    await expect(
      raceChannelHookWithTimeout({
        timeoutMs: 10,
        run: async () =>
          await new Promise<never>(() => {
            // Simulate a plugin hook that never settles.
          }),
      }),
    ).resolves.toEqual({ kind: "timeout" });
  });

  it("retains timed-out capacity and skips queued channel work", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    let started = 0;
    const tasks = Array.from({ length: 6 }, () => async () => {
      started += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return started;
    });

    const run = runChannelHookTasksWithTimeout({
      capacityKey: "test:retained-capacity",
      limit: 5,
      timeoutMs: 100,
      tasks,
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(run).resolves.toEqual([
      { kind: "timeout", started: true },
      { kind: "timeout", started: true },
      { kind: "timeout", started: true },
      { kind: "timeout", started: true },
      { kind: "timeout", started: true },
      { kind: "timeout", started: false },
    ]);
    expect(started).toBe(5);

    releases[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(5);
    for (const release of releases.slice(1)) {
      release();
    }
    await vi.advanceTimersByTimeAsync(0);
  });
});
