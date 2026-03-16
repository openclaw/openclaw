import { describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import { ignoredErrors } from "./provider-usage.shared.js";

const resolveProviderUsageSnapshotWithPluginMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      provider: string;
      context: {
        token: string;
        accountId?: string;
        fetchFn: typeof fetch;
      };
    }) => {
      switch (params.provider) {
        case "github-copilot": {
          const response = await params.context.fetchFn(
            "https://api.github.com/copilot_internal/user",
          );
          const payload = (await response.json()) as {
            quota_snapshots?: { chat?: { percent_remaining?: number } };
          };
          const remaining = payload.quota_snapshots?.chat?.percent_remaining ?? 0;
          return {
            provider: "github-copilot",
            displayName: "Copilot",
            windows: [{ label: "Chat", usedPercent: 100 - remaining }],
          };
        }
        case "google-gemini-cli": {
          const modelsResponse = await params.context.fetchFn(
            "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
          );
          const quotaResponse = await params.context.fetchFn(
            "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
          );
          const modelsPayload = (await modelsResponse.json()) as {
            models?: Record<string, { quotaInfo?: { remainingFraction?: number } }>;
          };
          await quotaResponse.json();
          const remaining =
            modelsPayload.models?.["gemini-2.5-pro"]?.quotaInfo?.remainingFraction ?? 0;
          return {
            provider: "google-gemini-cli",
            displayName: "Gemini CLI",
            windows: [{ label: "Pro", usedPercent: Math.round((1 - remaining) * 100) }],
          };
        }
        case "openai-codex": {
          const response = await params.context.fetchFn(
            "https://chatgpt.com/backend-api/wham/usage",
          );
          const payload = (await response.json()) as {
            rate_limit?: {
              primary_window?: { used_percent?: number; limit_window_seconds?: number };
            };
          };
          return {
            provider: "openai-codex",
            displayName: "Codex",
            windows: [
              {
                label: "3h",
                usedPercent: payload.rate_limit?.primary_window?.used_percent ?? 0,
              },
            ],
          };
        }
        case "xiaomi":
          return {
            provider: "xiaomi",
            displayName: "Xiaomi",
            windows: [],
          };
        case "anthropic": {
          const response = await params.context.fetchFn(
            "https://api.anthropic.com/api/oauth/usage",
          );
          if (!response.ok) {
            return {
              provider: "anthropic",
              displayName: "Claude",
              windows: [],
              error: `HTTP ${response.status}`,
            };
          }
          return {
            provider: "anthropic",
            displayName: "Claude",
            windows: [],
          };
        }
        default:
          return null;
      }
    },
  ),
);

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderUsageSnapshotWithPlugin: (params: {
    provider: string;
    context: {
      token: string;
      accountId?: string;
      fetchFn: typeof fetch;
    };
  }) => resolveProviderUsageSnapshotWithPluginMock(params),
}));

const usageNow = Date.UTC(2026, 0, 7, 0, 0, 0);

type ProviderAuth = NonNullable<
  NonNullable<Parameters<typeof loadProviderUsageSummary>[0]>["auth"]
>[number];

async function loadUsageWithAuth(
  auth: ProviderAuth[],
  mockFetch: ReturnType<typeof createProviderUsageFetch>,
) {
  return await loadProviderUsageSummary({
    now: usageNow,
    auth,
    fetch: mockFetch as unknown as typeof fetch,
  });
}

describe("provider-usage.load", () => {
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
      [
        { provider: "github-copilot", token: "copilot-token" },
        { provider: "google-gemini-cli", token: "gemini-token" },
        { provider: "openai-codex", token: "codex-token", accountId: "acc-1" },
        { provider: "xiaomi", token: "xiaomi-token" },
      ],
      mockFetch,
    );

    expect(summary.providers.map((provider) => provider.provider)).toEqual([
      "github-copilot",
      "google-gemini-cli",
      "openai-codex",
      "xiaomi",
    ]);
    expect(
      summary.providers.find((provider) => provider.provider === "github-copilot")?.windows,
    ).toEqual([{ label: "Chat", usedPercent: 20 }]);
    expect(
      summary.providers.find((provider) => provider.provider === "google-gemini-cli")?.windows[0]
        ?.label,
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
    const summary = await loadUsageWithAuth([], mockFetch);
    expect(summary).toEqual({ updatedAt: usageNow, providers: [] });
  });

  it("returns unsupported provider snapshots for unknown provider ids", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadUsageWithAuth(
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
