import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordTypingLease,
  type CreateDiscordTypingLeaseParams,
} from "./runtime-discord-typing.js";

describe("createDiscordTypingLease", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the Discord default interval and forwards pulse params", async () => {
    vi.useFakeTimers();
    const pulse: CreateDiscordTypingLeaseParams["pulse"] = vi.fn(async () => undefined);
    const cfg = { channels: { discord: { token: "x" } } };

    const lease = await createDiscordTypingLease({
      channelId: "123",
      accountId: "work",
      cfg,
      intervalMs: Number.NaN,
      pulse,
    });

    expect(pulse).toHaveBeenCalledTimes(1);
    expect(pulse).toHaveBeenCalledWith({
      channelId: "123",
      accountId: "work",
      cfg,
    });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(pulse).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pulse).toHaveBeenCalledTimes(2);

    lease.stop();
  });
});
