import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchZaiUsage } from "./provider-usage.fetch.zai.js";
import { formatUsageWindowSummary } from "./provider-usage.format.js";

const fetchUsage = (body: unknown, status = 200) =>
  fetchZaiUsage(
    "key",
    5000,
    createProviderUsageFetch(async () => makeResponse(status, body)),
  );
const quota = (limits: unknown[], metadata = {}) =>
  fetchUsage({ success: true, code: 200, data: { limits, ...metadata } });
const limit = (
  type: string,
  percentage: unknown,
  unit?: number,
  number?: number,
  nextResetTime?: unknown,
) => ({ type, percentage, unit, number, nextResetTime });
const tokens = (percentage: unknown, unit?: number, number?: number, nextResetTime?: unknown) =>
  limit("TOKENS_LIMIT", percentage, unit, number, nextResetTime);
const window = (label: string, usedPercent: number, resetAt?: number) => ({
  label,
  usedPercent,
  resetAt,
});

describe("fetchZaiUsage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports HTTP failures", async () => {
    const result = await fetchUsage("unavailable", 503);
    expect(result).toMatchObject({ error: "HTTP 503", windows: [] });
  });

  it.each([
    [null, "API error"],
    [{ success: false, code: 500, msg: "quota endpoint disabled" }, "quota endpoint disabled"],
  ])("reports invalid API payloads: %j", async (payload, error) => {
    const result = await fetchUsage(payload);
    expect(result).toMatchObject({ error, windows: [] });
  });

  it("returns empty usage for missing data", async () => {
    expect(await fetchUsage({ success: true, code: 200 })).toEqual({
      provider: "zai",
      displayName: "z.ai",
      windows: [],
      plan: undefined,
    });
  });

  it("preserves the documented quota reset timestamps in usage reports", async () => {
    // https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/docs/bigmodel-coding-plan-usage-quota.md
    const result = await quota(
      [tokens(1, 3, 5, 1_778_753_640_304), limit("TIME_LIMIT", 0, 5, 1, 1_781_345_721_976)],
      { level: "lite" },
    );

    expect(result.windows).toEqual([
      window("Tokens (5h)", 1, 1_778_753_640_304),
      window("Monthly", 0, 1_781_345_721_976),
    ]);
    vi.spyOn(Date, "now").mockReturnValue(1_778_750_040_304);
    expect(formatUsageWindowSummary({ ...result, windows: result.windows.slice(0, 1) })).toBe(
      "Tokens (5h) 99% left ⏱1h",
    );
  });

  it.each([
    undefined,
    8_640_000_000_000_001,
    "1778753640304",
    true,
    { timestamp: 1_778_753_640_304 },
  ])(
    "keeps quota visible without a reset for unsupported timestamps: %j",
    async (nextResetTime) => {
      const result = await quota([tokens(20, 6, 1, nextResetTime)]);
      expect(result.windows).toEqual([window("Tokens (1w)", 20)]);
    },
  );

  it("normalizes valid limits without letting malformed siblings discard them", async () => {
    const reset = "2026-01-08T00:00:00Z";
    const result = await quota(
      [
        null,
        "invalid",
        { type: "OTHER_LIMIT", percentage: 50 },
        tokens(32, 3, 6, reset),
        tokens(8, 5, 15, "not-a-date"),
        limit("TIME_LIMIT", 140, 1, 30),
        tokens(-5, 99),
        tokens(10, 3),
        limit("TIME_LIMIT", "40"),
      ],
      { plan: " Pro " },
    );
    expect(result.plan).toBe("Pro");
    expect(result.windows).toEqual([
      window("Tokens (6h)", 32, Date.parse(reset)),
      window("Tokens (15mo)", 8),
      window("Monthly", 100),
      window("Tokens (Limit)", 0),
      window("Tokens (Limit)", 10),
      window("Monthly", 0),
    ]);
  });
});
