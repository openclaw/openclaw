/**
 * Regression tests for getOAuthApiKey refresh behavior.
 *
 * Issue #103846: getOAuthApiKey used a raw `Date.now() >= creds.expires` check
 * while the OAuth manager gate (hasUsableOAuthCredential) refreshes within a
 * 5-minute margin. Inside the margin window the manager would decide to refresh
 * but getOAuthApiKey skipped it, silently returning the unchanged credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOAuthApiKey } from "./index.js";
import type { OAuthCredentials, OAuthProviderInterface } from "./types.js";

const BASE_NOW = 1_700_000_000_000;

function makeProvider(refreshToken: ReturnType<typeof vi.fn>): OAuthProviderInterface {
  return {
    id: "anthropic",
    label: "Anthropic",
    usesCallbackServer: true,
    async login() {
      throw new Error("unused");
    },
    async refreshToken(creds: OAuthCredentials) {
      return refreshToken(creds);
    },
    getApiKey(creds: OAuthCredentials) {
      return creds.access;
    },
  };
}

describe("getOAuthApiKey refresh margin", () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(BASE_NOW);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("refreshes a credential that is within the refresh margin but not yet expired", async () => {
    const refreshed: OAuthCredentials = {
      type: "oauth",
      provider: "anthropic",
      access: "refreshed-access",
      refresh: "refresh-token",
      expires: BASE_NOW + 10 * 60 * 1000,
      idToken: undefined,
      scopes: undefined,
    };
    const refreshToken = vi.fn(async () => refreshed);

    const creds: OAuthCredentials = {
      type: "oauth",
      provider: "anthropic",
      access: "stale-access",
      refresh: "refresh-token",
      // 4 minutes remaining: inside the 5-minute margin, before raw expiry.
      expires: BASE_NOW + 4 * 60 * 1000,
      idToken: undefined,
      scopes: undefined,
    };

    const result = await getOAuthApiKey("anthropic", { anthropic: creds });

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(result?.newCredentials).toBe(refreshed);
    expect(result?.apiKey).toBe("refreshed-access");
  });

  it("does not refresh a credential comfortably outside the margin", async () => {
    const refreshToken = vi.fn(async () => {
      throw new Error("should not be called");
    });

    const creds: OAuthCredentials = {
      type: "oauth",
      provider: "anthropic",
      access: "current-access",
      refresh: "refresh-token",
      // 30 minutes remaining: well outside the margin.
      expires: BASE_NOW + 30 * 60 * 1000,
      idToken: undefined,
      scopes: undefined,
    };

    const result = await getOAuthApiKey("anthropic", { anthropic: creds });

    expect(refreshToken).not.toHaveBeenCalled();
    expect(result?.apiKey).toBe("current-access");
  });

  it("refreshes a credential past raw expiry", async () => {
    const refreshed: OAuthCredentials = {
      type: "oauth",
      provider: "anthropic",
      access: "refreshed-access",
      refresh: "refresh-token",
      expires: BASE_NOW + 60 * 60 * 1000,
      idToken: undefined,
      scopes: undefined,
    };
    const refreshToken = vi.fn(async () => refreshed);

    const creds: OAuthCredentials = {
      type: "oauth",
      provider: "anthropic",
      access: "stale-access",
      refresh: "refresh-token",
      expires: BASE_NOW - 1000,
      idToken: undefined,
      scopes: undefined,
    };

    const result = await getOAuthApiKey("anthropic", { anthropic: creds });

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(result?.apiKey).toBe("refreshed-access");
  });
});
