import { describe, expect, it } from "vitest";
import type { AuthProviderHealth } from "../../agents/auth-health.js";
import { aggregateRefreshableAuthStatus } from "./models-auth-status.js";

describe("aggregateRefreshableAuthStatus", () => {
  const NOW = 1_000_000;
  const expiring = NOW + 60_000;

  function profile(
    type: "oauth" | "token" | "api_key",
    status: AuthProviderHealth["status"],
    expiresAt?: number,
  ): AuthProviderHealth["profiles"][number] {
    return {
      profileId: `${type}-${status}`,
      provider: "openai",
      type,
      status,
      expiresAt,
      remainingMs: expiresAt !== undefined ? expiresAt - NOW : undefined,
      source: "store",
      label: `${type}-${status}`,
    };
  }

  function provider(
    profiles: AuthProviderHealth["profiles"],
    overrides: Partial<AuthProviderHealth> = {},
  ): AuthProviderHealth {
    return { provider: "openai", status: "ok", profiles, ...overrides };
  }

  const healthy = profile("oauth", "ok", expiring + 10_000_000);
  it.each([
    [
      "OAuth ignores expired tokens and selects its earliest expiry",
      provider([healthy, profile("oauth", "ok", NOW + 1_000), profile("token", "expired")], {
        status: "expired",
      }),
      false,
      { status: "ok", expiresAt: NOW + 1_000, remainingMs: 1_000 },
    ],
    [
      "effective profiles exclude stale inventory",
      provider([profile("oauth", "expired", NOW - 1), healthy], { effectiveProfiles: [healthy] }),
      false,
      { status: "ok", expiresAt: healthy.expiresAt, remainingMs: healthy.remainingMs },
    ],
    [
      "API keys retain provider status",
      provider([profile("api_key", "static")], { status: "static" }),
      false,
      { status: "static" },
    ],
    [
      "missing OAuth remains distinct from expired",
      provider([profile("oauth", "missing")], { status: "missing" }),
      false,
      { status: "missing" },
    ],
    [
      "expiring precedes healthy OAuth",
      provider([profile("oauth", "expiring", expiring), healthy], { status: "expiring" }),
      false,
      { status: "expiring", expiresAt: expiring, remainingMs: 60_000 },
    ],
    [
      "expired precedes expiring OAuth",
      provider([profile("oauth", "expired", NOW - 1), profile("oauth", "expiring", expiring)], {
        status: "expired",
      }),
      false,
      { status: "expired", expiresAt: NOW - 1, remainingMs: -1 },
    ],
    [
      "expired token replaces OAuth",
      provider([profile("token", "expired", NOW - 1)], {
        provider: "claude-cli",
        status: "expired",
      }),
      true,
      { status: "expired", expiresAt: NOW - 1, remainingMs: -1 },
    ],
    [
      "static token replaces OAuth",
      provider([profile("token", "static")], { provider: "claude-cli", status: "static" }),
      true,
      { status: "static" },
    ],
    [
      "empty effective selection remains missing",
      provider([profile("token", "ok")], {
        provider: "claude-cli",
        status: "missing",
        effectiveProfiles: [],
      }),
      true,
      { status: "missing" },
    ],
  ] as const)("%s", (_name, health, expectsOAuth, expected) => {
    expect(aggregateRefreshableAuthStatus(health, NOW, expectsOAuth)).toEqual(expected);
  });
});
