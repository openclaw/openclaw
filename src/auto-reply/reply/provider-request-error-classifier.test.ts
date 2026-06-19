/** Tests provider request error classification for retry/fallback decisions. */
import { describe, expect, it } from "vitest";
import {
  classifyProviderRequestError,
  PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
  PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
  PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE,
} from "./provider-request-error-classifier.js";

describe("provider request error classifier", () => {
  it.each([
    [
      "OpenAI missing custom tool output",
      "Custom tool call output is missing for call id: call_live_123.",
    ],
    [
      "Bedrock tool result count mismatch",
      "The number of toolResult blocks at messages.186.content exceeds the number of toolUse blocks of previous turn.",
    ],
    [
      "Gemini function-call ordering mismatch",
      "400 Function call turn comes immediately after a user turn or after a function response turn.",
    ],
    ["generic role ordering mismatch", "400 Incorrect role information"],
    [
      "alternating role ordering mismatch",
      "messages: roles must alternate between user and assistant",
    ],
    [
      "local replay invariant guard",
      "invalid_replay_transcript: OpenAI Responses replay contains dangling_tool_call toolCallId=call_1 at message index 4",
    ],
  ])("classifies %s as provider conversation-state errors", (_label, message) => {
    expect(classifyProviderRequestError(new Error(message))).toEqual({
      code: "provider_conversation_state_error",
      userMessage: PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
      technicalMessage: message,
    });
  });

  it("leaves bare no-body 400 provider failures unclassified", () => {
    expect(classifyProviderRequestError(new Error("400 status code (no body)"))).toBeUndefined();
  });

  it("leaves explicit HTTP 429 rate-limit failures on the existing rate-limit path", () => {
    expect(classifyProviderRequestError(new Error("429: rate limit exceeded"))).toBeUndefined();
  });

  it.each([
    ["top-level status", { status: 429 }],
    ["response status", { response: { status: "429" } }],
    ["cause statusCode", { cause: { statusCode: 429 } }],
  ])("classifies generic HTTP 429 errors from %s metadata", (_label, metadata) => {
    const error = new Error(
      "Something went wrong while processing your request. Please try again.",
    );
    Object.assign(error, metadata);

    expect(classifyProviderRequestError(error)).toEqual({
      code: "provider_rate_limit_or_quota_error",
      userMessage: PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE,
      technicalMessage: "Something went wrong while processing your request. Please try again.",
    });
  });

  it("ignores unrelated provider errors", () => {
    expect(
      classifyProviderRequestError(new Error("INVALID_ARGUMENT: some other failure")),
    ).toBeUndefined();
  });

  it("surfaces provider internal errors without suggesting session reset", () => {
    expect(
      classifyProviderRequestError(
        new Error("The AI service returned an internal error. Please try again in a moment."),
      ),
    ).toEqual({
      code: "provider_internal_error",
      userMessage: PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
      technicalMessage: "The AI service returned an internal error. Please try again in a moment.",
    });
  });

  it("classifies generic server_error provider payloads as internal errors", () => {
    const message =
      "server_error: An error occurred while processing your request. Please include the request ID req_123.";

    expect(classifyProviderRequestError(new Error(message))).toEqual({
      code: "provider_internal_error",
      userMessage: PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
      technicalMessage: message,
    });
  });
});
