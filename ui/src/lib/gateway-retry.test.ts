// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayRetryOwner } from "./gateway-retry.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("gateway retry owner", () => {
  it("backs off from 30 seconds and caps retries at five minutes", () => {
    vi.useFakeTimers();
    const owner = createGatewayRetryOwner();
    const retry = vi.fn();

    for (const delayMs of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      const completed = retry.mock.calls.length;
      owner.schedule(retry);
      vi.advanceTimersByTime(delayMs - 1);
      expect(retry).toHaveBeenCalledTimes(completed);
      vi.advanceTimersByTime(1);
      expect(retry).toHaveBeenCalledTimes(completed + 1);
    }
  });

  it("cancels stale timers without resetting the current backoff", () => {
    vi.useFakeTimers();
    const owner = createGatewayRetryOwner();
    const staleRetry = vi.fn();
    const currentRetry = vi.fn();

    owner.schedule(staleRetry);
    owner.cancel();
    expect(vi.getTimerCount()).toBe(0);

    owner.schedule(currentRetry);
    vi.advanceTimersByTime(59_999);
    expect(staleRetry).not.toHaveBeenCalled();
    expect(currentRetry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(currentRetry).toHaveBeenCalledOnce();
  });

  it("resets active timers and restarts the initial delay", () => {
    vi.useFakeTimers();
    const owner = createGatewayRetryOwner();
    const staleRetry = vi.fn();
    const currentRetry = vi.fn();

    owner.schedule(staleRetry);
    vi.advanceTimersByTime(10_000);
    owner.reset();
    expect(vi.getTimerCount()).toBe(0);

    owner.schedule(currentRetry);
    vi.advanceTimersByTime(29_999);
    expect(staleRetry).not.toHaveBeenCalled();
    expect(currentRetry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(currentRetry).toHaveBeenCalledOnce();
  });

  it("keeps the remaining backoff after a wall-clock jump during pause", () => {
    // Fake wall clock and timers only; performance.now stays real so a
    // monotonic deadline is independent of setSystemTime.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const owner = createGatewayRetryOwner();
    const retry = vi.fn();

    owner.schedule(retry);
    owner.pause();
    vi.setSystemTime(Date.now() + 3_600_000);
    owner.resume();
    vi.advanceTimersByTime(1);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(retry).toHaveBeenCalledOnce();
  });
});
