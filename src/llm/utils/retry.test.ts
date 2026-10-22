import { describe, expect, it, vi } from "vitest";
import { failoverClassificationCorpus } from "../../agents/failover/failover-classification.corpus.cases.test-support.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import {
  PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
  type AssistantMessage,
} from "../types.js";
import { isRetryableAssistantError, isTerminalAssistantError } from "./retry.js";

function errorMessage(
  message: string | undefined,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
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
    ...overrides,
  };
}

function expectRetry(
  text: string | undefined,
  expected: boolean,
  overrides: Partial<AssistantMessage> = {},
) {
  expect(isRetryableAssistantError(errorMessage(text, overrides))).toBe(expected);
}

describe("isRetryableAssistantError", () => {
  it.each([undefined, "invalid"])("keeps identity conflicts terminal: %s", (errorBody) => {
    const text = "Responses stream changed output item identity; connection reset";
    const message = errorMessage(text, {
      errorCode: "responses_output_identity_conflict",
      errorBody,
    });
    expect(isTerminalAssistantError(message)).toBe(true);
    expect(isRetryableAssistantError(message)).toBe(false);
  });
  // The classifier owns the full phrase corpus. Keep retry-specific evidence,
  // replay windows, and incomplete-stream regressions at this adapter boundary.
  it.each([
    ["google-sse-eof-incomplete-frame", true],
    ["openai-sdk-malformed-sse", true],
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
    expectRetry(row.signal.message ?? "", expected, {
      provider: ("provider" in row.signal ? row.signal.provider : undefined) ?? "test-provider",
    });
  });

  it("requires error text even with a transient code", () =>
    expectRetry(undefined, false, { errorCode: "UND_ERR_CONNECT_TIMEOUT" }));

  it.each([
    PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
    PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
    "openclaw_repeated_tool_error",
    "openclaw_repetitive_output",
  ])("does not retry terminal outcome %s", (errorCode) => {
    const message = errorMessage("The WebSocket closed after dispatch", { errorCode });
    expect(isTerminalAssistantError(message)).toBe(true);
    expect(isRetryableAssistantError(message)).toBe(false);
  });

  it("keeps provider refusals terminal despite transient text", () =>
    expectRetry("HTTP 503 temporary provider response", false, {
      diagnostics: [
        {
          type: "provider_refusal",
          timestamp: 0,
          details: { provider: "anthropic", category: "cyber" },
        },
      ],
    }));

  it.each([
    { errorCode: "ERR_WEBSOCKET_NON_RETRYABLE_CLOSE", expected: false },
    { errorCode: "ERR_WEBSOCKET_TRANSPORT", expected: true },
  ])("honors WebSocket disposition $errorCode", ({ errorCode, expected }) =>
    expectRetry("WebSocket closed: policy reason included ECONNRESET", expected, {
      errorCode,
    }),
  );

  it("retries incomplete streams with partial text", () =>
    expectRetry("Bedrock stream ended before messageStop", true, {
      content: [{ type: "text", text: "I have" }],
    }));

  it("retries a structured transient Undici error", () =>
    expectRetry("provider connection closed", true, {
      errorCode: "UND_ERR_HEADERS_TIMEOUT",
    }));

  it.each(["model model-x-500-preview not found", "invalid api key sk-example502value"])(
    "rejects embedded status substrings: %s",
    (text) => expectRetry(text, false),
  );

  it("does not retry a future Retry-After date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T00:00:00.000Z"));
    try {
      expectRetry("429 rate limit; Retry-After: Thu, 11 Jun 2026 01:00:00 GMT", false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries built-in provider-wrapped transient 5xx", () =>
    expectRetry(
      "OpenAI API error (500): 500 The server had an error while processing your request. Sorry about that!",
      true,
    ));

  it.each([undefined, 400, 500])("rejects validation errors with status %s", (status) => {
    const error = {
      type: "invalid_request_error",
      code: "unknown_parameter",
      message: "Unsupported parameter: timeout",
    };
    const prefix = status === undefined ? "" : `${status} `;
    expectRetry(`${prefix}${error.message}`, false, {
      errorType: error.type,
      errorCode: error.code,
    });
    expectRetry(`${prefix}${JSON.stringify({ error })}`, false);
  });

  it.each(["500 request timed out", "529 Overloaded"])(
    "outage overrides invalid-request type: %s",
    (text) => expectRetry(text, true, { errorType: "invalid_request_error" }),
  );
});
