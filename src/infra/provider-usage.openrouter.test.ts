import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  listProfilesForProvider: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  listProfilesForProvider: mocks.listProfilesForProvider,
  resolveApiKeyForProfile: mocks.resolveApiKeyForProfile,
}));

import { loadOpenRouterMeteredUsage } from "./provider-usage.openrouter.js";

describe("loadOpenRouterMeteredUsage", () => {
  it("returns null when no openrouter profiles are available", async () => {
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    try {
      // Clear env var to ensure test is environment-independent
      delete process.env.OPENROUTER_API_KEY;

      mocks.ensureAuthProfileStore.mockReturnValue({ profiles: {} });
      mocks.listProfilesForProvider.mockReturnValue([]);

      const usage = await loadOpenRouterMeteredUsage({
        fetch: vi.fn(),
      });

      expect(usage).toBeNull();
    } finally {
      // Restore original env var
      if (originalApiKey !== undefined) {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
    }
  });

  it("loads account and per-key usage with single key", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "openrouter:general": { type: "api_key", provider: "openrouter", key: "sk-or-general" },
      },
    });
    mocks.listProfilesForProvider.mockReturnValue(["openrouter:general"]);
    mocks.resolveApiKeyForProfile.mockResolvedValueOnce({ apiKey: "sk-or-general" });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const authHeader = String((init?.headers as Record<string, string>)?.Authorization ?? "");

      if (url.endsWith("/credits")) {
        return new Response(
          JSON.stringify({
            data: {
              total_credits: 185,
              total_usage: 165.152830593,
            },
          }),
          { status: 200 },
        );
      }

      if (url.endsWith("/auth/key") && authHeader.includes("sk-or-general")) {
        return new Response(
          JSON.stringify({
            data: {
              label: "general",
              is_management_key: false,
              is_provisioning_key: false,
              limit: 30,
              limit_reset: "daily",
              limit_remaining: -10,
              include_byok_in_limit: false,
              usage: 163.38,
              usage_daily: 88.5,
              usage_weekly: 163.38,
              usage_monthly: 163.38,
              byok_usage: 0,
              byok_usage_daily: 0,
              byok_usage_weekly: 0,
              byok_usage_monthly: 0,
              is_free_tier: false,
              expires_at: null,
            },
          }),
          { status: 200 },
        );
      }

      return new Response("{}", { status: 404 });
    });

    const usage = await loadOpenRouterMeteredUsage({
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(usage).toBeTruthy();
    expect(usage?.kind).toBe("metered");
    expect(usage?.account?.totalCredits).toBe(185);
    expect(usage?.account?.remainingCredits).toBeCloseTo(19.847169, 3);
    expect(usage?.keys).toHaveLength(1);
    expect(usage?.keys[0]?.profileId).toBe("openrouter:general");
  });

  it("omits account data when multiple keys are present (ambiguous account ownership)", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "openrouter:general": { type: "api_key", provider: "openrouter", key: "sk-or-general" },
        "openrouter:embeddings": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-or-embeddings",
        },
      },
    });
    mocks.listProfilesForProvider.mockReturnValue(["openrouter:general", "openrouter:embeddings"]);
    mocks.resolveApiKeyForProfile
      .mockResolvedValueOnce({ apiKey: "sk-or-general" })
      .mockResolvedValueOnce({ apiKey: "sk-or-embeddings" });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const authHeader = String((init?.headers as Record<string, string>)?.Authorization ?? "");

      if (url.endsWith("/credits")) {
        return new Response(
          JSON.stringify({
            data: {
              total_credits: 185,
              total_usage: 165.152830593,
            },
          }),
          { status: 200 },
        );
      }

      if (url.endsWith("/auth/key") && authHeader.includes("sk-or-general")) {
        return new Response(
          JSON.stringify({
            data: {
              label: "general",
              is_management_key: false,
              is_provisioning_key: false,
              limit: 30,
              limit_reset: "daily",
              limit_remaining: -10,
              include_byok_in_limit: false,
              usage: 163.38,
              usage_daily: 88.5,
              usage_weekly: 163.38,
              usage_monthly: 163.38,
              byok_usage: 0,
              byok_usage_daily: 0,
              byok_usage_weekly: 0,
              byok_usage_monthly: 0,
              is_free_tier: false,
              expires_at: null,
            },
          }),
          { status: 200 },
        );
      }

      if (url.endsWith("/auth/key") && authHeader.includes("sk-or-embeddings")) {
        return new Response(
          JSON.stringify({
            data: {
              label: "embeddings",
              is_management_key: false,
              is_provisioning_key: false,
              limit: null,
              limit_reset: null,
              limit_remaining: null,
              include_byok_in_limit: false,
              usage: 0.04230664,
              usage_daily: 0.00019885,
              usage_weekly: 0.04230664,
              usage_monthly: 0.04230664,
              byok_usage: 0,
              byok_usage_daily: 0,
              byok_usage_weekly: 0,
              byok_usage_monthly: 0,
              is_free_tier: false,
              expires_at: null,
            },
          }),
          { status: 200 },
        );
      }

      return new Response("{}", { status: 404 });
    });

    const usage = await loadOpenRouterMeteredUsage({
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(usage).toBeTruthy();
    expect(usage?.kind).toBe("metered");
    expect(usage?.account).toBeUndefined(); // Account data omitted for multi-key setups
    expect(usage?.keys).toHaveLength(2);
    expect(usage?.keys[0]?.profileId).toBe("openrouter:general");
    expect(usage?.keys[1]?.profileId).toBe("openrouter:embeddings");
  });
});
