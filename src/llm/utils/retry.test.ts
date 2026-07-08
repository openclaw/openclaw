import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../types.js";
import { isRetryableAssistantError } from "./retry.js";

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

  it.each([
    "model gpt-5.5-preview-0429 not found",
    "Image dimensions 1504x1504 exceed the maximum allowed size",
    "invalid api key sk-proj-abc502xyz",
  ])("does not retry permanent errors with incidental status digits: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(false);
  });

  it.each([
    "429 You exceeded your daily request limit. Please try again in 24 hours.",
    "rate limit reached for requests. Retry after 6h.",
  ])("does not retry long-window rate limits: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(false);
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

  it.each([
    "429 rate_limit_exceeded; Retry-After: 100 ms",
    "429 rate_limit_exceeded; Retry-After: 60000 milliseconds",
    "429 rate_limit_exceeded; Retry-After: 1 minute",
  ])("retries explicit short Retry-After windows: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(true);
  });

  it.each([
    "429 rate_limit_exceeded; Retry-After: 100",
    "429 rate_limit_exceeded; Retry-After: 60001 ms",
    "429 rate_limit_exceeded; Retry-After: 2 minutes",
  ])("does not retry long Retry-After windows: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(false);
  });
});
