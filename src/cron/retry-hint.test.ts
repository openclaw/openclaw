// Retry hint tests cover user-facing guidance for failed cron retry timing.
import { describe, expect, it } from "vitest";
import { resolveCronExecutionRetryHint } from "./retry-hint.js";
import {
  preExecutionTimeoutErrorMessage,
  setupTimeoutErrorMessage,
} from "./service/execution-errors.js";

describe("resolveCronExecutionRetryHint", () => {
  it("does not let transient error text override a permanent provider classification", () => {
    expect(
      resolveCronExecutionRetryHint({
        error: "HTTP 429: all available credits have been exhausted",
        classifiedReason: "billing",
      }),
    ).toEqual({ retryable: false });
  });

  it("classifies cron pre-execution watchdog failures as timeout retries", () => {
    for (const message of [setupTimeoutErrorMessage(), preExecutionTimeoutErrorMessage()]) {
      expect(resolveCronExecutionRetryHint({ error: message, retryOn: ["timeout"] })).toEqual({
        retryable: true,
        category: "timeout",
      });
    }
  });

  it("does not classify incidental 529 numbers as provider overload", () => {
    for (const message of [
      "529 lines of output",
      "529 files missing",
      "529 workers failed",
      "context limit 529 exceeded",
      "process exited with 529 lines of output",
      "assertion failed: expected 529 got 0",
      "process exited with code 529",
      "killed worker pid 529 after deadline",
      "ENOENT: no such file '/var/run/app-529.sock'",
      "API error: 5291",
      "HTTP/2 5291",
    ]) {
      expect(resolveCronExecutionRetryHint({ error: message, retryOn: ["overloaded"] })).toEqual({
        retryable: false,
      });
      expect(resolveCronExecutionRetryHint({ error: message })).toEqual({ retryable: false });
    }
  });

  it("classifies session lifecycle claim conflicts as transient regardless of retryOn (#106875)", () => {
    for (const message of [
      'CronSessionLifecycleClaimError: Session "agent:main:cron:job-1" changed while starting work. Retry.',
      'Error: Session "agent:main:cron:job-1" changed while starting work. Retry.',
      'Error: Session "agent:main:cron:job-1" was deleted while starting work. Retry.',
    ]) {
      expect(resolveCronExecutionRetryHint({ error: message, retryOn: ["network"] })).toEqual({
        retryable: true,
      });
    }
  });

  it("does not retry lifecycle claim conflicts after execution starts (#108428)", () => {
    expect(
      resolveCronExecutionRetryHint({
        error:
          'CronSessionLifecycleClaimError: Session "agent:main:cron:job-1" changed while starting work. Retry.',
        retryOn: ["network"],
        executionStarted: true,
      }),
    ).toEqual({ retryable: false });
  });
});
