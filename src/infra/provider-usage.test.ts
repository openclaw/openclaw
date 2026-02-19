import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import {
  formatUsageReportLines,
  formatUsageSummaryLine,
  loadProviderUsageSummary,
  type UsageSummary,
} from "./provider-usage.js";
import { ignoredErrors } from "./provider-usage.shared.js";

const minimaxRemainsEndpoint = "api.minimaxi.com/v1/api/openplatform/coding_plan/remains";
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

function expectSingleAnthropicProvider(summary: UsageSummary) {
  expect(summary.providers).toHaveLength(1);
  const claude = summary.providers[0];
  expect(claude?.provider).toBe("anthropic");
  return claude;
}

function createMinimaxOnlyFetch(payload: unknown) {
  return createProviderUsageFetch(async (url) => {
    if (url.includes(minimaxRemainsEndpoint)) {
      return makeResponse(200, payload);
    }
    return makeResponse(404, "not found");
  });
}

async function expectMinimaxUsage(
  payload: unknown,
  expectedUsedPercent: number,
  expectedPlan?: string,
) {
  const mockFetch = createMinimaxOnlyFetch(payload);

  const summary = await loadUsageWithAuth([{ provider: "minimax", token: "token-1b" }], mockFetch);

  const minimax = summary.providers.find((p) => p.provider === "minimax");
  expect(minimax?.windows[0]?.usedPercent).toBe(expectedUsedPercent);
  if (expectedPlan !== undefined) {
    expect(minimax?.plan).toBe(expectedPlan);
  }
  expect(mockFetch).toHaveBeenCalled();
}

describe("provider usage formatting", () => {
  it("returns null when no usage is available", () => {
    const summary: UsageSummary = { updatedAt: 0, providers: [] };
    expect(formatUsageSummaryLine(summary)).toBeNull();
  });

  it("picks the most-used window for summary line", () => {
    const summary: UsageSummary = {
      updatedAt: 0,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [
            { label: "5h", usedPercent: 10 },
            { label: "Week", usedPercent: 60 },
          ],
        },
      ],
    };
    const line = formatUsageSummaryLine(summary, { now: 0 });
    expect(line).toContain("Claude");
    expect(line).toContain("40% left");
    expect(line).toContain("(Week");
  });

  it("prints provider errors in report output", () => {
    const summary: UsageSummary = {
      updatedAt: 0,
      providers: [
        {
          provider: "openai-codex",
          displayName: "Codex",
          windows: [],
          error: "Token expired",
        },
      ],
    };
    const lines = formatUsageReportLines(summary);
    expect(lines.join("\n")).toContain("Codex: Token expired");
  });

  it("includes reset countdowns in report lines", () => {
    const now = Date.UTC(2026, 0, 7, 0, 0, 0);
    const summary: UsageSummary = {
      updatedAt: now,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [{ label: "5h", usedPercent: 20, resetAt: now + 60_000 }],
        },
      ],
    };
    const lines = formatUsageReportLines(summary, { now });
    expect(lines.join("\n")).toContain("resets 1m");
  });
});

describe("provider usage loading", () => {
  it("loads usage snapshots with injected auth", async () => {
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("api.anthropic.com")) {
        return makeResponse(200, {
          five_hour: { utilization: 20, resets_at: "2026-01-07T01:00:00Z" },
        });
      }
      if (url.includes("api.z.ai")) {
        return makeResponse(200, {
          success: true,
          code: 200,
          data: {
            planName: "Pro",
            limits: [
              {
                type: "TOKENS_LIMIT",
                percentage: 25,
                unit: 3,
                number: 6,
                nextResetTime: "2026-01-07T06:00:00Z",
              },
            ],
          },
        });
      }
      if (url.includes(minimaxRemainsEndpoint)) {
        return makeResponse(200, {
          base_resp: { status_code: 0, status_msg: "ok" },
          data: {
            total: 200,
            remain: 50,
            reset_at: "2026-01-07T05:00:00Z",
            plan_name: "Coding Plan",
          },
        });
      }
      return makeResponse(404, "not found");
    });

    const summary = await loadUsageWithAuth(
      [
        { provider: "anthropic", token: "token-1" },
        { provider: "minimax", token: "token-1b" },
        { provider: "zai", token: "token-2" },
      ],
      mockFetch,
    );

    expect(summary.providers).toHaveLength(3);
    const claude = summary.providers.find((p) => p.provider === "anthropic");
    const minimax = summary.providers.find((p) => p.provider === "minimax");
    const zai = summary.providers.find((p) => p.provider === "zai");
    expect(claude?.windows[0]?.label).toBe("5h");
    expect(minimax?.windows[0]?.usedPercent).toBe(75);
    expect(zai?.plan).toBe("Pro");
    expect(mockFetch).toHaveBeenCalled();
  });

  it("handles nested MiniMax usage payloads", async () => {
    await expectMinimaxUsage(
      {
        base_resp: { status_code: 0, status_msg: "ok" },
        data: {
          plan_name: "Coding Plan",
          usage: {
            prompt_limit: 200,
            prompt_remain: 50,
            next_reset_time: "2026-01-07T05:00:00Z",
          },
        },
      },
      75,
      "Coding Plan",
    );
  });

  it("prefers MiniMax count-based usage when percent looks inverted", async () => {
    await expectMinimaxUsage(
      {
        base_resp: { status_code: 0, status_msg: "ok" },
        data: {
          prompt_limit: 200,
          prompt_remain: 150,
          usage_percent: 75,
          next_reset_time: "2026-01-07T05:00:00Z",
        },
      },
      25,
    );
  });

  it("handles MiniMax model_remains usage payloads", async () => {
    await expectMinimaxUsage(
      {
        base_resp: { status_code: 0, status_msg: "ok" },
        model_remains: [
          {
            start_time: 1736217600,
            end_time: 1736235600,
            remains_time: 600,
            current_interval_total_count: 120,
            current_interval_usage_count: 30,
            model_name: "MiniMax-M2.1",
          },
        ],
      },
      25,
    );
  });

  it("discovers Claude usage from token auth profiles", async () => {
    await withTempHome(
      async (tempHome) => {
        const agentDir = path.join(
          process.env.OPENCLAW_STATE_DIR ?? path.join(tempHome, ".openclaw"),
          "agents",
          "main",
          "agent",
        );
        fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(agentDir, "auth-profiles.json"),
          `${JSON.stringify(
            {
              version: 1,
              order: { anthropic: ["anthropic:default"] },
              profiles: {
                "anthropic:default": {
                  type: "token",
                  provider: "anthropic",
                  token: "token-1",
                  expires: Date.UTC(2100, 0, 1, 0, 0, 0),
                },
              },
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        const store = ensureAuthProfileStore(agentDir, {
          allowKeychainPrompt: false,
        });
        expect(listProfilesForProvider(store, "anthropic")).toContain("anthropic:default");

        const mockFetch = createProviderUsageFetch(async (url, init) => {
          if (url.includes("api.anthropic.com/api/oauth/usage")) {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            expect(headers.Authorization).toBe("Bearer token-1");
            return makeResponse(200, {
              five_hour: {
                utilization: 20,
                resets_at: "2026-01-07T01:00:00Z",
              },
            });
          }
          return makeResponse(404, "not found");
        });

        const summary = await loadProviderUsageSummary({
          now: usageNow,
          providers: ["anthropic"],
          agentDir,
          fetch: mockFetch as unknown as typeof fetch,
        });

        const claude = expectSingleAnthropicProvider(summary);
        expect(claude?.windows[0]?.label).toBe("5h");
        expect(mockFetch).toHaveBeenCalled();
      },
      {
        env: {
          OPENCLAW_STATE_DIR: (home) => path.join(home, ".openclaw"),
        },
        prefix: "openclaw-provider-usage-",
      },
    );
  });

  it("falls back to claude.ai web usage when OAuth scope is missing", async () => {
    const cookieSnapshot = process.env.CLAUDE_AI_SESSION_KEY;
    process.env.CLAUDE_AI_SESSION_KEY = "sk-ant-web-1";
    try {
      const mockFetch = createProviderUsageFetch(async (url) => {
        if (url.includes("api.anthropic.com/api/oauth/usage")) {
          return makeResponse(403, {
            type: "error",
            error: {
              type: "permission_error",
              message: "OAuth token does not meet scope requirement user:profile",
            },
          });
        }
        if (url.includes("claude.ai/api/organizations/org-1/usage")) {
          return makeResponse(200, {
            five_hour: { utilization: 20, resets_at: "2026-01-07T01:00:00Z" },
            seven_day: { utilization: 40, resets_at: "2026-01-08T01:00:00Z" },
            seven_day_opus: { utilization: 5 },
          });
        }
        if (url.includes("claude.ai/api/organizations")) {
          return makeResponse(200, [{ uuid: "org-1", name: "Test" }]);
        }
        return makeResponse(404, "not found");
      });

      const summary = await loadUsageWithAuth(
        [{ provider: "anthropic", token: "sk-ant-oauth-1" }],
        mockFetch,
      );

      const claude = expectSingleAnthropicProvider(summary);
      expect(claude?.windows.some((w) => w.label === "5h")).toBe(true);
      expect(claude?.windows.some((w) => w.label === "Week")).toBe(true);
    } finally {
      if (cookieSnapshot === undefined) {
        delete process.env.CLAUDE_AI_SESSION_KEY;
      } else {
        process.env.CLAUDE_AI_SESSION_KEY = cookieSnapshot;
      }
    }
  });

  it("loads snapshots for copilot antigravity gemini codex and xiaomi", async () => {
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("api.github.com/copilot_internal/user")) {
        return makeResponse(200, {
          quota_snapshots: { chat: { percent_remaining: 80 } },
          copilot_plan: "Copilot Pro",
        });
      }
      if (url.includes("cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")) {
        return makeResponse(200, {
          availablePromptCredits: 80,
          planInfo: { monthlyPromptCredits: 100 },
          currentTier: { name: "Antigravity Pro" },
          cloudaicompanionProject: "projects/demo",
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
        { provider: "google-antigravity", token: "antigravity-token" },
        { provider: "google-gemini-cli", token: "gemini-token" },
        { provider: "openai-codex", token: "codex-token", accountId: "acc-1" },
        { provider: "xiaomi", token: "xiaomi-token" },
      ],
      mockFetch,
    );

    expect(summary.providers.map((provider) => provider.provider)).toEqual([
      "github-copilot",
      "google-antigravity",
      "google-gemini-cli",
      "openai-codex",
      "xiaomi",
    ]);
    expect(
      summary.providers.find((provider) => provider.provider === "github-copilot")?.windows,
    ).toEqual([{ label: "Chat", usedPercent: 20 }]);
    expect(
      summary.providers.find((provider) => provider.provider === "google-antigravity")?.windows
        .length,
    ).toBeGreaterThan(0);
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
