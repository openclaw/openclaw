import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { aggregateRefreshableAuthStatus } from "./models-auth-status.js";

describe("aggregateRefreshableAuthStatus", () => {
  const NOW = 1_000_000;
  const expiring = NOW + 60_000; // 1 min in future

  function oauth(status: "ok" | "expiring" | "expired" | "missing", expiresAt?: number) {
    return {
      profileId: `p-${status}`,
      provider: "openai",
      type: "oauth" as const,
      status,
      expiresAt,
      remainingMs: expiresAt !== undefined ? expiresAt - NOW : undefined,
      source: "store" as const,
      label: `p-${status}`,
    };
  }

  function token(status: "ok" | "expiring" | "expired" | "missing" | "static", expiresAt?: number) {
    return {
      profileId: `t-${status}`,
      provider: "openai",
      type: "token" as const,
      status,
      expiresAt,
      remainingMs: expiresAt !== undefined ? expiresAt - NOW : undefined,
      source: "store" as const,
      label: `t-${status}`,
    };
  }

  it("ignores token profiles — healthy OAuth + expired token stays ok", () => {
    const result = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "expired",
        profiles: [oauth("ok", expiring + 10_000_000), token("expired")],
      },
      NOW,
    );
    expect(result.status).toBe("ok");
  });

  it("uses effective OAuth profiles while keeping stale inventory visible", () => {
    const healthy = oauth("ok", expiring + 10_000_000);
    const stale = oauth("expired", NOW - 1);
    const result = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "ok",
        effectiveProfiles: [healthy],
        profiles: [stale, healthy],
      },
      NOW,
    );
    expect(result.status).toBe("ok");
    expect(result.expiresAt).toBe(healthy.expiresAt);
  });

  it("falls back to prov.status when no OAuth profiles exist", () => {
    const result = aggregateRefreshableAuthStatus(
      {
        provider: "anthropic",
        status: "static",
        profiles: [
          {
            profileId: "anthropic:default",
            provider: "anthropic",
            type: "api_key",
            status: "static",
            source: "store",
            label: "anthropic:default",
          },
        ],
      },
      NOW,
    );
    expect(result.status).toBe("static");
  });

  it("keeps missing distinct from expired", () => {
    const expiredResult = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "expired",
        profiles: [oauth("expired", NOW - 1)],
      },
      NOW,
    );
    expect(expiredResult.status).toBe("expired");

    const missingResult = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "missing",
        profiles: [oauth("missing")],
      },
      NOW,
    );
    expect(missingResult.status).toBe("missing");
  });

  it("precedence: expired/missing > expiring > ok > static", () => {
    // expiring + ok → expiring (expired-marker absent)
    const res1 = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "expiring",
        profiles: [oauth("expiring", expiring), oauth("ok", expiring + 10_000_000)],
      },
      NOW,
    );
    expect(res1.status).toBe("expiring");

    // expired beats expiring
    const res2 = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "expired",
        profiles: [oauth("expired", NOW - 1), oauth("expiring", expiring)],
      },
      NOW,
    );
    expect(res2.status).toBe("expired");
  });

  it("picks the earliest expiresAt across OAuth profiles", () => {
    const earlier = NOW + 1_000;
    const later = NOW + 99_999;
    const result = aggregateRefreshableAuthStatus(
      {
        provider: "openai",
        status: "ok",
        profiles: [oauth("ok", later), oauth("ok", earlier)],
      },
      NOW,
    );
    expect(result.expiresAt).toBe(earlier);
    expect(result.remainingMs).toBe(1_000);
  });

  it.each([
    ["ok", undefined],
    ["expiring", expiring],
    ["expired", NOW - 1],
    ["missing", undefined],
    ["static", undefined],
  ] as const)(
    "uses token status %s when no effective OAuth profile exists",
    (status, expiresAt) => {
      const result = aggregateRefreshableAuthStatus(
        {
          provider: "claude-cli",
          status,
          profiles: [token(status, expiresAt)],
        },
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
      {
        provider: "claude-cli",
        status: "missing",
        effectiveProfiles: [],
        profiles: [token("ok")],
      },
      NOW,
      true,
    );
    expect(result).toEqual({ status: "missing" });
  });

  it("ignores out-of-range OAuth expiry timestamps", () => {
    const valid = NOW + 5_000;
    const result = aggregateRefreshableAuthStatus(
      {
        provider: "openai-codex",
        status: "ok",
        profiles: [oauth("ok", MAX_DATE_TIMESTAMP_MS + 1), oauth("ok", valid)],
      },
      NOW,
    );
    expect(result.expiresAt).toBe(valid);
    expect(result.remainingMs).toBe(5_000);
  });
});
