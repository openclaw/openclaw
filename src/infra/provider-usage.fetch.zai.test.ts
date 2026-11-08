import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchZaiUsage } from "./provider-usage.fetch.zai.js";
import { formatUsageWindowSummary } from "./provider-usage.format.js";

const fetchUsage = (body: unknown, status = 200) =>
  fetchZaiUsage(
    "key",
    5000,
    createProviderUsageFetch(async () => makeResponse(status, body)),
  );

describe("fetchZaiUsage", () => {
  it("reports HTTP failures", async () => {
    const result = await fetchUsage("unavailable", 503);
    expect(result.error).toBe("HTTP 503");
    expect(result.windows).toEqual([]);
  });

  it.each([
    [null, "API error"],
    [{ success: true, code: "200oops" }, "API error"],
    [{ success: false, code: 500, msg: "quota endpoint disabled" }, "quota endpoint disabled"],
  ])("reports invalid API payloads: %j", async (payload, error) => {
    const result = await fetchUsage(payload);
    expect(result.error).toBe(error);
    expect(result.windows).toEqual([]);
  });

  it("returns empty usage for missing data", async () => {
    expect(await fetchUsage({ success: true, code: 200 })).toEqual({
      provider: "zai",
      displayName: "z.ai",
      windows: [],
      plan: undefined,
    });
  });

  it.each([1_778_753_640_304, "2026-05-14T10:14:00.304Z"])(
    "preserves numeric and date-string quota resets in usage reports: %j",
    async (nextResetTime) => {
      // https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/docs/bigmodel-coding-plan-usage-quota.md
      const result = await fetchUsage({
        success: true,
        code: 200,
        data: {
          level: "lite",
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 1,
              nextResetTime,
            },
            {
              type: "TIME_LIMIT",
              unit: 5,
              number: 1,
              percentage: 0,
              nextResetTime: 1_781_345_721_976,
            },
          ],
        },
      });

      expect(result.windows).toEqual([
        { label: "Tokens (5h)", usedPercent: 1, resetAt: 1_778_753_640_304 },
        { label: "Monthly", usedPercent: 0, resetAt: 1_781_345_721_976 },
      ]);
      expect(
        formatUsageWindowSummary(result, {
          now: 1_778_750_040_304,
          maxWindows: 1,
          includeResets: true,
        }),
      ).toBe("Tokens (5h) 99% left ⏱1h");
    },
  );

  it("identifies weekly token quotas even when their optional reset is absent", async () => {
    const result = await fetchUsage({
      success: true,
      code: 200,
      data: {
        limits: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 20 }],
      },
    });

    expect(result.windows).toEqual([{ label: "Tokens (1w)", usedPercent: 20, resetAt: undefined }]);
  });

  it.each([
    undefined,
    null,
    8_640_000_000_000_001,
    -8_640_000_000_000_001,
    "1778753640304",
    "not-a-date",
    true,
    { timestamp: 1_778_753_640_304 },
  ])(
    "keeps quota visible without a reset for unsupported timestamps: %j",
    async (nextResetTime) => {
      const result = await fetchUsage({
        success: true,
        code: 200,
        data: {
          limits: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 20, nextResetTime }],
        },
      });
      expect(result.windows).toEqual([
        { label: "Tokens (1w)", usedPercent: 20, resetAt: undefined },
      ]);
    },
  );

  it.each([200, "200"])("retains quotas encoded as numeric strings with code %j", async (code) => {
    const result = await fetchUsage({
      success: true,
      code,
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: "45.6", unit: "6", number: "1" },
          { type: "TIME_LIMIT", percentage: "123", unit: "5", number: "1" },
        ],
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([
      { label: "Tokens (1w)", usedPercent: 45.6, resetAt: undefined },
      { label: "Monthly", usedPercent: 100, resetAt: undefined },
    ]);
  });

  it("normalizes valid limits without letting malformed siblings discard them", async () => {
    const reset = "2026-01-08T00:00:00Z";
    const result = await fetchUsage({
      success: true,
      code: 200,
      data: {
        plan: " Pro ",
        limits: [
          null,
          "invalid",
          { type: "OTHER_LIMIT", percentage: 50 },
          { type: "TOKENS_LIMIT", percentage: 32, unit: 3, number: 6, nextResetTime: reset },
          { type: "TOKENS_LIMIT", percentage: 8, unit: 5, number: 15, nextResetTime: "not-a-date" },
          { type: "TIME_LIMIT", percentage: 140, unit: 1, number: 30 },
          { type: "TOKENS_LIMIT", percentage: -5, unit: 99 },
          { type: "TOKENS_LIMIT", percentage: 10, unit: 3 },
          { type: "TIME_LIMIT", percentage: "40" },
          { type: "TOKENS_LIMIT", percentage: "45.6%", unit: "3hours", number: "123days" },
          { type: "TOKENS_LIMIT", percentage: " ", unit: "", number: " " },
        ],
      },
    });
    expect(result.plan).toBe("Pro");
    expect(result.windows).toEqual([
      { label: "Tokens (6h)", usedPercent: 32, resetAt: Date.parse(reset) },
      { label: "Tokens (15mo)", usedPercent: 8, resetAt: undefined },
      { label: "Monthly", usedPercent: 100, resetAt: undefined },
      { label: "Tokens (Limit)", usedPercent: 0, resetAt: undefined },
      { label: "Tokens (Limit)", usedPercent: 10, resetAt: undefined },
      { label: "Monthly", usedPercent: 40, resetAt: undefined },
      { label: "Tokens (Limit)", usedPercent: 0, resetAt: undefined },
      { label: "Tokens (Limit)", usedPercent: 0, resetAt: undefined },
    ]);
  });
});
