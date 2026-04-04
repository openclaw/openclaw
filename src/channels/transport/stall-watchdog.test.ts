import { describe, expect, it, vi } from "vitest";
import { createArmableStallWatchdog } from "./stall-watchdog.js";

function createTestWatchdog(
  onTimeout: Parameters<typeof createArmableStallWatchdog>[0]["onTimeout"],
) {
  return createArmableStallWatchdog({
    label: "test-watchdog",
    timeoutMs: 1_000,
    checkIntervalMs: 100,
    onTimeout,
  });
}

describe("createArmableStallWatchdog", () => {
  it("fires onTimeout once when armed and idle exceeds timeout", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createTestWatchdog(onTimeout);

      watchdog.arm();
      await vi.advanceTimersByTimeAsync(1_500);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      const [meta] = onTimeout.mock.calls[0] ?? [];
      expect(meta).toMatchObject({ timeoutMs: 1_000 });
      expect(meta?.idleMs).toBeGreaterThanOrEqual(1_000);
      expect(meta?.idleMs).toBeLessThan(1_100);
      expect(watchdog.isArmed()).toBe(false);
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire when disarmed before timeout", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createTestWatchdog(onTimeout);

      watchdog.arm();
      await vi.advanceTimersByTimeAsync(500);
      watchdog.disarm();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(onTimeout).not.toHaveBeenCalled();
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("extends timeout window when touched", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createTestWatchdog(onTimeout);

      watchdog.arm();
      await vi.advanceTimersByTimeAsync(700);
      watchdog.touch();
      await vi.advanceTimersByTimeAsync(700);
      expect(onTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
