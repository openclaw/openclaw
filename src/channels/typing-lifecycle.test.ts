// Typing keepalive loop tests cover interval timing and error containment.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTypingKeepaliveLoop } from "./typing-lifecycle.js";

describe("createTypingKeepaliveLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onTick on each interval", async () => {
    const onTick = vi.fn().mockResolvedValue(undefined);
    const loop = createTypingKeepaliveLoop({ intervalMs: 1_000, onTick });

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("suppresses tick overlap when a previous tick is still in flight", async () => {
    let resolveTick: (() => void) | undefined;
    const onTick = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        }),
    );
    const loop = createTypingKeepaliveLoop({ intervalMs: 1_000, onTick });

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).toHaveBeenCalledTimes(1);

    // Fire several intervals while the first tick is still pending.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onTick).toHaveBeenCalledTimes(1);

    resolveTick?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("reports tick errors through onError without leaking an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const error = new Error("typing tick failed");
    const onTick = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const loop = createTypingKeepaliveLoop({ intervalMs: 1_000, onTick, onError });

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
    expect(unhandled).toHaveLength(0);

    loop.stop();
    process.off("unhandledRejection", onUnhandled);
  });
});
