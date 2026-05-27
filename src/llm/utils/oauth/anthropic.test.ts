import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAnthropicToken } from "./anthropic.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anthropic OAuth token responses", () => {
  it("does not echo token payload values when refresh JSON parsing fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"access_token":"secret-access-token","refresh_token":"secret-refresh"', {
            status: 200,
          }),
      ),
    );

    await expect(refreshAnthropicToken("old-refresh-token")).rejects.toThrow(
      "Anthropic token refresh returned invalid JSON.",
    );

    try {
      await refreshAnthropicToken("old-refresh-token");
      throw new Error("Expected refresh to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("secret-access-token");
      expect(message).not.toContain("secret-refresh");
      expect(message).not.toContain("access_token");
      expect(message).not.toContain("refresh_token");
      expect(message).toContain("bodyBytes=");
    }
  });
});
