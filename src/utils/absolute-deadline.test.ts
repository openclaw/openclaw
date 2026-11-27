import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  ABSOLUTE_DEADLINE_EXPIRED,
  awaitWithinDeadline,
  scheduleAbsoluteDeadline,
} from "./absolute-deadline.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

it("re-arms a 30-day deadline after the maximum Node timer delay", async () => {
  const deadline = 30 * 24 * 60 * 60_000;
  const expired = vi.fn();
  scheduleAbsoluteDeadline(deadline, expired);

  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(deadline - 2_147_483_647 - 1);
  expect(expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(expired).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  [59.5, "in time"],
  [60, ABSOLUTE_DEADLINE_EXPIRED],
] as const)(
  "uses the selected clock at elapsed=%s when wall time changes",
  async (settledAt, expected) => {
    let elapsed = 50;
    const operation = createDeferred<string>();
    const result = awaitWithinDeadline(
      () => operation.promise,
      60,
      () => elapsed,
    );

    vi.setSystemTime(10_000);
    elapsed = settledAt;
    operation.resolve("in time");

    await expect(result).resolves.toBe(expected);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("retains wall-clock settlement when no clock is selected", async () => {
  const operation = createDeferred<string>();
  const result = awaitWithinDeadline(() => operation.promise, 100);

  vi.setSystemTime(1_000);
  operation.resolve("late");

  await expect(result).resolves.toBe(ABSOLUTE_DEADLINE_EXPIRED);
  expect(vi.getTimerCount()).toBe(0);
});

it("releases the deadline timer when the operation rejects", async () => {
  const operation = createDeferred<string>();
  const result = awaitWithinDeadline(() => operation.promise, 100);
  operation.reject(new Error("operation failed"));

  await expect(result).rejects.toThrow("operation failed");
  expect(vi.getTimerCount()).toBe(0);
});
