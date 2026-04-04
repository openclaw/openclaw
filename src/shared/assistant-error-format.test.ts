import { describe, expect, it } from "vitest";
import {
  parseApiErrorPayload,
  extractLeadingHttpStatus,
  isCloudflareOrHtmlErrorPage,
  parseApiErrorInfo,
  formatRawAssistantErrorForUi,
} from "./assistant-error-format.js";

describe("parseApiErrorPayload", () => {
  it("returns null for empty input", () => {
    expect(parseApiErrorPayload("")).toBeNull();
    expect(parseApiErrorPayload(undefined)).toBeNull();
    expect(parseApiErrorPayload("   ")).toBeNull();
  });

  it("parses valid JSON error payload", () => {
    const result = parseApiErrorPayload('{"type": "error", "message": "test"}');
    expect(result?.type).toBe("error");
    expect(result?.message).toBe("test");
  });

  it("parses payload with request_id", () => {
    const result = parseApiErrorPayload('{"request_id": "abc123"}');
    expect(result?.request_id).toBe("abc123");
  });

  it("parses nested error object", () => {
    const result = parseApiErrorPayload('{"error": {"message": "rate limited"}}');
    expect((result as any)?.error?.message).toBe("rate limited");
  });
});

describe("extractLeadingHttpStatus", () => {
  it("extracts HTTP status code", () => {
    expect(extractLeadingHttpStatus("429 Too Many Requests")).toEqual({ code: 429, rest: "Too Many Requests" });
    expect(extractLeadingHttpStatus("500 Internal Server Error")).toEqual({ code: 500, rest: "Internal Server Error" });
  });

  it("returns null for missing status code", () => {
    expect(extractLeadingHttpStatus("Hello world")).toBeNull();
  });

  it("handles status with JSON body", () => {
    const result = extractLeadingHttpStatus('429 {"error": "rate limited"}');
    expect(result?.code).toBe(429);
  });
});

describe("isCloudflareOrHtmlErrorPage", () => {
  it("returns true for Cloudflare 521 error", () => {
    expect(isCloudflareOrHtmlErrorPage("<html><body>521</body></html>")).toBe(true);
  });

  it("returns false for 4xx errors", () => {
    expect(isCloudflareOrHtmlErrorPage("400 Bad Request")).toBe(false);
    expect(isCloudflareOrHtmlErrorPage("404 Not Found")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isCloudflareOrHtmlErrorPage("")).toBe(false);
  });
});

describe("parseApiErrorInfo", () => {
  it("extracts HTTP code and message", () => {
    const result = parseApiErrorInfo('429 {"error": {"message": "rate limited"}}');
    expect(result?.httpCode).toBe("429");
    expect(result?.message).toBe("rate limited");
  });

  it("extracts request ID", () => {
    const result = parseApiErrorInfo('{"request_id": "abc123", "message": "test"}');
    expect(result?.requestId).toBe("abc123");
  });
});

describe("formatRawAssistantErrorForUi", () => {
  it("returns generic message for empty input", () => {
    expect(formatRawAssistantErrorForUi("")).toContain("unknown error");
  });

  it("formats HTTP errors", () => {
    const result = formatRawAssistantErrorForUi("429 Too Many Requests");
    expect(result).toContain("429");
  });

  it("truncates long errors", () => {
    const long = "a".repeat(700);
    const result = formatRawAssistantErrorForUi(long);
    expect(result.length).toBeLessThan(700);
  });
});
