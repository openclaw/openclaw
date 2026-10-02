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

  it("ignores token profiles — healthy OAuth + expired token stays ok", () => {
    const result = aggregateRefreshableAuthStatus(
      provider([profile("oauth", "ok", expiring + 10_000_000), profile("token", "expired")], {
        status: "expired",
      }),
      NOW,
    );
    expect(result.status).toBe("ok");
  });

  it("uses effective OAuth profiles while keeping stale inventory visible", () => {
    const healthy = profile("oauth", "ok", expiring + 10_000_000);
    const stale = profile("oauth", "expired", NOW - 1);
    const result = aggregateRefreshableAuthStatus(
      provider([stale, healthy], { effectiveProfiles: [healthy] }),
      NOW,
    );
    expect(result.status).toBe("ok");
    expect(result.expiresAt).toBe(healthy.expiresAt);
  });

  it("falls back to prov.status when no OAuth profiles exist", () => {
    const result = aggregateRefreshableAuthStatus(
      provider([profile("api_key", "static")], { status: "static" }),
      NOW,
    );
    expect(result.status).toBe("static");
  });

  it("keeps missing distinct from expired", () => {
    const expiredResult = aggregateRefreshableAuthStatus(
      provider([profile("oauth", "expired", NOW - 1)], { status: "expired" }),
      NOW,
    );
    expect(expiredResult.status).toBe("expired");
    const missingResult = aggregateRefreshableAuthStatus(
      provider([profile("oauth", "missing")], { status: "missing" }),
      NOW,
    );
    expect(missingResult.status).toBe("missing");
  });

  it("gives expired precedence over expiring and expiring over ok", () => {
    const expiringResult = aggregateRefreshableAuthStatus(
      provider(
        [profile("oauth", "expiring", expiring), profile("oauth", "ok", expiring + 10_000_000)],
        {
          status: "expiring",
        },
      ),
      NOW,
    );
    expect(expiringResult.status).toBe("expiring");
    const expiredResult = aggregateRefreshableAuthStatus(
      provider([profile("oauth", "expired", NOW - 1), profile("oauth", "expiring", expiring)], {
        status: "expired",
      }),
      NOW,
    );
    expect(expiredResult.status).toBe("expired");
  });

  it("picks the earliest expiresAt across OAuth profiles", () => {
    const earlier = NOW + 1_000;
    const later = NOW + 99_999;
    const result = aggregateRefreshableAuthStatus(
      provider([profile("oauth", "ok", later), profile("oauth", "ok", earlier)]),
      NOW,
    );
    expect(result.expiresAt).toBe(earlier);
    expect(result.remainingMs).toBe(1_000);
  });

  it.each([
    ["expired", NOW - 1],
    ["static", undefined],
  ] as const)(
    "uses token status %s when no effective OAuth profile exists",
    (status, expiresAt) => {
      const result = aggregateRefreshableAuthStatus(
        provider([profile("token", status, expiresAt)], { provider: "claude-cli", status }),
        NOW,
        true,
      );
      expect(result).toEqual({
        status,
        ...(expiresAt === undefined ? {} : { expiresAt, remainingMs: expiresAt - NOW }),
      });
    },
  );

  it("keeps an empty effective profile selection missing", () => {
    const result = aggregateRefreshableAuthStatus(
      provider([profile("token", "ok")], {
        provider: "claude-cli",
        status: "missing",
        effectiveProfiles: [],
      }),
      NOW,
      true,
    );
    expect(result).toEqual({ status: "missing" });
  });
});
