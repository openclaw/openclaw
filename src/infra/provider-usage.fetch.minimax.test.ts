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
const remainingCounts = (total: number, remaining: number, period = "interval") => ({
  [`current_${period}_total_count`]: total,
  [`current_${period}_usage_count`]: remaining,
});
const counts = (total: number, remaining: number, model_name: string) =>
  model({ model_name, ...remainingCounts(total, remaining) });
const modelData = (...model_remains: Record<string, unknown>[]) => ({ model_remains });
const quota = (remaining: number, status: number, period = "interval") => ({
  [`current_${period}_remaining_percent`]: remaining,
  [`current_${period}_status`]: status,
});
const emptySpeechQuota = { model_name: "speech-hd", ...remainingCounts(0, 0) };
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
    const { result, fetch } = await fetchUsage({ data: remainingCounts(100, 98) }, baseUrl);
    expect(fetch.mock.calls[0]?.[0]).toBe(expected);
    expect(result.windows).toEqual([window(2)]);
  });

  it.each([
    ["{not-json", "Invalid JSON"],
    [{ base_resp: { status_code: 1007, status_msg: "  auth denied  " } }, "auth denied"],
    [{ data: { foo: "bar" } }, "Unsupported response shape"],
  ])("reports invalid responses: %j", async (payload, error) => {
    const { result } = await fetchUsage(payload);
    expect(result).toMatchObject({ error, windows: [] });
  });

  it.each(
    Object.entries<[Record<string, unknown>, ReturnType<typeof window>[], string?, boolean?]>({
      "used/total with ordered numeric reset aliases": [
        {
          used: 35,
          total: 100,
          window_hours: 3,
          reset_at: 1_700_000_000,
          resetTime: "2030-01-01T00:00:00Z",
          plan_name: "Pro Max",
        },
        [window(35, "3h", 1_700_000_000_000)],
        "Pro Max",
      ],
      "nested ratios with minute windows and the first valid date alias": [
        {
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
        [window(25, "30m", 1_767_830_400_000)],
        "Starter",
      ],
      "remaining counts ahead of remaining percentages": [
        { total: "200", remaining: "50", usage_percent: 75, reset_at: 1_700_000_000_000 },
        [window(75, "5h", 1_700_000_000_000)],
      ],
      "remaining percentage with an out-of-range date": [
        { usage_percent: 98, reset_at: 8_640_000_000_000_001 },
        [window(2)],
      ],
      "highest usable score, then shallower and earlier records": [
        {
          branch: { deeper: { used_percent: 90, total: 100, used: 90 } },
          lower: { total: 100, used: 10 },
          invalid: { used_percent: "invalid", total: "invalid", used: "invalid", plan: "bad" },
          first: { used_percent: 20, total: 100, used: 20 },
          later: { used_percent: 30, total: 100, used: 30 },
        },
        [window(20)],
      ],
      "sixty-node traversal bound": [
        {
          usage_percent: 90,
          nested: [
            ...Array.from({ length: 57 }, () => ({})),
            { used_percent: 25 },
            { total: 100, used: 75 },
          ],
        },
        [window(25)],
      ],
      "depth-four traversal bound": [
        {
          first: {
            second: { third: { fourth: { used_percent: 25, fifth: { total: 100, used: 75 } } } },
          },
        },
        [window(25)],
      ],
      "chat model ahead of empty speech quotas": [
        modelData(emptySpeechQuota, counts(600, 595, "MiniMax-M*")),
        [window(0.8333333333333334, "4h", end)],
        "Coding Plan · MiniMax-M*",
      ],
      "authoritative current and weekly remaining percentages": [
        modelData(
          model({
            start_time: String(start),
            end_time: String(end),
            ...remainingCounts(100, 90),
            ...quota(97, 1),
            ...remainingCounts(0, 0, "weekly"),
            ...quota(77, 1, "weekly"),
            weekly_end_time: String(end),
          }),
        ),
        [window(3, "4h", end), window(23, "Week", end)],
        "Coding Plan · general",
        true,
      ],
      "unlimited windows yield a valid empty snapshot": [
        modelData(model({ ...quota(100, 3), ...quota(100, 3, "weekly") })),
        [],
        "Coding Plan · general",
      ],
      "exhausted bounded row ahead of unlimited fallback": [
        modelData(
          { model_name: "video", ...quota(100, 3) },
          model({ model_name: "other-bounded-model", ...quota(0, 2) }),
        ),
        [window(100, "4h", end)],
        "Coding Plan · other-bounded-model",
      ],
      "first nonzero record without a chat or bounded model": [
        modelData(emptySpeechQuota, counts(200, 150, "video-01")),
        [window(25, "4h", end)],
        "Coding Plan · video-01",
      ],
    }),
  )("normalizes %s", async (_name, [data, windows, plan, root]) => {
    const { result } = await fetchUsage(root ? data : { data, base_resp: { status_code: 0 } });
    expect(result).toEqual({ provider: "minimax", displayName: "MiniMax", plan, windows });
  });
});
