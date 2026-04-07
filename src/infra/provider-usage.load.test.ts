import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import { ignoredErrors } from "./provider-usage.shared.js";
import {
  loadUsageWithAuth,
  type ProviderUsageAuth,
  usageNow,
} from "./provider-usage.test-support.js";

type ProviderAuth = ProviderUsageAuth<typeof loadProviderUsageSummary>;
const googleGeminiCliProvider = "google-gemini-cli" as unknown as ProviderAuth["provider"];

describe("provider-usage.load", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads snapshots for copilot gemini codex and xiaomi", async () => {
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("api.github.com/copilot_internal/user")) {
        return makeResponse(200, {
          quota_snapshots: { chat: { percent_remaining: 80 } },
          copilot_plan: "Copilot Pro",
        });
      }
      if (url.includes("cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")) {
        return makeResponse(200, {
          models: {
            "gemini-2.5-pro": {
              quotaInfo: { remainingFraction: 0.4, resetTime: "2026-01-08T01:00:00Z" },
            },
          },
        });
      }
      if (url.includes("cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")) {
        return makeResponse(200, {
          buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.6 }],
        });
      }
      if (url.includes("chatgpt.com/backend-api/wham/usage")) {
        return makeResponse(200, {
          rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 10800 } },
          plan_type: "Plus",
        });
      }
      return makeResponse(404, "not found");
    });

    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [
        { provider: "github-copilot", token: "copilot-token" },
        { provider: googleGeminiCliProvider, token: "gemini-token" },
        { provider: "openai-codex", token: "codex-token", accountId: "acc-1" },
        { provider: "xiaomi", token: "xiaomi-token" },
      ],
      mockFetch,
    );

    expect(summary.providers.map((provider) => provider.provider)).toEqual([
      "github-copilot",
      googleGeminiCliProvider,
      "openai-codex",
      "xiaomi",
    ]);
    expect(
      summary.providers.find((provider) => provider.provider === "github-copilot")?.windows,
    ).toEqual([{ label: "Chat", usedPercent: 20 }]);
    expect(
      summary.providers.find((provider) => provider.provider === googleGeminiCliProvider)
        ?.windows[0]?.label,
    ).toBe("Pro");
    expect(
      summary.providers.find((provider) => provider.provider === "openai-codex")?.windows[0]?.label,
    ).toBe("3h");
    expect(summary.providers.find((provider) => provider.provider === "xiaomi")?.windows).toEqual(
      [],
    );
  });

  it("returns empty provider list when auth resolves to none", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadUsageWithAuth(loadProviderUsageSummary, [], mockFetch);
    expect(summary).toEqual({ updatedAt: usageNow, providers: [] });
  });

  it("returns unsupported provider snapshots for unknown provider ids", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [{ provider: "unsupported-provider", token: "token-u" }] as unknown as ProviderAuth[],
      mockFetch,
    );
    expect(summary.providers).toHaveLength(1);
    expect(summary.providers[0]?.error).toBe("Unsupported provider");
  });

  it("filters errors that are marked as ignored", async () => {
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("api.anthropic.com/api/oauth/usage")) {
        return makeResponse(500, "boom");
      }
      return makeResponse(404, "not found");
    });
    ignoredErrors.add("HTTP 500");
    try {
      const summary = await loadUsageWithAuth(
        loadProviderUsageSummary,
        [{ provider: "anthropic", token: "token-a" }],
        mockFetch,
      );
      expect(summary.providers).toEqual([]);
    } finally {
      ignoredErrors.delete("HTTP 500");
    }
  });

  it("throws when fetch is unavailable", async () => {
    const previousFetch = globalThis.fetch;
    vi.stubGlobal("fetch", undefined);
    try {
      await expect(
        loadProviderUsageSummary({
          now: usageNow,
          auth: [{ provider: "xiaomi", token: "token-x" }],
          fetch: undefined,
        }),
      ).rejects.toThrow("fetch is not available");
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });
});
