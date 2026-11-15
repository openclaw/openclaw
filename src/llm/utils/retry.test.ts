import { describe, expect, it, vi } from "vitest";
import { failoverClassificationCorpus } from "../../agents/failover/failover-classification.corpus.cases.test-support.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
  type AssistantMessage,
} from "../types.js";
import { isRetryableAssistantError, isTerminalAssistantError } from "./retry.js";

const websocketClose = "WebSocket closed: policy reason included ECONNRESET";

function expectRetry(
  text: string | undefined,
  expected: boolean,
  overrides: Partial<AssistantMessage> = {},
  terminal = false,
) {
  const message = makeAgentAssistantMessage({
    content: [],
    provider: "test-provider",
    stopReason: "error",
    errorMessage: text,
    ...overrides,
  });
  if (terminal) {
    expect(isTerminalAssistantError(message)).toBe(true);
  }
  expect(isRetryableAssistantError(message)).toBe(expected);
}

describe("isRetryableAssistantError", () => {
  it.each([undefined, "invalid"])("keeps identity conflicts terminal: %s", (errorBody) => {
    expectRetry(
      "Responses stream changed output item identity; connection reset",
      false,
      { errorCode: "responses_output_identity_conflict", errorBody },
      true,
    );
  });
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

  it.each([
    PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
    PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
    "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    "openclaw_repeated_tool_error",
    "openclaw_repetitive_output",
  ])("does not retry terminal outcome %s", (errorCode) => {
    expectRetry("The WebSocket closed after dispatch", false, { errorCode }, true);
  });

  it("keeps provider refusals terminal despite transient text", () =>
    expectRetry("HTTP 503 temporary provider response", false, {
      diagnostics: [{ type: "provider_refusal", timestamp: 0 }],
    }));

  it.each<[string | undefined, boolean, Partial<AssistantMessage>?]>([
    [undefined, false, { errorCode: "UND_ERR_CONNECT_TIMEOUT" }],
    [websocketClose, false, { errorCode: "ERR_WEBSOCKET_NON_RETRYABLE_CLOSE" }],
    [websocketClose, true, { errorCode: "ERR_WEBSOCKET_TRANSPORT" }],
    [
      "Bedrock stream ended before messageStop",
      true,
      { content: [{ type: "text", text: "I have" }] },
    ],
    ["provider connection closed", true, { errorCode: "UND_ERR_HEADERS_TIMEOUT" }],
    ["model model-x-500-preview not found", false],
    ["invalid api key sk-example502value", false],
    ["OpenAI API error (500): 500 server error", true],
    ["500 request timed out", true, { errorType: "invalid_request_error" }],
    ["529 Overloaded", true, { errorType: "invalid_request_error" }],
  ])("applies retry evidence for %s (%j)", (text, expected, overrides) =>
    expectRetry(text, expected, overrides),
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
});
