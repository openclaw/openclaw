// Provider OAuth runtime tests cover PKCE redirects, callback parsing, and token exchange helpers.
import { describe, expect, it } from "vitest";
import {
  generateOAuthState,
  generatePKCE,
  oauthErrorHtml,
  oauthSuccessHtml,
  parseOAuthAuthorizationInput,
  resolveOAuthTokenExpiresAt,
  resolveOAuthTokenLifetimeMs,
} from "./provider-oauth-runtime.js";

describe("provider OAuth runtime", () => {
  it("generates a SHA-256 PKCE challenge and independent OAuth state", async () => {
    const { verifier, challenge } = await generatePKCE();
    const state = generateOAuthState();
    const nextState = generateOAuthState();

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(challenge).toBe(Buffer.from(digest).toString("base64url"));
    expect(state).toHaveLength(43);
    expect(state).not.toBe(verifier);
    expect(nextState).toHaveLength(43);
    expect(nextState).not.toBe(state);
  });

  it("parses a pasted redirect URL, query string, code#state or bare code", () => {
    const expected = { state: "oauth-state" };
    for (const input of [
      "http://localhost/callback?code=oauth-code&state=oauth-state",
      "code=oauth-code&state=oauth-state",
      "oauth-code#oauth-state",
    ]) {
      expect(parseOAuthAuthorizationInput(input, expected)).toEqual({
        code: "oauth-code",
        state: "oauth-state",
      });
    }
    // A bare code or a state-less address carries no state; PKCE binds it to the attempt.
    expect(parseOAuthAuthorizationInput(" oauth-code ", expected)).toEqual({ code: "oauth-code" });
    expect(parseOAuthAuthorizationInput("http://localhost/cb?code=c", expected)).toEqual({
      code: "c",
    });
  });

  it("keeps the shipped one-argument call permissive so existing callers can reprompt", () => {
    expect(parseOAuthAuthorizationInput("  ")).toEqual({});
    expect(parseOAuthAuthorizationInput("?error=access_denied")).toEqual({});
    expect(parseOAuthAuthorizationInput("oauth-code#oauth-state")).toEqual({
      code: "oauth-code",
      state: "oauth-state",
    });
  });

  it.each([
    ["http://localhost/cb?code=c&state=other", "paste_wrong_attempt"],
    ["?error=access_denied", "consent_denied"],
    ["error=access_denied", "consent_denied"],
    ["http://localhost/cb?error=admin_policy_enforced&state=oauth-state", "admin_blocked"],
    ["https://auth.example/authorize?client_id=x&state=oauth-state", "paste_sign_in_page"],
    ["http://localhost/cb?state=oauth-state", "paste_no_code"],
    ["   ", "paste_no_code"],
  ])("rejects %s as %s", (input, reason) => {
    expect(() =>
      parseOAuthAuthorizationInput(input, {
        state: "oauth-state",
        signInUrl: "https://auth.example/authorize?client_id=x&state=oauth-state",
      }),
    ).toThrow(expect.objectContaining({ name: "ProviderAuthFailure", reason }));
  });

  it("escapes HTML-sensitive OAuth page content", () => {
    expect(oauthSuccessHtml(`signed in as <user>&"'`)).toContain(
      "signed in as &lt;user&gt;&amp;&quot;&#39;",
    );
    expect(oauthErrorHtml("failed <login>", `details &"'`)).toContain("details &amp;&quot;&#39;");
  });

  it("resolves safe OAuth token lifetimes and expiry timestamps", () => {
    expect(resolveOAuthTokenLifetimeMs("30")).toBe(30_000);
    expect(resolveOAuthTokenExpiresAt(30, { nowMs: 1_000, refreshSkewMs: 5_000 })).toBe(26_000);
  });

  it("rejects invalid OAuth token lifetimes and Date-invalid expiries", () => {
    expect(resolveOAuthTokenLifetimeMs(0)).toBeUndefined();
    expect(resolveOAuthTokenLifetimeMs(1.5)).toBeUndefined();
    expect(resolveOAuthTokenLifetimeMs(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(resolveOAuthTokenExpiresAt(Number.MAX_SAFE_INTEGER, { nowMs: 1_000 })).toBeUndefined();
    expect(
      resolveOAuthTokenExpiresAt(30, {
        nowMs: 8_640_000_000_000_000,
      }),
    ).toBeUndefined();
    expect(
      resolveOAuthTokenExpiresAt(30, {
        nowMs: 8_640_000_000_000_001,
      }),
    ).toBeUndefined();
  });
});
