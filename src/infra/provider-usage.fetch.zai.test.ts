// Covers Z.ai provider usage fetch parsing.
import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchZaiUsage } from "./provider-usage.fetch.zai.js";

async function fetchUsage(body: unknown, status = 200) {
  return await fetchZaiUsage(
    "key",
    5000,
    createProviderUsageFetch(async () => makeResponse(status, body)),
  );
}

describe("fetchZaiUsage", () => {
  it("returns HTTP errors for failed requests", async () => {
    const result = await fetchUsage("unavailable", 503);

    expect(result.error).toBe("HTTP 503");
    expect(result.windows).toHaveLength(0);
  });

  it("returns a stable error for malformed successful usage JSON", async () => {
    const result = await fetchUsage("{not json");

    expect(result.error).toBe("Malformed usage response");
    expect(result.windows).toHaveLength(0);
  });

  it.each([
    ["null", null],
    ["array", []],
  ])("returns a stable API error for a successful %s payload", async (_name, payload) => {
    const result = await fetchUsage(payload);

    expect(result.error).toBe("API error");
    expect(result.windows).toHaveLength(0);
  });

  it.each([
    ["missing data", { success: true, code: 200 }],
    ["object limits", { success: true, code: 200, data: { limits: {} } }],
  ])("treats successful payloads with %s as empty usage", async (_name, payload) => {
    const result = await fetchUsage(payload);

    expect(result).toEqual({
      provider: "zai",
      displayName: "z.ai",
      windows: [],
      plan: undefined,
    });
  });

  it("returns API message errors for unsuccessful payloads", async () => {
    const result = await fetchUsage({
      success: false,
      code: 500,
      msg: "quota endpoint disabled",
    });
    expect(result.error).toBe("quota endpoint disabled");
    expect(result.windows).toHaveLength(0);
  });

  it("falls back to a generic API error for blank unsuccessful messages", async () => {
    const result = await fetchUsage({
      success: false,
      code: 500,
      msg: "   ",
    });
    expect(result.error).toBe("API error");
    expect(result.windows).toHaveLength(0);
  });

  it("parses token and monthly windows with reset times", async () => {
    const tokenReset = "2026-01-08T00:00:00Z";
    const minuteReset = "2026-01-08T00:30:00Z";
    const monthlyReset = "2026-01-31T12:00:00Z";
    const result = await fetchUsage({
      success: true,
      code: 200,
      data: {
        planName: "Team",
        limits: [
          {
            type: "TOKENS_LIMIT",
            percentage: 32,
            unit: 3,
            number: 6,
            nextResetTime: tokenReset,
          },
          {
            type: "TOKENS_LIMIT",
            percentage: 8,
            unit: 5,
            number: 15,
            nextResetTime: minuteReset,
          },
          {
            type: "TIME_LIMIT",
            percentage: 12.5,
            unit: 1,
            number: 30,
            nextResetTime: monthlyReset,
          },
        ],
      },
    });

    expect(result.plan).toBe("Team");
    expect(result.windows).toEqual([
      {
        label: "Tokens (6h)",
        usedPercent: 32,
        resetAt: new Date(tokenReset).getTime(),
      },
      {
        label: "Tokens (15m)",
        usedPercent: 8,
        resetAt: new Date(minuteReset).getTime(),
      },
      {
        label: "Monthly",
        usedPercent: 12.5,
        resetAt: new Date(monthlyReset).getTime(),
      },
    ]);
  });

  it("clamps invalid percentages and falls back to alternate plan fields", async () => {
    const result = await fetchUsage({
      success: true,
      code: 200,
      data: {
        plan: "Pro",
        limits: [
          {
            type: "TOKENS_LIMIT",
            percentage: -5,
            unit: 99,
          },
          {
            type: "TIME_LIMIT",
            percentage: 140,
          },
          {
            type: "OTHER_LIMIT",
            percentage: 50,
          },
        ],
      },
    });

    expect(result.plan).toBe("Pro");
    expect(result.windows).toEqual([
      {
        label: "Tokens (Limit)",
        usedPercent: 0,
        resetAt: undefined,
      },
      {
        label: "Monthly",
        usedPercent: 100,
        resetAt: undefined,
      },
    ]);
  });

  it("skips malformed limit entries while preserving valid siblings", async () => {
    const result = await fetchUsage({
      success: true,
      code: 200,
      data: {
        planName: " Team ",
        limits: [
          null,
          "not-an-object",
          {
            type: "TOKENS_LIMIT",
            percentage: 25,
            unit: 3,
            number: 6,
          },
          {
            type: "TOKENS_LIMIT",
            percentage: 10,
            unit: 3,
          },
          {
            type: "TIME_LIMIT",
            percentage: "40",
          },
        ],
      },
    });

    expect(result.plan).toBe("Team");
    expect(result.windows).toEqual([
      {
        label: "Tokens (6h)",
        usedPercent: 25,
        resetAt: undefined,
      },
      {
        label: "Tokens (Limit)",
        usedPercent: 10,
        resetAt: undefined,
      },
      {
        label: "Monthly",
        usedPercent: 0,
        resetAt: undefined,
      },
    ]);
  });

  it("ignores invalid nextResetTime while preserving valid ISO resets", async () => {
    const validReset = "2026-01-08T00:00:00Z";
    const result = await fetchUsage({
      success: true,
      code: 200,
      data: {
        planName: "Team",
        limits: [
          {
            type: "TOKENS_LIMIT",
            percentage: 20,
            unit: 3,
            number: 6,
            nextResetTime: "not-a-date",
          },
          {
            type: "TIME_LIMIT",
            percentage: 40,
            nextResetTime: validReset,
          },
        ],
      },
    });

    expect(result.windows).toEqual([
      {
        label: "Tokens (6h)",
        usedPercent: 20,
        resetAt: undefined,
      },
      {
        label: "Monthly",
        usedPercent: 40,
        resetAt: new Date(validReset).getTime(),
      },
    ]);
  });
});
