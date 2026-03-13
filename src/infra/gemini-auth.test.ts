import { describe, expect, it } from "vitest";
import { parseGeminiAuth } from "./gemini-auth.js";

describe("parseGeminiAuth", () => {
  it("returns bearer auth for OAuth JSON tokens", () => {
    expect(parseGeminiAuth('{"token":"oauth-token","projectId":"demo"}')).toEqual({
      headers: {
        Authorization: "Bearer oauth-token",
        "Content-Type": "application/json",
      },
    });
  });

  it("falls back to API key auth for invalid or unusable OAuth payloads", () => {
    expect(parseGeminiAuth('{"token":"","projectId":"demo"}')).toEqual({
      headers: {
        "x-goog-api-key": '{"token":"","projectId":"demo"}',
        "Content-Type": "application/json",
      },
    });
    expect(parseGeminiAuth("{not-json}")).toEqual({
      headers: {
        "x-goog-api-key": "{not-json}",
        "Content-Type": "application/json",
      },
    });
    expect(parseGeminiAuth(' {"token":"oauth-token"}')).toEqual({
      headers: {
        "x-goog-api-key": ' {"token":"oauth-token"}',
        "Content-Type": "application/json",
      },
    });
  });
});
