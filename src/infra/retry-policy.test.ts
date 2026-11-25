// Covers channel API retry policy behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRetryAfterHeaderSeconds } from "./retry-after.js";
import { createChannelApiRetryRunner } from "./retry-policy.js";

const ZERO_DELAY_RETRY = { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };
type RunnerOptions = Parameters<typeof createChannelApiRetryRunner>[0];

async function runRetryCase(params: {
  runnerOptions: RunnerOptions;
  error: unknown;
  expectedCalls: number;
}): Promise<void> {
  vi.useFakeTimers();
  const runner = createChannelApiRetryRunner(params.runnerOptions);
  const fn = vi.fn().mockRejectedValue(params.error);
  const assertion = expect(runner(fn, "test")).rejects.toBe(params.error);
  await vi.runAllTimersAsync();
  await assertion;
  expect(fn).toHaveBeenCalledTimes(params.expectedCalls);
}

async function expectRetryDelay(options: RunnerOptions, error: unknown, delayMs: number) {
  vi.useFakeTimers();
  const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("ok");
  const promise = createChannelApiRetryRunner(options)(fn, "test");
  expect(fn).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(delayMs - 1);
  expect(fn).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(promise).resolves.toBe("ok");
  expect(fn).toHaveBeenCalledTimes(2);
}

describe("createChannelApiRetryRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    [false, false, 2],
    [true, false, 1],
    [true, true, 2],
  ] as const)(
    "custom retry predicate (strict=%s, decision=%s)",
    (strictShouldRetry, decision, expectedCalls) =>
      runRetryCase({
        runnerOptions: {
          retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
          shouldRetry: () => decision,
          strictShouldRetry,
        },
        error: new Error("read ECONNRESET"),
        expectedCalls,
      }),
  );

  it.each([
    [new Error("permission denied"), 1],
    [new Error("Network request failed!", { cause: new Error("ECONNRESET") }), 3],
    [new Error("connection timeout"), 3],
    [new Error("421 Misdirected Request"), 3],
  ] as const)("classifies channel failure %s", (error, expectedCalls) =>
    runRetryCase({
      runnerOptions: { retry: ZERO_DELAY_RETRY },
      error,
      expectedCalls,
    }),
  );

  it.each(["STATE_DATABASE_READ_ADMISSION_INVALIDATED", undefined])(
    "keeps closed state admission terminal (%s)",
    (code) =>
      runRetryCase({
        runnerOptions: { retry: ZERO_DELAY_RETRY, shouldRetry: () => true },
        error: new Error("connection closed", {
          cause: {
            code,
            message:
              "Shared-state worker is retiring while its actor is in use; close its leases first",
          },
        }),
        expectedCalls: 1,
      }),
  );

  it.each([
    [1, 1_000, undefined, 1_000],
    [45, 30_000, undefined, 30_000],
    [45, 30_000, 60_000, 45_000],
  ] as const)(
    "honors nested retry_after=%s with delay cap=%s/%s",
    (seconds, maxDelayMs, retryAfterMaxDelayMs, delay) =>
      expectRetryDelay(
        { retry: { ...ZERO_DELAY_RETRY, maxDelayMs }, retryAfterMaxDelayMs },
        { message: "429 Too Many Requests", response: { parameters: { retry_after: seconds } } },
        delay,
      ),
  );

  it("uses an injected retry-after reader instead of the Telegram body default", async () => {
    const retryAfterMs = vi.fn(() => 250);
    const error = { message: "429 Too Many Requests", parameters: { retry_after: 1 } };
    await expectRetryDelay(
      { retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1_000, jitter: 0 }, retryAfterMs },
      error,
      250,
    );
    expect(retryAfterMs).toHaveBeenCalledWith(error);
  });
});

describe("parseRetryAfterHeaderSeconds", () => {
  it.each([
    ["delay seconds", " 15 ", Date.UTC(2026, 4, 1, 12, 0, 0), 15],
    ["HTTP date", "Fri, 01 May 2026 12:00:05 GMT", Date.UTC(2026, 4, 1, 12, 0, 0), 5],
    ["RFC 850 date", "Friday, 01-May-26 12:00:05 GMT", Date.UTC(2026, 4, 1, 12, 0, 0), 5],
    ["asctime date", "Fri May  1 12:00:05 2026", Date.UTC(2026, 4, 1, 12, 0, 0), 5],
    ["past HTTP date", "Fri, 01 May 2026 11:59:55 GMT", Date.UTC(2026, 4, 1, 12, 0, 0), 0],
  ])("parses $name", (_name, value, now, expected) => {
    expect(parseRetryAfterHeaderSeconds(value, now)).toBe(expected);
  });

  it.each([
    null,
    "",
    "1.5",
    "+1",
    "1 second",
    "9007199254741",
    "Sun Nov 99 99:99:99 9999",
    "Friday, 01 May 2026 12:00:05 GMT",
  ])("rejects invalid value %j", (value) => {
    expect(parseRetryAfterHeaderSeconds(value)).toBeUndefined();
  });
});
