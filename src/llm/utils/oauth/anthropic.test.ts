// Anthropic OAuth tests cover token exchange and refresh behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuthProvider, refreshAnthropicToken, testing } from "./anthropic.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anthropic OAuth token responses", () => {
  it("cancels provider login before opening the OAuth flow", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      anthropicOAuthProvider.login({
        onAuth: vi.fn(),
        onPrompt: vi.fn(async () => "unused-code"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Login cancelled");
  });

  it("does not open the OAuth flow after cancellation during setup", async () => {
    const controller = new AbortController();
    const onAuth = vi.fn();
    const loginPromise = anthropicOAuthProvider.login({
      onAuth,
      onPrompt: vi.fn(async () => "unused-code"),
      signal: controller.signal,
    });

    controller.abort();

    await expect(loginPromise).rejects.toThrow("Login cancelled");
    expect(onAuth).not.toHaveBeenCalled();
  });

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

  it("rejects unsafe token lifetimes from refresh responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            '{"access_token":"new-access-token","refresh_token":"new-refresh-token","expires_in":1e309}',
            { status: 200 },
          ),
      ),
    );

    await expect(refreshAnthropicToken("old-refresh-token")).rejects.toThrow(
      "Anthropic token refresh returned invalid token fields.",
    );
  });
});

describe("Anthropic OAuth callback host", () => {
  it("builds callback redirect URIs from the configured loopback host", () => {
    expect(testing.resolveRedirectUri("127.0.0.1")).toBe("http://127.0.0.1:53692/callback");
  });

  it("wraps IPv6 loopback in brackets for redirect URIs", () => {
    expect(testing.resolveRedirectUri("::1")).toBe("http://[::1]:53692/callback");
  });

  it("rejects non-loopback callback bind hosts", () => {
    expect(() => testing.resolveCallbackHost({ OPENCLAW_OAUTH_CALLBACK_HOST: "0.0.0.0" })).toThrow(
      "Anthropic OAuth callback host must be localhost, 127.0.0.1, or ::1",
    );
  });

  it("defaults callback host to localhost when env var is unset", () => {
    expect(testing.resolveCallbackHost({})).toBe("localhost");
  });
});
