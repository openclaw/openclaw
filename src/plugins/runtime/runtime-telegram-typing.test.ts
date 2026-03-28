import { afterEach, describe, it, vi } from "vitest";
import { createTelegramTypingLease } from "./runtime-telegram-typing.js";
import {
  expectDefaultTypingLeaseInterval,
  registerSharedTypingLeaseTests,
} from "./typing-lease.test-support.js";

const TELEGRAM_TYPING_INTERVAL_MS = 2_000;
const TELEGRAM_TYPING_DEFAULT_INTERVAL_MS = 4_000;

function buildTelegramTypingParams(
  pulse: (params: {
    to: string;
    accountId?: string;
    cfg?: unknown;
    messageThreadId?: number;
  }) => Promise<unknown>,
) {
  return {
    to: "telegram:123",
    intervalMs: TELEGRAM_TYPING_INTERVAL_MS,
    pulse,
  };
}

describe("createTelegramTypingLease", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  registerSharedTypingLeaseTests({
    createLease: createTelegramTypingLease,
    buildParams: buildTelegramTypingParams,
  });

  it("falls back to the default interval for non-finite values", async () => {
    await expectDefaultTypingLeaseInterval({
      createLease: createTelegramTypingLease,
      buildParams: buildTelegramTypingParams,
      defaultIntervalMs: TELEGRAM_TYPING_DEFAULT_INTERVAL_MS,
    });
  });
});
