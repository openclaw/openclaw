import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshOpenAICodexToken, testing } from "./openai-codex.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function stubTokenResponse(body: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

function stubHangingTokenRequest(timeoutMs: number): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
    expect(actualTimeoutMs).toBe(timeoutMs);
    const controller = new AbortController();
    queueMicrotask(() => {
      controller.abort(new DOMException("timed out", "TimeoutError"));
    });
    return controller.signal;
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }

          const abort = () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("aborted", "AbortError"),
            );
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
        }),
    ),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpenAI Codex OAuth token responses", () => {
  it("waits for Node OAuth runtime before creating an authorization flow", async () => {
    const flow = await testing.createAuthorizationFlow("openclaw-test");
    const url = new URL(flow.url);

    expect(flow.state).toMatch(/^[a-f0-9]{32}$/u);
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(url.searchParams.get("originator")).toBe("openclaw-test");
    const redirectUri = url.searchParams.get("redirect_uri");
    expect(redirectUri).toBeTruthy();
    expect(flow.redirectUri).toBe(redirectUri);
    expect(testing.callbackHost).toBe(new URL(redirectUri ?? "").hostname);
  });

  it("builds callback redirect URIs from the configured loopback host", () => {
    expect(testing.resolveRedirectUri("127.0.0.1")).toBe("http://127.0.0.1:1455/auth/callback");
  });

  it("rejects non-loopback callback bind hosts", () => {
    expect(() => testing.resolveCallbackHost({ OPENCLAW_OAUTH_CALLBACK_HOST: "0.0.0.0" })).toThrow(
      "callback host must be localhost, 127.0.0.1, or ::1",
    );
  });

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

  it("times out token exchange requests", async () => {
    stubHangingTokenRequest(5);

    const result = await testing.exchangeAuthorizationCode(
      "code",
      "verifier",
      testing.resolveRedirectUri("localhost"),
      { timeoutMs: 5 },
    );

    expect(result).toMatchObject({
      type: "failed",
      message: "OpenAI Codex token exchange timed out after 5ms",
    });
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

  it("times out token refresh requests", async () => {
    stubHangingTokenRequest(5);

    const result = await testing.refreshAccessToken("old-refresh-token", { timeoutMs: 5 });

    expect(result).toMatchObject({
      type: "failed",
      message: "OpenAI Codex token refresh timed out after 5ms",
    });
  });

  it("extracts the account id from URL-safe base64 JWT payloads", async () => {
    const accessToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "w_ébé_1fzcswWN6Pi5zL",
      },
    });
    expect(accessToken.split(".")[1]).toContain("_");
    stubTokenResponse({
      access_token: accessToken,
      refresh_token: "new-secret-refresh-token",
      expires_in: 3600,
    });

    await expect(refreshOpenAICodexToken("old-refresh-token")).resolves.toMatchObject({
      accountId: "w_ébé_1fzcswWN6Pi5zL",
    });
  });
});
