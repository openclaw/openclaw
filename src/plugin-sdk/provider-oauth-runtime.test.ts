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

  it("parses authorization code input from redirect URLs, query strings, and raw codes", () => {
    expect(
      parseOAuthAuthorizationInput("http://localhost/callback?code=oauth-code&state=oauth-state"),
    ).toEqual({ code: "oauth-code", state: "oauth-state" });
    expect(parseOAuthAuthorizationInput("code=oauth-code&state=oauth-state")).toEqual({
      code: "oauth-code",
      state: "oauth-state",
    });
    expect(parseOAuthAuthorizationInput("oauth-code#oauth-state")).toEqual({
      code: "oauth-code",
      state: "oauth-state",
    });
    expect(parseOAuthAuthorizationInput(" oauth-code ")).toEqual({ code: "oauth-code" });
    expect(parseOAuthAuthorizationInput("   ")).toEqual({});
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
