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
    "model gpt-5.5-preview-0429 not found",
    "Image dimensions 1504x1504 exceed the maximum allowed size",
    "invalid api key sk-proj-abc502xyz",
    "Provider returned error: 404 model gpt-5.5-preview-0429 not found",
    "Provider returned error: HTTP 400 image dimensions 1504x1504 exceed the maximum allowed size",
    "Provider returned error: 401 invalid api key sk-proj-abc502xyz",
    "Provider returned error: 403 Forbidden",
  ])("keeps permanent provider errors non-retryable: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(false);
  });

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

  it.each([
    "Provider returned error: 429 too many requests",
    "Provider returned error: HTTP 500 internal server error",
    "Provider returned error: 502 bad gateway",
    "Provider returned error: 504 gateway timeout",
  ])("retries transient provider status errors: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(true);
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
