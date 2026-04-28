import { describe, expect, it } from "vitest";
import {
  buildAuthListProfileRows,
  formatAuthListText,
} from "./auth-list.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";

describe("auth list", () => {
  it("summarises auth profiles without exposing secrets", () => {
    const now = Date.UTC(2026, 3, 28, 12);
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:work": {
          type: "oauth",
          provider: "openai",
          access: "fake-oauth-access",
          refresh: "fake-oauth-refresh",
          expires: now + 60 * 60 * 1000,
          email: "user@example.com",
        },
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "fake-api-key-value",
        },
        "minimax:ref": {
          type: "token",
          provider: "minimax",
          tokenRef: { source: "env", provider: "default", id: "MINIMAX_TOKEN" },
        },
      },
    };

    const profiles = buildAuthListProfileRows(store, now);
    expect(profiles).toEqual([
      {
        id: "anthropic:default",
        provider: "anthropic",
        type: "api_key",
        account: null,
        credential: "api-key",
        status: "ok",
        expiresAt: null,
      },
      {
        id: "minimax:ref",
        provider: "minimax",
        type: "token",
        account: null,
        credential: "token-ref",
        status: "ok",
        expiresAt: null,
      },
      {
        id: "openai:work",
        provider: "openai",
        type: "oauth",
        account: "user@example.com",
        credential: "oauth",
        status: "expires in 1h",
        expiresAt: now + 60 * 60 * 1000,
      },
    ]);

    const text = formatAuthListText({
      agentId: "main",
      agentDir: "/tmp/openclaw-agent",
      storePath: "/tmp/openclaw-agent/auth-profiles.json",
      profiles,
    });

    expect(text).toContain("anthropic:default");
    expect(text).toContain("api-key");
    expect(text).toContain("oauth");
    expect(text).not.toContain("fake-api-key-value");
    expect(text).not.toContain("fake-oauth-access");
    expect(text).not.toContain("fake-oauth-refresh");
  });

  it("marks unusable profiles before expiry status", () => {
    const now = Date.UTC(2026, 3, 28, 12);
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "fake-api-key-value",
        },
      },
      usageStats: {
        "anthropic:default": {
          cooldownUntil: now + 30 * 60 * 1000,
        },
      },
    };

    expect(buildAuthListProfileRows(store, now)[0]?.status).toBe("cooldown 30m");
  });
});
