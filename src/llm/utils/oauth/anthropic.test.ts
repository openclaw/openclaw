// Anthropic OAuth tests cover token exchange and refresh behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuthProvider, refreshAnthropicToken } from "./anthropic.js";

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

  it("caps oversized Anthropic OAuth responses at 16 MiB instead of buffering the full body", async () => {
    // 18 MiB body in 1 MiB chunks exceeds the shared 16 MiB cap on
    // readProviderTextResponse. The bounded reader must surface the cap
    // with the per-surface label so logs can attribute the rejection to
    // this call site, not github-copilot or chutes.
    const CHUNK = 1024 * 1024;
    const CHUNK_COUNT = 18;
    let pulls = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls >= CHUNK_COUNT) {
          controller.close();
          return;
        }
        pulls += 1;
        controller.enqueue(encoder.encode("{".repeat(CHUNK)));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(refreshAnthropicToken("old-refresh-token")).rejects.toThrow(
      "Anthropic OAuth token request: text response exceeds 16777216 bytes",
    );
  });
});
