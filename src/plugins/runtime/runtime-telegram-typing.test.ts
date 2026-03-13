import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramTypingLease } from "./runtime-telegram-typing.js";

describe("createTelegramTypingLease", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pulses immediately and keeps leases independent", async () => {
    vi.useFakeTimers();
    const pulse = vi.fn(async () => undefined);

    const leaseA = await createTelegramTypingLease({
      to: "telegram:123",
      intervalMs: 2_000,
      pulse,
    });
    const leaseB = await createTelegramTypingLease({
      to: "telegram:123",
      intervalMs: 2_000,
      pulse,
    });

    expect(pulse).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(pulse).toHaveBeenCalledTimes(4);

    leaseA.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pulse).toHaveBeenCalledTimes(5);

    await leaseB.refresh();
    expect(pulse).toHaveBeenCalledTimes(6);

    leaseB.stop();
  });

  it("swallows background pulse failures", async () => {
    vi.useFakeTimers();
    const pulse = vi
      .fn<
        (params: {
          to: string;
          accountId?: string;
          cfg?: unknown;
          messageThreadId?: number;
        }) => Promise<unknown>
      >()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));

    const lease = await createTelegramTypingLease({
      to: "telegram:123",
      intervalMs: 2_000,
      pulse,
    });

    await expect(vi.advanceTimersByTimeAsync(2_000)).resolves.toBe(vi);
    expect(pulse).toHaveBeenCalledTimes(2);

    lease.stop();
  });

  it("falls back to the default interval for non-finite values", async () => {
    vi.useFakeTimers();
    const pulse = vi.fn(async () => undefined);

    const lease = await createTelegramTypingLease({
      to: "telegram:123",
      intervalMs: Number.NaN,
      pulse,
    });

    expect(pulse).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(pulse).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pulse).toHaveBeenCalledTimes(2);

    lease.stop();
  });
});
