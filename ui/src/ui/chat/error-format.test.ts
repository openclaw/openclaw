import { describe, expect, it } from "vitest";
import { formatRawAssistantErrorForUi } from "./error-format.ts";

describe("formatRawAssistantErrorForUi", () => {
  it("formats JSON API errors with http code/type/message/request id", () => {
    const text = formatRawAssistantErrorForUi(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account rate limit."},"request_id":"req_123"}',
    );
    expect(text).toBe(
      "HTTP 429 rate_limit_error: This request would exceed your account rate limit. (request_id: req_123)",
    );
  });

  it("formats plain http status text", () => {
    expect(formatRawAssistantErrorForUi("500 Internal Server Error")).toBe(
      "HTTP 500: Internal Server Error",
    );
  });

  it("falls back to unknown error for empty input", () => {
    expect(formatRawAssistantErrorForUi(" ")).toBe("LLM request failed with an unknown error.");
  });
});
