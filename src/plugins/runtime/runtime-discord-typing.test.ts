import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordTypingLease } from "./runtime-discord-typing.js";

describe("createDiscordTypingLease", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pulses immediately and keeps leases independent", async () => {
    vi.useFakeTimers();
    const pulse = vi.fn(async () => undefined);

    const leaseA = await createDiscordTypingLease({
      channelId: "123",
      intervalMs: 2_000,
      pulse,
    });
    const leaseB = await createDiscordTypingLease({
      channelId: "123",
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
      .fn<(params: { channelId: string; accountId?: string; cfg?: unknown }) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));

    const lease = await createDiscordTypingLease({
      channelId: "123",
      intervalMs: 2_000,
      pulse,
    });

    await expect(vi.advanceTimersByTimeAsync(2_000)).resolves.toBe(vi);
    expect(pulse).toHaveBeenCalledTimes(2);

    lease.stop();
  });
});
