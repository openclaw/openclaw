import { afterEach, describe, it, vi } from "vitest";
import { createDiscordTypingLease } from "./runtime-discord-typing.js";
import {
  expectBackgroundTypingPulseFailuresAreSwallowed,
  expectIndependentTypingLeases,
} from "./typing-lease.test-support.js";

describe("createDiscordTypingLease", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pulses immediately and keeps leases independent", async () => {
    await expectIndependentTypingLeases({
      createLease: createDiscordTypingLease,
      buildParams: (pulse) => ({
        channelId: "123",
        intervalMs: 2_000,
        pulse,
      }),
    });
  });

  it("swallows background pulse failures", async () => {
    const pulse = vi
      .fn<(params: { channelId: string; accountId?: string; cfg?: unknown }) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));

    await expectBackgroundTypingPulseFailuresAreSwallowed({
      createLease: createDiscordTypingLease,
      pulse,
      buildParams: (pulse) => ({
        channelId: "123",
        intervalMs: 2_000,
        pulse,
      }),
    });
  });
});
