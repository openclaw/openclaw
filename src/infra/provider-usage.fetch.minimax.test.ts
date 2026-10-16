import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchMinimaxUsage } from "./provider-usage.fetch.minimax.js";

const start = 1_774_180_800_000;
const end = start + 4 * 3_600_000;
const window = (usedPercent: number, label = "5h", resetAt?: number) => ({
  label,
  usedPercent,
  resetAt,
});
const model = (fields: Record<string, unknown>) => ({
  model_name: "general",
  start_time: start,
  end_time: end,
  ...fields,
});
async function fetchUsage(payload: unknown, baseUrl?: string) {
  const fetch = createProviderUsageFetch(async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer key");
    expect(new Headers(init?.headers).get("MM-API-Source")).toBe("OpenClaw");
    return makeResponse(200, payload);
  });
  return { result: await fetchMinimaxUsage("key", 5000, fetch, { baseUrl }), fetch };
}

describe("fetchMinimaxUsage", () => {
  it.each([
    ["https://api.minimax.io/anthropic", "https://api.minimax.io/v1/token_plan/remains"],
    ["not a url", "https://api.minimaxi.com/v1/token_plan/remains"],
  ])("resolves the usage endpoint from %s", async (baseUrl, expected) => {
    const { result, fetch } = await fetchUsage(
      { data: { current_interval_total_count: 100, current_interval_usage_count: 98 } },
      baseUrl,
    );
    expect(fetch.mock.calls[0]?.[0]).toBe(expected);
    expect(result.windows).toEqual([window(2)]);
  });

  it.each([
    ["{not-json", "Invalid JSON"],
    [{ base_resp: { status_code: 1007, status_msg: "  auth denied  " } }, "auth denied"],
  ])("reports invalid responses: %j", async (payload, error) => {
    const { result } = await fetchUsage(payload);
    expect(result.error).toBe(error);
    expect(result.windows).toEqual([]);
  });

  it.each([
    {
      name: "used/total with ordered numeric reset aliases",
      data: {
        used: 35,
        total: 100,
        window_hours: 3,
        reset_at: 1_700_000_000,
        resetTime: "2030-01-01T00:00:00Z",
        plan_name: "Pro Max",
      },
      plan: "Pro Max",
      windows: [window(35, "3h", 1_700_000_000_000)],
    },
    {
      name: "nested ratios with minute windows and the first valid date alias",
      data: {
        plan_name: "Starter",
        nested: [
          {
            usage_ratio: "0.25",
            window_minutes: "30",
            reset_at: "not-a-date",
            expires_at: "2026-01-08T00:00:00Z",
          },
        ],
      },
      plan: "Starter",
      windows: [window(25, "30m", 1_767_830_400_000)],
    },
    {
      name: "remaining counts ahead of remaining percentages",
      data: { total: "200", remaining: "50", usage_percent: 75, reset_at: 1_700_000_000_000 },
      windows: [window(75, "5h", 1_700_000_000_000)],
    },
    {
      name: "remaining percentage with an out-of-range date",
      data: { usage_percent: 98, reset_at: 8_640_000_000_000_001 },
      windows: [window(2)],
    },
    {
      name: "highest usable score, then shallower and earlier records",
      data: {
        branch: { deeper: { used_percent: 90, total: 100, used: 90 } },
        lower: { total: 100, used: 10 },
        invalid: { used_percent: "invalid", total: "invalid", used: "invalid", plan: "bad" },
        first: { used_percent: 20, total: 100, used: 20 },
        later: { used_percent: 30, total: 100, used: 30 },
      },
      windows: [window(20)],
    },
    {
      name: "sixty-node traversal bound",
      data: {
        usage_percent: 90,
        nested: [
          ...Array.from({ length: 57 }, () => ({})),
          { used_percent: 25 },
          { total: 100, used: 75 },
        ],
      },
      windows: [window(25)],
    },
    {
      name: "depth-four traversal bound",
      data: {
        first: {
          second: { third: { fourth: { used_percent: 25, fifth: { total: 100, used: 75 } } } },
        },
      },
      windows: [window(25)],
    },
    {
      name: "chat model ahead of empty speech quotas",
      data: {
        model_remains: [
          {
            model_name: "speech-hd",
            current_interval_total_count: 0,
            current_interval_usage_count: 0,
          },
          model({
            model_name: "MiniMax-M*",
            current_interval_total_count: 600,
            current_interval_usage_count: 595,
          }),
        ],
      },
      plan: "Coding Plan · MiniMax-M*",
      windows: [window(0.8333333333333334, "4h", end)],
    },
    {
      name: "authoritative current and weekly remaining percentages",
      root: true,
      data: {
        model_remains: [
          model({
            start_time: String(start),
            end_time: String(end),
            current_interval_total_count: 100,
            current_interval_usage_count: 90,
            current_interval_remaining_percent: 97,
            current_interval_status: 1,
            current_weekly_total_count: 0,
            current_weekly_usage_count: 0,
            current_weekly_remaining_percent: 77,
            current_weekly_status: 1,
            weekly_end_time: String(end),
          }),
        ],
      },
      plan: "Coding Plan · general",
      windows: [window(3, "4h", end), window(23, "Week", end)],
    },
    {
      name: "unlimited windows yield a valid empty snapshot",
      data: {
        model_remains: [
          model({
            current_interval_remaining_percent: 100,
            current_interval_status: 3,
            current_weekly_remaining_percent: 100,
            current_weekly_status: 3,
          }),
        ],
      },
      plan: "Coding Plan · general",
      windows: [],
    },
    {
      name: "exhausted bounded row ahead of unlimited fallback",
      data: {
        model_remains: [
          {
            model_name: "video",
            current_interval_remaining_percent: 100,
            current_interval_status: 3,
          },
          model({
            model_name: "other-bounded-model",
            current_interval_remaining_percent: 0,
            current_interval_status: 2,
          }),
        ],
      },
      plan: "Coding Plan · other-bounded-model",
      windows: [window(100, "4h", end)],
    },
    {
      name: "first nonzero record without a chat or bounded model",
      data: {
        model_remains: [
          {
            model_name: "speech-hd",
            current_interval_total_count: 0,
            current_interval_usage_count: 0,
          },
          model({
            model_name: "video-01",
            current_interval_total_count: 200,
            current_interval_usage_count: 150,
          }),
        ],
      },
      plan: "Coding Plan · video-01",
      windows: [window(25, "4h", end)],
    },
  ])("normalizes $name", async ({ data, plan, windows, root }) => {
    const { result } = await fetchUsage(root ? data : { data, base_resp: { status_code: 0 } });
    expect(result.error).toBeUndefined();
    expect(result.plan).toBe(plan);
    expect(result.windows).toEqual(windows);
  });

  it("rejects payloads without usage fields", async () => {
    const { result } = await fetchUsage({ data: { foo: "bar" } });
    expect(result.error).toBe("Unsupported response shape");
    expect(result.windows).toEqual([]);
  });
});
