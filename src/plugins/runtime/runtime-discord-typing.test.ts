import { afterEach, describe, vi } from "vitest";
import {
  createDiscordTypingLease,
  type CreateDiscordTypingLeaseParams,
} from "./runtime-discord-typing.js";
import { registerSharedTypingLeaseTests } from "./typing-lease.test-support.js";

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

  registerSharedTypingLeaseTests({
    createLease: createDiscordTypingLease,
    buildParams: buildDiscordTypingParams,
  });
});
