import { afterEach, describe, it, vi } from "vitest";
import {
  createDiscordTypingLease,
  type CreateDiscordTypingLeaseParams,
} from "./runtime-discord-typing.js";
import {
  createPulseWithBackgroundFailure,
  expectBackgroundTypingPulseFailuresAreSwallowed,
  expectIndependentTypingLeases,
} from "./typing-lease.test-support.js";

const DISCORD_TYPING_INTERVAL_MS = 2_000;

function buildDiscordTypingParams(
  pulse: CreateDiscordTypingLeaseParams["pulse"],
): CreateDiscordTypingLeaseParams {
  return {
    channelId: "123",
    intervalMs: DISCORD_TYPING_INTERVAL_MS,
    pulse,
  };
}

describe("createDiscordTypingLease", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pulses immediately and keeps leases independent", async () => {
    await expectIndependentTypingLeases({
      createLease: createDiscordTypingLease,
      buildParams: buildDiscordTypingParams,
    });
  });

  it("swallows background pulse failures", async () => {
    const pulse =
      createPulseWithBackgroundFailure<
        (params: { channelId: string; accountId?: string; cfg?: unknown }) => Promise<void>
      >();

    await expectBackgroundTypingPulseFailuresAreSwallowed({
      createLease: createDiscordTypingLease,
      pulse,
      buildParams: buildDiscordTypingParams,
    });
  });
});
