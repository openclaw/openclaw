import { describe, expect, it, vi } from "vitest";
import { failoverClassificationCorpus } from "../../agents/failover/failover-classification.corpus.cases.test-support.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import {
  PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
  type AssistantMessage,
} from "../types.js";
import { isRetryableAssistantError, isTerminalAssistantError } from "./retry.js";

function errorMessage(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: createZeroUsageFixture(),
    stopReason: "error",
    errorMessage: message,
    timestamp: 1,
  };
}

describe("isRetryableAssistantError", () => {
  it.each([undefined, "invalid"])(
    "does not reclassify an identity conflict without safe-retry evidence: %s",
    (errorBody) => {
      const message = {
        ...errorMessage("Responses stream changed output item identity; connection reset"),
        errorCode: "responses_output_identity_conflict",
        errorBody,
      };
      expect(isTerminalAssistantError(message)).toBe(true);
      expect(isRetryableAssistantError(message)).toBe(false);
    },
  );
  // The classifier owns the full phrase corpus. Keep retry-specific evidence,
  // replay windows, and incomplete-stream regressions at this adapter boundary.
  it.each([
    ["google-sse-eof-incomplete-frame", true],
    ["google-sse-malformed-json-frame", false],
    ["billing-rate-limit-too-many", true],
    ["billing-service-capacity", true],
    ["billing-openai-structured-server-error", true],
    ["billing-econnrefused", true],
    ["retry-delay", true],
    ["legacy-billing-a-004", true],
    ["patterns-context-llamacpp-exceeded-500", true],
    ["billing-http402-rate-limit", true],
    ["legacy-billing-a-055", true],
    ["legacy-billing-a-059", true],
    ["legacy-billing-a-082", true],
    ["legacy-billing-b-036", true],
    ["legacy-billing-a-021", false],
    ["http-structured-insufficient-quota", false],
    ["patterns-xai-spending-limit", false],
  ] as const)("preserves retry policy for %s", (id, expected) => {
    const row = failoverClassificationCorpus.find((entry) => entry.id === id);
    if (!row) {
      throw new Error(`Missing retry fixture: ${id}`);
    }
    const message = errorMessage(row.signal.message ?? "");
    message.provider =
      ("provider" in row.signal ? row.signal.provider : undefined) ?? "test-provider";
    expect(isRetryableAssistantError(message)).toBe(expected);
  });

  it("does not retry a missing error message even with a transient code", () => {
    expect(
      isRetryableAssistantError({
        ...errorMessage(""),
        errorMessage: undefined,
        errorCode: "UND_ERR_CONNECT_TIMEOUT",
      }),
    ).toBe(false);
  });

  it.each([
    PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
    PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
    "openclaw_repeated_tool_error",
  ])("does not retry terminal outcome %s", (errorCode) => {
    const message = {
      ...errorMessage("The WebSocket closed after dispatch"),
      errorCode,
    };
    expect(isTerminalAssistantError(message)).toBe(true);
    expect(isRetryableAssistantError(message)).toBe(false);
  });

  it("does not retry a structured provider refusal with transient-looking text", () => {
    expect(
      isRetryableAssistantError({
        ...errorMessage("HTTP 503 temporary provider response"),
        diagnostics: [
          {
            type: "provider_refusal",
            timestamp: 0,
            details: { provider: "anthropic", category: "cyber" },
          },
        ],
      }),
    ).toBe(false);
  });

  it.each([
    { errorCode: "ERR_WEBSOCKET_NON_RETRYABLE_CLOSE", expected: false },
    { errorCode: "ERR_WEBSOCKET_TRANSPORT", expected: true },
  ])("honors structured WebSocket retry disposition $errorCode", ({ errorCode, expected }) => {
    expect(
      isRetryableAssistantError({
        ...errorMessage("WebSocket closed: policy reason included ECONNRESET"),
        errorCode,
      }),
    ).toBe(expected);
  });

  it("retries an incomplete terminal stream that retained visible partial text", () => {
    expect(
      isRetryableAssistantError({
        ...errorMessage("Bedrock stream ended before messageStop"),
        content: [{ type: "text", text: "I have" }],
      }),
    ).toBe(true);
  });

  it("retries a structured transient Undici error", () => {
    expect(
      isRetryableAssistantError({
        ...errorMessage("provider connection closed"),
        errorCode: "UND_ERR_HEADERS_TIMEOUT",
      }),
    ).toBe(true);
  });

  it.each(["model model-x-500-preview not found", "invalid api key sk-example502value"])(
    "does not retry permanent errors with status-code substrings: %s",
    (text) => {
      expect(isRetryableAssistantError(errorMessage(text))).toBe(false);
    },
  );

  it("does not retry a future Retry-After date", () => {
    vi.useFakeTimers();
    const now = new Date("2026-06-11T00:00:00.000Z");
    vi.setSystemTime(now);
    try {
      expect(
        isRetryableAssistantError(
          errorMessage(
            `429 rate limit; Retry-After: ${new Date(now.getTime() + 3_600_000).toUTCString()}`,
          ),
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "OpenAI API error (500): 500 The server had an error while processing your request. Sorry about that!",
  ])("retries built-in provider-wrapped transient 5xx: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(true);
  });

  it.each([undefined, 400, 500])(
    "does not replay a validation rejection with status %s",
    (status) => {
      const error = {
        type: "invalid_request_error",
        code: "unknown_parameter",
        message: "Unsupported parameter: timeout",
      };
      const prefix = status === undefined ? "" : `${status} `;
      expect(
        isRetryableAssistantError({
          ...errorMessage(`${prefix}${error.message}`),
          errorType: error.type,
          errorCode: error.code,
        }),
      ).toBe(false);
      expect(isRetryableAssistantError(errorMessage(`${prefix}${JSON.stringify({ error })}`))).toBe(
        false,
      );
    },
  );

  it.each(["500 request timed out", "529 Overloaded"])(
    "keeps concrete outage evidence ahead of a generic invalid-request type: %s",
    (text) => {
      expect(
        isRetryableAssistantError({
          ...errorMessage(text),
          errorType: "invalid_request_error",
        }),
      ).toBe(true);
    },
  );

  it.each([
    ["authentication failure", "OpenAI API error (401): Invalid authentication credentials"],
    [
      "authorization failure",
      "Azure OpenAI API error (403): OAuth authentication is currently not allowed for this organization",
    ],
    ["model not found", "Mistral API error (404): model not found"],
    [
      "quota exhausted",
      "OpenAI API error (429): insufficient_quota: Your account has insufficient quota balance to run this request.",
    ],
    [
      "envelope embedded in user text",
      'Invalid request: user text contained "OpenAI API error (500): invalid input"',
    ],
  ])("does not retry permanent provider-wrapped errors (%s): %s", (_label, text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(false);
  });

  it("retries a provider-wrapped short-window rate limit", () => {
    expect(
      isRetryableAssistantError(
        errorMessage(
          "OpenAI API error (429): RESOURCE_EXHAUSTED: Quota exceeded for requests per minute; please retry your request",
        ),
      ),
    ).toBe(true);
  });
});
