import { describe, expect, it, vi } from "vitest";
import { projectProviderError } from "../../../packages/ai/src/utils/provider-error.js";
import { failoverClassificationCorpus } from "../../agents/failover/failover-classification.corpus.cases.test-support.js";
import { failoverRetryExpectations } from "../../agents/failover/failover-retry.expected.test-support.js";
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
  it.each([undefined, "{}", "invalid", '{"retrySafe":false}'])(
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
  it("freezes one retry decision for every failover corpus row", () => {
    expect(Object.keys(failoverRetryExpectations).toSorted()).toEqual(
      failoverClassificationCorpus.map((row) => row.id).toSorted(),
    );
  });

  it.each(failoverClassificationCorpus)(
    "preserves the retry decision for $id [$source]",
    ({ id, signal }) => {
      const message = signal.message
        ? errorMessage(signal.message)
        : ({ ...errorMessage(""), errorMessage: undefined } as AssistantMessage);
      message.provider = ("provider" in signal ? signal.provider : undefined) ?? "test-provider";

      expect(isRetryableAssistantError(message)).toBe(
        failoverRetryExpectations[id as keyof typeof failoverRetryExpectations],
      );
    },
  );

  it.each([PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE, PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE])(
    "does not retry replay-unsafe provider outcome %s",
    (errorCode) => {
      expect(
        isRetryableAssistantError({
          ...errorMessage("The WebSocket closed after dispatch"),
          errorCode,
        }),
      ).toBe(false);
    },
  );

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

  it.each([
    "model gpt-5.5-preview-0429 not found",
    "model model-x-500-preview not found",
    "Image dimensions 1504x1504 exceed the maximum allowed size",
    "Image width 500 exceeds the maximum allowed size",
    "invalid api key sk-example502value",
  ])("does not retry permanent errors with status-code substrings: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(false);
  });

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
    "Azure OpenAI API error (502): Bad gateway from upstream",
    "Mistral API error (503): service temporarily unavailable",
    "Provider API error (504): gateway timeout",
  ])("retries built-in provider-wrapped transient 5xx: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(true);
  });

  it.each([500, 502])("does not replay HTTP %s request-validation errors", (status) => {
    expect(
      isRetryableAssistantError({
        ...errorMessage(`${status} Unknown parameter: 'logprobs'`),
        errorType: "invalid_request_error",
        errorCode: "unknown_parameter",
      }),
    ).toBe(false);
    expect(
      isRetryableAssistantError(
        errorMessage(
          `${status} {"error":{"type":"invalid_request_error","message":"Unsupported parameter: logprobs"}}`,
        ),
      ),
    ).toBe(false);
  });

  it.each([undefined, 400, 404, 422, 500, 502])(
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

  it("honors validation when projection keeps status outside the message", () => {
    const error = {
      type: "invalid_request_error",
      code: "unknown_parameter",
      message: "Unsupported parameter: timeout",
    };
    const projected = projectProviderError({ status: 502, message: error.message, error });
    expect(
      isRetryableAssistantError({ ...errorMessage(projected.errorMessage), ...projected }),
    ).toBe(false);
  });

  it.each([
    "500 request timed out",
    "502 Bad gateway",
    "503 service unavailable",
    "529 Overloaded",
  ])("keeps concrete outage evidence ahead of a generic invalid-request type: %s", (text) => {
    expect(
      isRetryableAssistantError({
        ...errorMessage(text),
        errorType: "invalid_request_error",
      }),
    ).toBe(true);
  });

  it("does not treat permanent provider-wrapped 4xx as retryable", () => {
    expect(
      isRetryableAssistantError(
        errorMessage("OpenAI API error (400): 400 Model Id [gpt-5.4-nano] not found"),
      ),
    ).toBe(false);
  });

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
