import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchZaiUsage } from "./provider-usage.fetch.zai.js";

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
        ],
      },
    });
    expect(result.plan).toBe("Pro");
    expect(result.windows).toEqual([
      { label: "Tokens (6h)", usedPercent: 32, resetAt: Date.parse(reset) },
      { label: "Tokens (15m)", usedPercent: 8, resetAt: undefined },
      { label: "Monthly", usedPercent: 100, resetAt: undefined },
      { label: "Tokens (Limit)", usedPercent: 0, resetAt: undefined },
      { label: "Tokens (Limit)", usedPercent: 10, resetAt: undefined },
      { label: "Monthly", usedPercent: 0, resetAt: undefined },
    ]);
  });
});
