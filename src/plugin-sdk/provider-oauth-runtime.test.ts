// Provider OAuth runtime tests cover PKCE redirects, callback parsing, and token exchange helpers.
import { describe, expect, it } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import {
  createNotAttemptedOAuthRefreshError,
  generateOAuthState,
  generatePKCE,
  isRecoverableOAuthRefreshFailure,
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

  it.each([
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    }),
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
        code: "ECONNREFUSED",
        syscall: "connect",
      }),
    }),
    Object.assign(new Error("getaddrinfo ENOTFOUND auth.x.ai"), {
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
    }),
    Object.assign(new Error("getaddrinfo EAI_AGAIN auth.x.ai"), {
      code: "EAI_AGAIN",
      syscall: "getaddrinfo",
    }),
    new SsrFBlockedError("Blocked private network"),
  ])("classifies provably undispatched refresh failures as not-attempted: %s", (failure) => {
    const error = createNotAttemptedOAuthRefreshError("xAI OAuth refresh", failure);
    expect(error).toMatchObject({
      message: "xAI OAuth refresh transport failed before dispatch",
      oauthRefreshOutcome: {
        version: 1,
        phase: "before-dispatch",
        outcome: "not-attempted",
        recovery: { kind: "later", evidence: "dispatch-not-started" },
      },
    });
    expect(isRecoverableOAuthRefreshFailure(error)).toBe(true);
  });

  it.each([
    Object.assign(new Error("reset before headers"), { code: "ECONNRESET" }),
    Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" }),
    new TypeError("fetch failed", {
      cause: new AggregateError([
        Object.assign(new Error("connect refused"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
        Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" }),
      ]),
    }),
    new Error("unknown provider failure"),
    Object.assign(new Error("aborted"), { name: "AbortError" }),
  ])("leaves ambiguous refresh transport failures unclassified: %s", (failure) => {
    expect(createNotAttemptedOAuthRefreshError("xAI OAuth refresh", failure)).toBeUndefined();
  });
});
