import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../types.js";
import { isRetryableAssistantError, resolveAutoRetryDelayMs } from "./retry.js";

function errorMessage(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: 1,
  };
}

describe("isRetryableAssistantError", () => {
  it.each([
    "An error occurred while processing your request. You can retry your request.",
    "The system encountered an unexpected error. Try your request again.",
    "Temporary provider failure; please retry your request.",
  ])("accepts explicit retry guidance: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(true);
  });

  it("keeps concrete quota failures non-retryable", () => {
    expect(isRetryableAssistantError(errorMessage("429 insufficient_quota"))).toBe(false);
    expect(isRetryableAssistantError(errorMessage("Monthly usage limit reached"))).toBe(false);
  });

  it("retries transient billing-service failures", () => {
    expect(
      isRetryableAssistantError(
        errorMessage("503 billing service unavailable; please retry your request"),
      ),
    ).toBe(true);
  });

  it("retries short-window quota exhaustion", () => {
    expect(
      isRetryableAssistantError(
        errorMessage(
          "429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric requests per minute; please retry your request",
        ),
      ),
    ).toBe(true);
  });
});

describe("resolveAutoRetryDelayMs", () => {
  it("uses Retry-After as a lower bound when it exceeds exponential backoff", () => {
    expect(
      resolveAutoRetryDelayMs({
        attempt: 1,
        baseDelayMs: 2000,
        retryAfterSeconds: 30,
        maxRetryDelayMs: 60_000,
      }),
    ).toEqual({ action: "delay", delayMs: 30_000 });
  });

  it("keeps exponential backoff when Retry-After is shorter", () => {
    expect(
      resolveAutoRetryDelayMs({
        attempt: 3,
        baseDelayMs: 2000,
        retryAfterSeconds: 1,
        maxRetryDelayMs: 60_000,
      }),
    ).toEqual({ action: "delay", delayMs: 8000 });
  });

  it("declines auto-retry when Retry-After exceeds a positive max", () => {
    expect(
      resolveAutoRetryDelayMs({
        attempt: 1,
        baseDelayMs: 2000,
        retryAfterSeconds: 3600,
        maxRetryDelayMs: 60_000,
      }),
    ).toEqual({
      action: "no_auto_retry",
      reason: "retry_after_exceeds_max",
      retryAfterMs: 3_600_000,
      maxRetryDelayMs: 60_000,
    });
  });

  it("honors cooldowns within a raised positive max", () => {
    expect(
      resolveAutoRetryDelayMs({
        attempt: 1,
        baseDelayMs: 2000,
        retryAfterSeconds: 90,
        maxRetryDelayMs: 120_000,
      }),
    ).toEqual({ action: "delay", delayMs: 90_000 });
  });

  it("treats maxRetryDelayMs 0 as unlimited and honors full Retry-After", () => {
    expect(
      resolveAutoRetryDelayMs({
        attempt: 1,
        baseDelayMs: 2000,
        retryAfterSeconds: 3600,
        maxRetryDelayMs: 0,
      }),
    ).toEqual({ action: "delay", delayMs: 3_600_000 });
  });

  it("uses exponential only when Retry-After is absent", () => {
    expect(
      resolveAutoRetryDelayMs({
        attempt: 2,
        baseDelayMs: 2000,
        maxRetryDelayMs: 60_000,
      }),
    ).toEqual({ action: "delay", delayMs: 4000 });
  });
});
