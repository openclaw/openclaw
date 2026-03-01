import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchCodexUsage } from "./provider-usage.fetch.codex.js";

describe("fetchCodexUsage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("returns token expired for auth failures", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(401, { error: "unauthorized" }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.error).toBe("Token expired");
    expect(result.windows).toHaveLength(0);
  });

  it("returns HTTP status errors for non-auth failures", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(429, { error: "throttled" }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.error).toBe("HTTP 429");
    expect(result.windows).toHaveLength(0);
  });

  it("parses windows, reset times, and plan balance", async () => {
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers["ChatGPT-Account-Id"]).toBe("acct-1");
      return makeResponse(200, {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 10_800,
            used_percent: 35.5,
            reset_at: 1_700_000_000,
          },
          secondary_window: {
            limit_window_seconds: 86_400,
            used_percent: 75,
            reset_at: 1_700_050_000,
          },
        },
        plan_type: "Plus",
        credits: { balance: "12.5" },
      });
    });

    const result = await fetchCodexUsage("token", "acct-1", 5000, mockFetch);

    expect(result.provider).toBe("openai-codex");
    expect(result.plan).toBe("Plus ($12.50)");
    expect(result.windows).toEqual([
      { label: "3h", usedPercent: 35.5, resetAt: 1_700_000_000_000 },
      { label: "Day", usedPercent: 75, resetAt: 1_700_050_000_000 },
    ]);
  });

  it("labels weekly secondary window as Week", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 10_800,
            used_percent: 7,
            reset_at: 1_700_000_000,
          },
          secondary_window: {
            limit_window_seconds: 604_800,
            used_percent: 10,
            reset_at: 1_700_500_000,
          },
        },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.windows).toEqual([
      { label: "3h", usedPercent: 7, resetAt: 1_700_000_000_000 },
      { label: "Week", usedPercent: 10, resetAt: 1_700_500_000_000 },
    ]);
  });

  it("labels secondary window as Week when reset horizon is multi-day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));

    const resetAtSec = Math.floor((Date.now() + (3 * 24 + 8) * 60 * 60 * 1000) / 1000);
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 10_800,
            used_percent: 45,
            reset_at: Math.floor((Date.now() + 2 * 60 * 60 * 1000) / 1000),
          },
          secondary_window: {
            limit_window_seconds: 86_400,
            used_percent: 85,
            reset_at: resetAtSec,
          },
        },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.windows?.[1]?.label).toBe("Week");
  });
});
