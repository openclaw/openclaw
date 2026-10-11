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
  expectedValue?: unknown;
  expectedError?: string;
}): Promise<void> {
  vi.useFakeTimers();
  const runner = createChannelApiRetryRunner(params.runnerOptions);
  const fn = params.expectedError
    ? vi.fn().mockRejectedValue(params.error)
    : vi.fn().mockRejectedValueOnce(params.error).mockResolvedValueOnce(params.expectedValue);
  const promise = runner(fn, "test");
  const assertion = params.expectedError
    ? expect(promise).rejects.toThrow(params.expectedError)
    : expect(promise).resolves.toBe(params.expectedValue);
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
    {
      name: "falls back to regex matching when strictShouldRetry is disabled",
      runnerOptions: { retry: { ...ZERO_DELAY_RETRY, attempts: 2 }, shouldRetry: () => false },
      error: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      expectedCalls: 2,
      expectedError: "ECONNRESET",
    },
    {
      name: "suppresses regex fallback when strictShouldRetry is enabled",
      runnerOptions: {
        retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
        shouldRetry: () => false,
        strictShouldRetry: true,
      },
      error: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      expectedCalls: 1,
      expectedError: "ECONNRESET",
    },
    {
      name: "still retries when the strict predicate returns true",
      runnerOptions: {
        retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
        shouldRetry: (err: unknown) => (err as { code?: string }).code === "ECONNREFUSED",
        strictShouldRetry: true,
      },
      error: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
      expectedCalls: 2,
      expectedValue: "ok",
    },
    {
      name: "does not retry unrelated errors when neither predicate nor regex match",
      runnerOptions: { retry: { ...ZERO_DELAY_RETRY, attempts: 2 } },
      error: Object.assign(new Error("permission denied"), { code: "EACCES" }),
      expectedCalls: 1,
      expectedError: "permission denied",
    },
    {
      name: "retries grammY HttpError wrapping network error via .cause traversal",
      runnerOptions: { retry: { ...ZERO_DELAY_RETRY, attempts: 2 } },
      error: Object.assign(new Error("Network request for 'sendMessage' failed!"), {
        cause: new Error("ECONNRESET"),
      }),
      expectedCalls: 2,
      expectedError: "Network request",
    },
    {
      name: "keeps retrying retriable errors until attempts are exhausted",
      runnerOptions: { retry: ZERO_DELAY_RETRY },
      error: Object.assign(new Error("connection timeout"), { code: "ETIMEDOUT" }),
      expectedCalls: 3,
      expectedError: "connection timeout",
    },
    {
      name: "retries misdirected request errors from Telegram edge nodes",
      runnerOptions: { retry: ZERO_DELAY_RETRY },
      error: Object.assign(new Error("421 Misdirected Request"), { status: 421 }),
      expectedCalls: 3,
      expectedError: "421 Misdirected Request",
    },
  ])("$name", runRetryCase);

  it("honors nested retry_after hints before retrying", async () => {
    await expectRetryDelay(
      { retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1_000, jitter: 0 } },
      { message: "429 Too Many Requests", response: { parameters: { retry_after: 1 } } },
      1_000,
    );
  });

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

  it("keeps retry_after hints capped by maxDelayMs by default", async () => {
    await expectRetryDelay(
      { retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 30_000, jitter: 0 } },
      { message: "429 Too Many Requests", response: { parameters: { retry_after: 45 } } },
      30_000,
    );
  });

  it("honors retry_after above maxDelayMs when a separate retry-after cap is configured", async () => {
    await expectRetryDelay(
      {
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 30_000, jitter: 0 },
        retryAfterMaxDelayMs: 60_000,
      },
      { message: "429 Too Many Requests", response: { parameters: { retry_after: 45 } } },
      45_000,
    );
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
