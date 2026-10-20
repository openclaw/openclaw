// Covers Codex provider usage fetch parsing.
import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchCodexUsage } from "./provider-usage.fetch.codex.js";

const window = (seconds: number, used: number, reset?: number) => ({
  limit_window_seconds: seconds,
  used_percent: used,
  ...(reset === undefined ? {} : { reset_at: reset }),
});
const fetchUsage = (data: unknown) =>
  fetchCodexUsage(
    "token",
    undefined,
    5000,
    createProviderUsageFetch(async () => makeResponse(200, data)),
  );

describe("fetchCodexUsage", () => {
  it("returns token expired for a 401 auth failure", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(401, { error: "unauthorized" }),
    );
    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.error).toBe("Token expired");
    expect(result.windows).toHaveLength(0);
  });

  it("parses windows, reset times, plan, and credit balance", async () => {
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers["ChatGPT-Account-Id"]).toBe("acct-1");
      expect(headers.originator).toBe("openclaw");
      expect(headers["User-Agent"]).toMatch(/^openclaw\//);
      return makeResponse(200, {
        rate_limit: {
          primary_window: window(10_800, 35.5, 1_700_000_000),
          secondary_window: window(86_400, 75, 1_700_050_000),
        },
        plan_type: "Plus",
        credits: { balance: "12.5" },
      });
    });

    const result = await fetchCodexUsage("token", "acct-1", 5000, mockFetch);

    expect(result.provider).toBe("openai");
    expect(result.plan).toBe("Plus");
    expect(result.billing).toEqual([{ type: "balance", amount: 12.5, unit: "credits" }]);
    expect(result.windows).toEqual([
      { label: "3h", usedPercent: 35.5, resetAt: 1_700_000_000_000 },
      { label: "Day", usedPercent: 75, resetAt: 1_700_050_000_000 },
    ]);
  });

  it("labels weekly secondary window as Week", async () => {
    const result = await fetchUsage({
      rate_limit: {
        primary_window: window(10_800, 7, 1_700_000_000),
        secondary_window: window(604_800, 10, 1_700_500_000),
      },
    });
    expect(result.windows).toEqual([
      { label: "3h", usedPercent: 7, resetAt: 1_700_000_000_000 },
      { label: "Week", usedPercent: 10, resetAt: 1_700_500_000_000 },
    ]);
  });

  it("labels secondary window as Week when reset cadence clearly exceeds one day", async () => {
    const primaryReset = 1_700_000_000;
    const weeklyLikeSecondaryReset = primaryReset + 5 * 24 * 60 * 60;
    // Observed in production: API reports 24h, but dashboard shows a weekly window.
    const result = await fetchUsage({
      rate_limit: {
        primary_window: window(10_800, 14, primaryReset),
        secondary_window: window(86_400, 20, weeklyLikeSecondaryReset),
      },
    });
    expect(result.windows).toEqual([
      { label: "3h", usedPercent: 14, resetAt: 1_700_000_000_000 },
      { label: "Week", usedPercent: 20, resetAt: weeklyLikeSecondaryReset * 1000 },
    ]);
  });

  it("labels short secondary windows in hours", async () => {
    const result = await fetchUsage({
      credits: { balance: "not-a-number" },
      rate_limit: { secondary_window: window(21_600, 11) },
    });
    expect(result.windows).toEqual([{ label: "6h", usedPercent: 11, resetAt: undefined }]);
    expect(result.billing).toBeUndefined();
  });
});
