import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { retryScheduledTaskLeaseRead } from "./schtasks-sqlite.js";

const transientError = () => Object.assign(new Error("IOERR_TRUNCATE"), { errcode: 1546 });

beforeEach(() => {
  mockProcessPlatform("win32");
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("recovers a lease within the retry budget after a forward wall-clock step", async () => {
  const read = vi
    .fn()
    .mockImplementationOnce(() => {
      throw transientError();
    })
    .mockImplementationOnce(() => {
      throw transientError();
    })
    .mockReturnValue("lease");
  const settled = vi.fn();
  const result = retryScheduledTaskLeaseRead(read).then(settled, settled);
  vi.setSystemTime(Date.now() + 20_000);
  await vi.advanceTimersByTimeAsync(200);
  await result;
  expect(settled).toHaveBeenCalledExactlyOnceWith("lease");
  expect(read).toHaveBeenCalledTimes(3);
});

it("exhausts the retry budget after a backward wall-clock step", async () => {
  const error = transientError();
  const rejected = vi.fn();
  const result = retryScheduledTaskLeaseRead(() => {
    throw error;
  }).catch(rejected);
  try {
    await vi.advanceTimersByTimeAsync(100);
    vi.setSystemTime(Date.now() - 20_000);
    await vi.advanceTimersByTimeAsync(14_800);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(rejected).toHaveBeenCalledExactlyOnceWith(error);
  } finally {
    await vi.advanceTimersByTimeAsync(20_000);
    await result;
  }
});
