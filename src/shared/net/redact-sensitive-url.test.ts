import { describe, expect, it } from "vitest";
import {
  isSensitiveUrlQueryParamName,
  redactSensitiveUrl,
  redactSensitiveUrlLikeString,
} from "./redact-sensitive-url.js";

describe("redactSensitiveUrl", () => {
  it("redacts userinfo and sensitive query params from valid URLs", () => {
    expect(redactSensitiveUrl("https://user:pass@example.com/mcp?token=secret&safe=value")).toBe(
      "https://***:***@example.com/mcp?token=***&safe=value",
    );
  });

  it("treats query param names case-insensitively", () => {
    expect(redactSensitiveUrl("https://example.com/mcp?Access_Token=secret")).toBe(
      "https://example.com/mcp?Access_Token=***",
    );
  });

  it("keeps non-sensitive URLs unchanged", () => {
    expect(redactSensitiveUrl("https://example.com/mcp?safe=value")).toBe(
      "https://example.com/mcp?safe=value",
    );
  });
});

describe("redactSensitiveUrlLikeString", () => {
  it("redacts invalid URL-like strings", () => {
    expect(redactSensitiveUrlLikeString("//user:pass@example.com/mcp?client_secret=secret")).toBe(
      "//***:***@example.com/mcp?client_secret=***",
    );
  });
});

describe("isSensitiveUrlQueryParamName", () => {
  it("matches the auth-oriented query params used by MCP SSE config redaction", () => {
    expect(isSensitiveUrlQueryParamName("token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("refresh_token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("safe")).toBe(false);
  });
});
