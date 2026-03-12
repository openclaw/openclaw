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
});
