import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArmableStallWatchdog } from "./stall-watchdog.js";

let onTimeout = vi.fn();
let watchdog: ReturnType<typeof createArmableStallWatchdog>;
function setup(options: Partial<Parameters<typeof createArmableStallWatchdog>[0]> = {}) {
  watchdog = createArmableStallWatchdog({
    label: "test-watchdog",
    timeoutMs: 1_000,
    checkIntervalMs: 100,
    onTimeout,
    ...options,
  });
}
describe("createArmableStallWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    onTimeout = vi.fn();
  });
  afterEach(() => {
    watchdog?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not fire when disarmed before timeout", async () => {
    setup();
    watchdog.arm();
    await vi.advanceTimersByTimeAsync(500);
    watchdog.disarm();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("extends timeout window when touched", async () => {
    setup();
    watchdog.arm();
    await vi.advanceTimersByTimeAsync(700);
    watchdog.touch();
    await vi.advanceTimersByTimeAsync(700);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("contains rejected timeout handlers and host reporter failures", async () => {
    onTimeout = vi.fn(() => Promise.reject(new Error("async owner failed")));
    setup({
      runtime: {
        log: vi.fn(),
        error() {
          throw new Error("reporter failed");
        },
        exit: vi.fn(),
      },
    });
    watchdog.arm();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(watchdog.isArmed()).toBe(false);
  });

  it("caps oversized timeout and check interval values before scheduling", async () => {
    vi.setSystemTime(0);
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    setup({
      timeoutMs: Number.MAX_SAFE_INTEGER,
      checkIntervalMs: Number.MAX_SAFE_INTEGER,
    });
    watchdog.arm(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
});
