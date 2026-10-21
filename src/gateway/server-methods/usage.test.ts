import fsSync from "node:fs";
import fs from "node:fs/promises";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnv } from "../../test-utils/env.js";

vi.mock("../../infra/session-cost-usage.js", async () => ({
  ...(await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  )),
  loadCostUsageSummaryFromCache: vi.fn(async () => costSummary(1, 0)),
  discoverAllSessions: vi.fn(async () => []),
}));

import {
  discoverAllSessions,
  loadCostUsageSummaryFromCache,
} from "../../infra/session-cost-usage.js";
import { resolveDateRange } from "./usage-date-range.js";
import { loadCostUsageSummaryCached } from "./usage-result-cache.js";
import { invokeUsage, usageReply, usageTotals } from "./usage.test-support.js";

const loadCost = vi.mocked(loadCostUsageSummaryFromCache);
function costSummary(totalTokens: number, totalCost: number) {
  const totals = usageTotals(totalTokens, totalCost);
  return { updatedAt: Date.now(), days: 1, daily: [{ date: "2026-02-01", ...totals }], totals };
}
const dates = { startDate: "2026-02-01", endDate: "2026-02-02" };
const allAgents = { ...dates, agentScope: "all" };
async function request(
  params: Record<string, unknown>,
  config: OpenClawConfig = {},
  method: "usage.cost" | "sessions.usage" = "usage.cost",
  respond = vi.fn(),
) {
  return usageReply(await invokeUsage(method, params, config, { respond }));
}
type RangeParams = Parameters<typeof resolveDateRange>[0];
function expectRange(params: RangeParams, [startMs, endMs]: [number, number]) {
  expect(resolveDateRange(params)).toEqual({ ok: true, value: { startMs, endMs } });
}
function agents(...ids: string[]): OpenClawConfig {
  return { agents: { entries: Object.fromEntries(ids.map((id) => [id, {}])) } };
}
function expectUsage(reply: ReturnType<typeof usageReply>, shape: object) {
  expect(reply).toMatchObject([true, shape, undefined]);
}

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
  ["sessions.usage", { endDate: "2026-02-01" }, "startDate and endDate must be provided together"],
] as const)("%s rejects %j before loading usage", async (method, params, message) => {
  expect(await request(params, {}, method)).toEqual([
    false,
    undefined,
    { code: "INVALID_REQUEST", message: expect.stringContaining(message) },
  ]);
  expect(loadCost).not.toHaveBeenCalled();
  expect(discoverAllSessions).not.toHaveBeenCalled();
});

it("falls back to the offset when Gateway ICU does not recognize the browser timezone", async () => {
  const params = { mode: "specific", timeZone: "Newer/BrowserZone", utcOffset: "UTC+1" };
  expect(await request(params)).toEqual([true, expect.any(Object), undefined]);
  expect(loadCost).toHaveBeenCalledWith(
    expect.objectContaining({ dayBucket: { mode: "utc-offset", utcOffsetMinutes: 60 } }),
  );
});

it.each(["specific", "gateway"])("handles skipped civil dates in %s mode", (mode) => {
  withEnv({ TZ: "Pacific/Apia" }, () => {
    const params = { mode, ...(mode === "specific" ? { timeZone: "Pacific/Apia" } : {}) };
    expect(resolveDateRange({ ...params, startDate: "2011-12-30", endDate: "2011-12-30" })).toEqual(
      {
        ok: false,
        error: "calendar day does not exist in requested time zone",
      },
    );
    expectRange({ ...params, startDate: "2011-12-29", endDate: "2011-12-29" }, [
      Date.UTC(2011, 11, 29, 10),
      Date.UTC(2011, 11, 30, 10) - 1,
    ]);
  });
});

it.each([null, ""])("retains UTC for omitted or blank offset %j", (utcOffset) => {
  expectRange({ ...dates, mode: "specific", utcOffset }, [
    Date.UTC(2026, 1, 1),
    Date.UTC(2026, 1, 3) - 1,
  ]);
});

it.each(["UTC+14:01", "UTC-12:01", "UTC+5:60", 330])("rejects malformed offset %j", (utcOffset) => {
  expect(resolveDateRange({ ...dates, mode: "specific", utcOffset })).toEqual({
    ok: false,
    error: "invalid utcOffset: expected UTC-12:00 through UTC+14:00",
  });
});

it("uses the specific offset for today/day math after UTC midnight", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-17T03:57:00.000Z"));
  expectRange({ days: 1, mode: "specific", utcOffset: "UTC-5" }, [
    Date.UTC(2026, 1, 16, 5),
    Date.UTC(2026, 1, 17, 5) - 1,
  ]);
});

it("keeps trailing gateway ranges on calendar days across DST", () => {
  withEnv({ TZ: "America/New_York" }, () => {
    expect([8, 9].map((day) => new Date(2026, 2, day).getTimezoneOffset())).toEqual([300, 240]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));
    expectRange({ days: 2, mode: "gateway" }, [
      Date.UTC(2026, 2, 8, 5),
      Date.UTC(2026, 2, 10, 4) - 1,
    ]);
  });
});

it("keeps refreshing cost summaries fresh for the TTL window", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-05T00:00:00.000Z"));
  loadCost.mockResolvedValueOnce({
    ...costSummary(1, 0),
    cacheStatus: { status: "refreshing", cachedFiles: 1, pendingFiles: 1, staleFiles: 1 },
  });
  const params = { startMs: 1, endMs: 2, config: agents("ops") };
  await loadCostUsageSummaryCached(params);
  expect(loadCost.mock.calls[0]?.[0]?.agentId).toBe("ops");
  await vi.advanceTimersByTimeAsync(29_999);
  await loadCostUsageSummaryCached(params);
  expect(loadCost).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await loadCostUsageSummaryCached(params);
  expect(loadCost).toHaveBeenCalledTimes(2);
});

it("does not project local avatar bytes for usage-only agent enumeration", async () => {
  await withTestDir({ prefix: "openclaw-usage-avatar-" }, async (workspace) => {
    await fs.writeFile(`${workspace}/avatar.png`, "avatar");
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace, identity: { avatar: "avatar.png" } } } },
    };
    const readSync = vi.spyOn(fsSync, "readSync");
    onTestFinished(() => readSync.mockRestore());
    await request(allAgents, config);
    await request(allAgents, config, "sessions.usage");
    expect(readSync).not.toHaveBeenCalled();
  });
});

it("isolates per-agent cost caches and aggregates only for explicit all-agent scope", async () => {
  loadCost.mockImplementation(async (params) =>
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
  const [, defaultResult] = await request(params, config);
  expect(loadCost).toHaveBeenCalledTimes(1);
  expect(loadCost.mock.calls[0]?.[0]?.agentId).toBe("main");
  expect(defaultResult).toMatchObject({ totals: { totalTokens: 10, totalCost: 1 } });
  for (const [agentId, totalTokens, totalCost] of [
    ["opus", 20, 2],
    ["main", 10, 1],
    ["opus", 20, 2],
  ] as const) {
    expectUsage(await request({ ...params, agentId }, config), {
      totals: { totalTokens, totalCost },
    });
    expect(loadCost).toHaveBeenCalledTimes(2);
  }
  const aggregate = await request({ ...params, agentScope: "all" }, config);
  expect(loadCost).toHaveBeenCalledTimes(4);
  expectUsage(aggregate, {
    totals: { totalTokens: 30, totalCost: 3 },
    daily: [{ date: "2026-02-01", totalTokens: 30, totalCost: 3 }],
  });
});

it("bounds all-agent cache loads", async () => {
  const { promise: released, resolve: release } = createDeferred();
  const { promise: firstBatch, resolve: startedBatch } = createDeferred();
  loadCost.mockImplementation(async () => {
    if (loadCost.mock.calls.length === 12) {
      startedBatch();
    }
    await released;
    return costSummary(1, 0);
  });
  const config = agents(...Array.from({ length: 13 }, (_, i) => `agent-${i}`));
  const response = request(allAgents, config);
  try {
    await firstBatch;
    expect(loadCost).toHaveBeenCalledTimes(12);
    release();
    expect(await response).toMatchObject([true, { totals: { totalTokens: 13 } }, undefined]);
  } finally {
    release();
    await response;
  }
});

it("rejects the aggregate when one agent task fails", async () => {
  const failure = new Error("agent usage load failed");
  loadCost.mockResolvedValueOnce(costSummary(1, 0)).mockRejectedValueOnce(failure);
  const respond = vi.fn();
  await expect(request(allAgents, agents("main", "broken"), "usage.cost", respond)).rejects.toBe(
    failure,
  );
  expect(respond).not.toHaveBeenCalled();
});
