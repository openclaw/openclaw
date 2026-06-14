import { describe, expect, it } from "vitest";
import { isTransientAssistantApiFailure } from "./assistant-error-format.js";

describe("isTransientAssistantApiFailure", () => {
  it("detects OpenAI stream server_error JSON", () => {
    const raw = JSON.stringify({
      type: "error",
      error: {
        type: "server_error",
        code: "server_error",
        message: "An error occurred while processing your request.",
      },
      sequence_number: 2,
    });
    expect(isTransientAssistantApiFailure(raw)).toBe(true);
  });

  it("detects rate_limit_error payloads", () => {
    expect(
      isTransientAssistantApiFailure(
        '{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}',
      ),
    ).toBe(true);
  });

  it("returns false for invalid_request_error shaped payloads", () => {
    expect(
      isTransientAssistantApiFailure(
        '{"type":"error","error":{"type":"invalid_request_error","message":"Unknown model"}}',
      ),
    ).toBe(false);
  });
});
