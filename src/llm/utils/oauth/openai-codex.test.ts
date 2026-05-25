import { afterEach, describe, expect, it, vi } from "vitest";
import { testing } from "./openai-codex.js";

function stubTokenResponse(body: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI Codex OAuth token responses", () => {
  it("does not echo token payload values when the exchange response is malformed", async () => {
    stubTokenResponse({
      access_token: "secret-access-token",
      expires_in: 3600,
    });

    const result = await testing.exchangeAuthorizationCode("code", "verifier");

    expect(result).toMatchObject({
      type: "failed",
      message: "OpenAI Codex token exchange response missing fields: refresh_token",
    });
    if (result.type === "failed") {
      expect(result.message).not.toContain("secret-access-token");
      expect(result.message).not.toContain("access_token");
    }
  });

  it("does not echo token payload values when the refresh response is malformed", async () => {
    stubTokenResponse({
      access_token: "new-secret-access-token",
      refresh_token: "new-secret-refresh-token",
    });

    const result = await testing.refreshAccessToken("old-refresh-token");

    expect(result).toMatchObject({
      type: "failed",
      message: "OpenAI Codex token refresh response missing fields: expires_in",
    });
    if (result.type === "failed") {
      expect(result.message).not.toContain("new-secret-access-token");
      expect(result.message).not.toContain("new-secret-refresh-token");
      expect(result.message).not.toContain("access_token");
      expect(result.message).not.toContain("refresh_token");
    }
  });
});
