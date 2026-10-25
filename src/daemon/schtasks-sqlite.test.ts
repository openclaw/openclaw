import { afterEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { retryScheduledTaskLeaseRead } from "./schtasks-sqlite.js";

// Windows scheduler tasks share SQLite with a sibling process unmapping shared
// memory; these reads retry for a short budget rather than failing transiently.
const transientError = () => {
  const error = new Error("IOERR_TRUNCATE") as Error & { errcode?: number };
  error.errcode = 1546;
  return error;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps the lease-read retry deadline on the monotonic clock across a forward wall-clock jump", async () => {
  mockProcessPlatform("win32");
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });

  let calls = 0;
  const result = retryScheduledTaskLeaseRead(() => {
    calls += 1;
    if (calls <= 2) {
      throw transientError();
    }
    return "lease";
  });

  // Two transient failures would normally retry. Jump only the wall clock so a
  // wall-clock deadline would wrongly expire between the first failure and the
  // retry, discarding a healthy lease that is still within budget.
  vi.setSystemTime(Date.now() + 20_000);
  for (let i = 0; i < 6; i += 1) {
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
  }

  await expect(result).resolves.toBe("lease");
  expect(calls).toBe(3);
});

it("keeps the lease-read retry deadline on the monotonic clock across a backward wall-clock jump (budget not inflated)", async () => {
  mockProcessPlatform("win32");
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });

  // A reader that keeps throwing forces the loop to exhaust its budget. With a
  // wall-clock deadline (Date.now), jumping the clock backward makes the
  // deadline further away, so the loop would keep retrying well past 15s of
  // elapsed time. With the monotonic deadline (performance.now) the budget is
  // consumed at ~15s regardless of the wall-clock jump.
  let rejected = false;
  const result = retryScheduledTaskLeaseRead(() => {
    throw transientError();
  }).then(
    () => {
      throw new Error("expected retryScheduledTaskLeaseRead to exhaust its budget");
    },
    () => {
      rejected = true;
    },
  );

  vi.setSystemTime(Date.now() - 20_000);
  let elapsedMs = 0;
  for (let i = 0; i < 350; i += 1) {
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    elapsedMs += 100;
    if (rejected) {
      break;
    }
  }

  await result;
  expect(rejected).toBe(true);
  // The budget is consumed at ~15s of monotonic time, not inflated to ~35s by
  // the 20s backward wall-clock jump.
  expect(elapsedMs).toBeGreaterThan(14_000);
  expect(elapsedMs).toBeLessThan(16_500);
});
