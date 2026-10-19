import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTypingKeepaliveLoop } from "./typing-lifecycle.js";

it("keeps a pending provider tick exclusive across stop and restart", async () => {
  vi.useFakeTimers();
  const pending = createDeferred();
  const onTick = vi
    .fn<() => Promise<void>>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(undefined);
  const loop = createTypingKeepaliveLoop({ intervalMs: 100, onTick });
  try {
    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(onTick).toHaveBeenCalledTimes(1);

    loop.stop();
    loop.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(onTick).toHaveBeenCalledTimes(1);

    pending.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(onTick).toHaveBeenCalledTimes(2);
  } finally {
    pending.resolve();
    loop.stop();
    await pending.promise;
    vi.useRealTimers();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("reports a rejected keepalive tick instead of leaking an unhandled rejection", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  let calls = 0;
  // A plain closure: a vi.fn() wrapper can absorb the rejection.
  const onTick = async () => {
    calls += 1;
    throw new Error("provider down");
  };
  const loop = createTypingKeepaliveLoop({ intervalMs: 5, onTick });
  try {
    loop.start();
    await vi.advanceTimersByTimeAsync(20);
    vi.useRealTimers();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(unhandled).toEqual([]);
    expect(calls).toBeGreaterThan(1);
    expect(warn).toHaveBeenCalledWith("[typing] keepalive tick failed: provider down");
  } finally {
    loop.stop();
    process.off("unhandledRejection", onUnhandled);
    vi.useRealTimers();
  }
});

it("still rejects an explicit tick() call", async () => {
  const loop = createTypingKeepaliveLoop({
    intervalMs: 0,
    onTick: async () => {
      throw new Error("provider down");
    },
  });
  await expect(loop.tick()).rejects.toThrow("provider down");
});
