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

  it("does not retry permanent model-not-found errors", () => {
    expect(isRetryableAssistantError(errorMessage("model gpt-5.5-preview-0429 not found"))).toBe(
      false,
    );
    expect(isRetryableAssistantError(errorMessage("404 model not found: openai/gpt-unknown"))).toBe(
      false,
    );
  });

  it("does not retry permanent image-dimension errors", () => {
    expect(
      isRetryableAssistantError(
        errorMessage(
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.1.image: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}',
        ),
      ),
    ).toBe(false);
  });

  it("does not retry permanent auth errors", () => {
    expect(isRetryableAssistantError(errorMessage("invalid api key sk-proj-abc502xyz"))).toBe(
      false,
    );
    expect(isRetryableAssistantError(errorMessage("api key has been revoked"))).toBe(false);
  });

  it("does not retry long-window rate limits", () => {
    expect(
      isRetryableAssistantError(
        errorMessage("429 You exceeded your daily request limit. Please try again in 24 hours."),
      ),
    ).toBe(false);
    expect(
      isRetryableAssistantError(errorMessage("rate limit reached for requests. Retry after 6h.")),
    ).toBe(false);
  });

  it("does not match bare status-code substrings inside ids, dimensions, or keys", () => {
    // "0429" inside a model id should not match \b429\b.
    expect(isRetryableAssistantError(errorMessage("model xyz-0429 is loading"))).toBe(false);
    // "1504" inside image dimensions should not match \b504\b.
    expect(
      isRetryableAssistantError(errorMessage("Image dimensions 1504x1504 are unsupported")),
    ).toBe(false);
    // "502" inside an api key should not match \b502\b.
    expect(isRetryableAssistantError(errorMessage("using key sk-xyz502abc")), "502").toBe(false);
  });
});
