import fsSync from "node:fs";
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnv, withEnvAsync } from "../../test-utils/env.js";

vi.mock("../../infra/session-cost-usage.js", async () => ({
  ...(await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  )),
  loadCostUsageSummaryFromCache: vi.fn(async () => costSummary(1, 0)),
  discoverAllSessions: vi.fn(async () => []),
}));
vi.mock("../../config/sessions/combined-store-gateway-read.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/sessions/combined-store-gateway-read.js")>(
    "../../config/sessions/combined-store-gateway-read.js",
  )),
  loadCombinedSessionStoreForGatewayCoreAsync: vi.fn(() => ({
    targetsBySessionKey: new Map(),
    durableTargets: [],
    storePath: "(multiple)",
    store: {},
  })),
}));

import {
  discoverAllSessions,
  loadCostUsageSummaryFromCache,
} from "../../infra/session-cost-usage.js";
import { resolveDateRange } from "./usage-date-range.js";
import { loadCostUsageSummaryCached } from "./usage-result-cache.js";
import { usageHandlers } from "./usage.js";

function costSummary(totalTokens: number, totalCost: number) {
  const totals = {
    ...createEmptyCostUsageTotals(),
    input: totalTokens,
    totalTokens,
    totalCost,
    inputCost: totalCost,
  };
  return { updatedAt: Date.now(), days: 1, daily: [{ date: "2026-02-01", ...totals }], totals };
}
const dates = { startDate: "2026-02-01", endDate: "2026-02-02" };
async function request(
  method: "usage.cost" | "sessions.usage",
  params: Record<string, unknown>,
  config: OpenClawConfig = {},
  respond = vi.fn(),
) {
  const handler = expectDefined(usageHandlers[method], "usage handler");
  await handler({
    respond,
    params,
    context: { getRuntimeConfig: () => config },
  } as unknown as Parameters<(typeof usageHandlers)[typeof method]>[0]);
  expect(respond).toHaveBeenCalledOnce();
  return expectDefined(respond.mock.calls[0], "usage response");
}
function range(params: Parameters<typeof resolveDateRange>[0]) {
  const result = resolveDateRange(params);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

describe("gateway usage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each([
    [{ startDate: "2026-02-30" }, "invalid startDate"],
    [{ endDate: "2026-2-5" }, "invalid endDate"],
    [{ startDate: "2026-02-01", endDate: "2026-13-01" }, "invalid endDate"],
  ])("rejects invalid explicit ranges %j", (params, error) => {
    expect(resolveDateRange(params)).toEqual({ ok: false, error: expect.stringContaining(error) });
  });

  it.each([
    ["usage.cost", { startDate: 0 }, "startDate"],
    ["sessions.usage", { mode: "specific", timeZone: "Invalid/Timezone" }, "invalid timeZone"],
    [
      "sessions.usage",
      { startDate: "2026-02-03", endDate: "2026-02-02" },
      "startDate must not be after endDate",
    ],
    ["usage.cost", { startDate: "2026-02-01" }, "startDate and endDate must be provided together"],
    [
      "sessions.usage",
      { endDate: "2026-02-01" },
      "startDate and endDate must be provided together",
    ],
  ] as const)("%s rejects %j before loading usage", async (method, params, message) => {
    expect(await request(method, params)).toEqual([
      false,
      undefined,
      { code: "INVALID_REQUEST", message: expect.stringContaining(message) },
    ]);
    expect(loadCostUsageSummaryFromCache).not.toHaveBeenCalled();
    expect(discoverAllSessions).not.toHaveBeenCalled();
  });

  it("falls back to the offset when Gateway ICU does not recognize the browser timezone", async () => {
    expect(
      await request("usage.cost", {
        mode: "specific",
        timeZone: "Newer/BrowserZone",
        utcOffset: "UTC+1",
      }),
    ).toEqual([true, expect.any(Object), undefined]);
    expect(loadCostUsageSummaryFromCache).toHaveBeenCalledWith(
      expect.objectContaining({
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: 60 },
      }),
    );
  });

  it("crosses a skipped IANA civil date for the prior day's end", () => {
    const params = { mode: "specific", timeZone: "Pacific/Apia" };
    expect(range({ ...params, startDate: "2011-12-29", endDate: "2011-12-29" })).toEqual({
      startMs: Date.parse("2011-12-29T10:00:00.000Z"),
      endMs: Date.parse("2011-12-30T10:00:00.000Z") - 1,
    });
    expect(resolveDateRange({ ...params, startDate: "2011-12-30", endDate: "2011-12-30" })).toEqual(
      {
        ok: false,
        error: "calendar day does not exist in requested time zone",
      },
    );
  });

  it.each([null, ""])("retains UTC for omitted or blank offset %j", (utcOffset) => {
    expect(range({ ...dates, mode: "specific", utcOffset })).toEqual({
      startMs: Date.parse("2026-02-01T00:00:00.000Z"),
      endMs: Date.parse("2026-02-02T23:59:59.999Z"),
    });
  });

  it.each(["UTC+14:01", "UTC-12:01", "UTC+5:60", 330])(
    "rejects malformed offset %j",
    (utcOffset) => {
      expect(resolveDateRange({ ...dates, mode: "specific", utcOffset })).toEqual({
        ok: false,
        error: "invalid utcOffset: expected UTC-12:00 through UTC+14:00",
      });
    },
  );

  it("uses the specific offset for today/day math after UTC midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-17T03:57:00.000Z"));
    expect(range({ days: 1, mode: "specific", utcOffset: "UTC-5" })).toEqual({
      startMs: Date.UTC(2026, 1, 16, 5),
      endMs: Date.UTC(2026, 1, 17, 5) - 1,
    });
  });

  it("keeps trailing gateway ranges on calendar days across DST", () => {
    withEnv({ TZ: "America/New_York" }, () => {
      expect(new Date("2026-03-08T05:00:00.000Z").getTimezoneOffset()).toBe(300);
      expect(new Date("2026-03-09T04:00:00.000Z").getTimezoneOffset()).toBe(240);
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));
      expect(range({ days: 2, mode: "gateway" })).toEqual({
        startMs: Date.parse("2026-03-08T05:00:00.000Z"),
        endMs: Date.parse("2026-03-10T04:00:00.000Z") - 1,
      });
    });
  });

  it("clamps days to supported bounds and defaults to 30 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:34:56.000Z"));
    const midnight = Date.UTC(2026, 1, 5);
    const dayMs = 86_400_000;
    for (const [params, days] of [
      [{ days: 0 }, 1],
      [{ days: Number.MAX_SAFE_INTEGER }, 36600],
      [{}, 30],
    ] as const) {
      expect(range(params)).toEqual({
        startMs: midnight - (days - 1) * dayMs,
        endMs: midnight + dayMs - 1,
      });
    }
  });

  it("keeps refreshing cost summaries fresh for the TTL window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T00:00:00.000Z"));
    vi.mocked(loadCostUsageSummaryFromCache).mockResolvedValueOnce({
      ...costSummary(1, 0),
      cacheStatus: { status: "refreshing", cachedFiles: 1, pendingFiles: 1, staleFiles: 1 },
    });
    const params = {
      startMs: 1,
      endMs: 2,
      config: { agents: { entries: { ops: {} } } },
    };
    await loadCostUsageSummaryCached(params);
    expect(vi.mocked(loadCostUsageSummaryFromCache).mock.calls[0]?.[0]?.agentId).toBe("ops");
    await vi.advanceTimersByTimeAsync(29_999);
    await loadCostUsageSummaryCached(params);
    expect(loadCostUsageSummaryFromCache).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await loadCostUsageSummaryCached(params);
    expect(loadCostUsageSummaryFromCache).toHaveBeenCalledTimes(2);
  });

  it("keys cost usage by the complete day bucket", async () => {
    const params = { startMs: 1, endMs: 2, config: {} };
    const buckets = [
      { mode: "utc-offset", utcOffsetMinutes: 0 },
      { mode: "utc-offset", utcOffsetMinutes: -300 },
      { mode: "time-zone", timeZone: "America/New_York" },
    ] as const;
    for (const dayBucket of [...buckets, buckets[0], buckets[2]]) {
      await loadCostUsageSummaryCached({ ...params, dayBucket });
    }
    expect(loadCostUsageSummaryFromCache).toHaveBeenCalledTimes(3);
  });

  it("aggregates the gateway agent universe, including on-disk system agents", async () => {
    await withTestDir({ prefix: "openclaw-usage-universe-" }, async (stateDir) => {
      await fs.mkdir(`${stateDir}/agents/openclaw`, { recursive: true });
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
        request(
          "usage.cost",
          {
            ...dates,
            agentScope: "all",
          },
          { agents: { entries: { main: {} } } },
        ),
      );
      const loaded = vi
        .mocked(loadCostUsageSummaryFromCache)
        .mock.calls.map(([params]) => params?.agentId);
      expect(loaded).toContain("main");
      expect(loaded).toContain("openclaw");
    });
  });

  it("does not project local avatar bytes for usage-only agent enumeration", async () => {
    await withTestDir({ prefix: "openclaw-usage-avatar-" }, async (workspace) => {
      await fs.writeFile(`${workspace}/avatar.png`, "avatar");
      const config: OpenClawConfig = {
        agents: { entries: { main: { workspace, identity: { avatar: "avatar.png" } } } },
      };
      const readSync = vi.spyOn(fsSync, "readSync");
      try {
        await request("usage.cost", { ...dates, agentScope: "all" }, config);
        await request("sessions.usage", { ...dates, agentScope: "all" }, config);
        expect(readSync).not.toHaveBeenCalled();
      } finally {
        readSync.mockRestore();
      }
    });
  });

  it("isolates per-agent cost caches and aggregates only for explicit all-agent scope", async () => {
    vi.mocked(loadCostUsageSummaryFromCache).mockImplementation(async (params) =>
      params?.agentId === "opus" ? costSummary(20, 2) : costSummary(10, 1),
    );
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, opus: {} },
      },
    };
    const params = { ...dates, endDate: dates.startDate, mode: "utc" };
    const [, defaultResult] = await request("usage.cost", params, config);
    expect(loadCostUsageSummaryFromCache).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadCostUsageSummaryFromCache).mock.calls[0]?.[0]?.agentId).toBe("main");
    expect(defaultResult).toMatchObject({ totals: { totalTokens: 10, totalCost: 1 } });
    for (const [agentId, totalTokens, totalCost] of [
      ["opus", 20, 2],
      ["main", 10, 1],
      ["opus", 20, 2],
    ] as const) {
      const [ok, result] = await request("usage.cost", { ...params, agentId }, config);
      expect(ok).toBe(true);
      expect(result).toMatchObject({ totals: { totalTokens, totalCost } });
      expect(loadCostUsageSummaryFromCache).toHaveBeenCalledTimes(2);
    }
    const [ok, aggregate] = await request("usage.cost", { ...params, agentScope: "all" }, config);
    expect(loadCostUsageSummaryFromCache).toHaveBeenCalledTimes(4);
    expect(ok).toBe(true);
    expect(aggregate).toMatchObject({
      totals: { totalTokens: 30, totalCost: 3 },
      daily: [{ date: "2026-02-01", totalTokens: 30, totalCost: 3 }],
    });
  });

  it("bounds all-agent cache loads", async () => {
    const { promise: released, resolve: release } = createDeferred();
    const { promise: firstBatch, resolve: startedBatch } = createDeferred();
    vi.mocked(loadCostUsageSummaryFromCache).mockImplementation(async () => {
      if (vi.mocked(loadCostUsageSummaryFromCache).mock.calls.length === 12) {
        startedBatch();
      }
      await released;
      return costSummary(1, 0);
    });
    const response = request(
      "usage.cost",
      { ...dates, agentScope: "all" },
      {
        agents: {
          entries: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`agent-${i}`, {}])),
        },
      },
    );
    try {
      await firstBatch;
      expect(loadCostUsageSummaryFromCache).toHaveBeenCalledTimes(12);
      release();
      expect(await response).toEqual([
        true,
        expect.objectContaining({ totals: expect.objectContaining({ totalTokens: 13 }) }),
        undefined,
      ]);
    } finally {
      release();
      await response;
    }
  });

  it("rejects the aggregate when one agent task fails", async () => {
    const failure = new Error("agent usage load failed");
    vi.mocked(loadCostUsageSummaryFromCache)
      .mockResolvedValueOnce(costSummary(1, 0))
      .mockRejectedValueOnce(failure);
    const respond = vi.fn();
    await expect(
      request(
        "usage.cost",
        { ...dates, agentScope: "all" },
        {
          agents: { entries: { main: {}, broken: {} } },
        },
        respond,
      ),
    ).rejects.toBe(failure);
    expect(respond).not.toHaveBeenCalled();
  });
});
