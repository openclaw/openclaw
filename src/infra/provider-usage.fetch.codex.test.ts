import { expect, it } from "vitest";
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

it("returns token expired for a 401 auth failure", async () => {
  const mockFetch = createProviderUsageFetch(async () =>
    makeResponse(401, { error: "unauthorized" }),
  );
  const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
  expect(result).toMatchObject({ error: "Token expired", windows: [] });
});

it("parses windows, reset times, plan, and credit balance", async () => {
  const mockFetch = createProviderUsageFetch(async (_url, init) => {
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    expect(headers).toMatchObject({
      "ChatGPT-Account-Id": "acct-1",
      originator: "openclaw",
      "User-Agent": expect.stringMatching(/^openclaw\//),
    });
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

  expect(result).toMatchObject({
    provider: "openai",
    plan: "Plus",
    billing: [{ type: "balance", amount: 12.5, unit: "credits" }],
  });
  expect(result.windows).toEqual([
    { label: "3h", usedPercent: 35.5, resetAt: 1_700_000_000_000 },
    { label: "Day", usedPercent: 75, resetAt: 1_700_050_000_000 },
  ]);
});

it.each([
  [604_800, 7, 10, 1_700_500_000],
  // API can report 24h while the reset cadence and dashboard are weekly.
  [86_400, 14, 20, 1_700_000_000 + 5 * 24 * 60 * 60],
])(
  "labels a %s-second secondary window with weekly cadence as Week",
  async (seconds, primaryUsed, secondaryUsed, reset) => {
    const result = await fetchUsage({
      rate_limit: {
        primary_window: window(10_800, primaryUsed, 1_700_000_000),
        secondary_window: window(seconds, secondaryUsed, reset),
      },
    });
    expect(result.windows).toEqual([
      { label: "3h", usedPercent: primaryUsed, resetAt: 1_700_000_000_000 },
      { label: "Week", usedPercent: secondaryUsed, resetAt: reset * 1000 },
    ]);
  },
);

it("labels short secondary windows in hours", async () => {
  const result = await fetchUsage({
    credits: { balance: "not-a-number" },
    rate_limit: { secondary_window: window(21_600, 11) },
  });
  expect(result.windows).toEqual([{ label: "6h", usedPercent: 11, resetAt: undefined }]);
  expect(result.billing).toBeUndefined();
});
