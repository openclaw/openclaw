import { afterEach, describe, it, vi } from "vitest";
import { createTelegramTypingLease } from "./runtime-telegram-typing.js";
import {
  createPulseWithBackgroundFailure,
  expectBackgroundTypingPulseFailuresAreSwallowed,
  expectIndependentTypingLeases,
  expectTypingPulseCount,
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

  it("pulses immediately and keeps leases independent", async () => {
    await expectIndependentTypingLeases({
      createLease: createTelegramTypingLease,
      buildParams: buildTelegramTypingParams,
    });
  });

  it("swallows background pulse failures", async () => {
    const pulse =
      createPulseWithBackgroundFailure<
        (params: {
          to: string;
          accountId?: string;
          cfg?: unknown;
          messageThreadId?: number;
        }) => Promise<unknown>
      >();

    await expectBackgroundTypingPulseFailuresAreSwallowed({
      createLease: createTelegramTypingLease,
      pulse,
      buildParams: buildTelegramTypingParams,
    });
  });

  it("falls back to the default interval for non-finite values", async () => {
    vi.useFakeTimers();
    const pulse = vi.fn(async () => undefined);

    const lease = await createTelegramTypingLease({
      to: "telegram:123",
      intervalMs: Number.NaN,
      pulse,
    });

    expectTypingPulseCount(pulse, 1);
    await vi.advanceTimersByTimeAsync(TELEGRAM_TYPING_DEFAULT_INTERVAL_MS - 1);
    expectTypingPulseCount(pulse, 1);
    await vi.advanceTimersByTimeAsync(1);
    expectTypingPulseCount(pulse, 2);

    lease.stop();
  });
});
