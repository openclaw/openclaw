import { expect, it, vi } from "vitest";
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
