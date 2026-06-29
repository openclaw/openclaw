/** Tests provider request error classification for retry/fallback decisions. */
import { describe, expect, it } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import {
  classifyProviderRequestError,
  PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE,
  PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
  PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
  PROVIDER_MODEL_UNAVAILABLE_USER_MESSAGE,
  PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE,
} from "./provider-request-error-classifier.js";

describe("provider request error classifier", () => {
  it("classifies provider HTTP 401 authentication failures", () => {
    const message =
      "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";

    expect(classifyProviderRequestError(new Error(message))).toEqual({
      code: "provider_authentication_error",
      userMessage: PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE,
      technicalMessage: message,
    });
  });

  it("classifies typed authentication failures without relying on raw provider text", () => {
    const error = new FailoverError("LLM request unauthorized.", {
      reason: "auth",
      provider: "openai",
      model: "gpt-5.5",
      status: 401,
    });

    expect(classifyProviderRequestError(error)).toEqual({
      code: "provider_authentication_error",
      userMessage: PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE,
      technicalMessage: "LLM request unauthorized.",
    });
  });

  it("does not label typed HTTP 403 authorization failures as HTTP 401", () => {
    const error = new FailoverError("Provider access denied.", {
      reason: "auth_permanent",
      provider: "openai",
      model: "gpt-5.5",
      status: 403,
    });

    expect(classifyProviderRequestError(error)).toBeUndefined();
  });

  it("leaves unrelated HTTP 401 failures unclassified", () => {
    expect(
      classifyProviderRequestError(
        new Error("401 input item id does not belong to this conversation"),
      ),
    ).toBeUndefined();
  });

  it("classifies typed model_not_found failover errors as model unavailable", () => {
    const error = new FailoverError(
      'Unknown model: openai/gpt-5.3-codex. Found agents.defaults.models["openai/gpt-5.3-codex"] bound to the "codex" agent runtime.',
      {
        reason: "model_not_found",
        provider: "openai",
        model: "gpt-5.3-codex",
      },
    );

    expect(classifyProviderRequestError(error)).toEqual({
      code: "provider_model_unavailable",
      userMessage: PROVIDER_MODEL_UNAVAILABLE_USER_MESSAGE,
      technicalMessage: error.message,
    });
  });

  it("does not classify model-not-found from raw provider text alone", () => {
    // Detection is structural (typed failover reason), not text matching: a
    // bare error string without the typed reason is left unclassified.
    expect(
      classifyProviderRequestError(new Error("Unknown model: openai/gpt-5.3-codex")),
    ).toBeUndefined();
  });

  it("does not misclassify other typed failover reasons as model unavailable", () => {
    const error = new FailoverError("Provider overloaded.", {
      reason: "overloaded",
      provider: "openai",
      model: "gpt-5.5",
    });

    expect(classifyProviderRequestError(error)).toBeUndefined();
  });

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
