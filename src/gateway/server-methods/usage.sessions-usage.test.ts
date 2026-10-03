import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import type { SessionCostSummary } from "../../infra/session-cost-usage.types.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

vi.mock("../../config/config.js", () => ({ getRuntimeConfig: vi.fn(() => TEST_RUNTIME_CONFIG) }));
vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadCombinedSessionStoreForGatewayCore: vi.fn(() => ({
      targetsBySessionKey: new Map(),
      durableTargets: [],
      storePath: "(multiple)",
      store: {},
    })),
  };
});
vi.mock("../session-utils-store-worker.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils-store-worker.js")>(
    "../session-utils-store-worker.js",
  );
  return {
    resolveGatewaySessionStoreTargetInWorker: vi.fn(
      actual.resolveGatewaySessionStoreTargetInWorker,
    ),
  };
});
vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    resolveUsageSessionSource: vi.fn(actual.resolveUsageSessionSource),
    discoverAllSessions: vi.fn(async ({ agentId }: { agentId?: string }) =>
      ["main", "opus"].includes(agentId ?? "")
        ? [
            {
              sessionId: `s-${agentId}`,
              sessionFile: `/tmp/agents/${agentId}/sessions/s-${agentId}.jsonl`,
              mtime: agentId === "main" ? 100 : 200,
            },
          ]
        : [],
    ),
    loadSessionCostSummariesFromCache: vi.fn(async ({ sessions }: { sessions: unknown[] }) => ({
      summaries: sessions.map(() => createEmptyCostUsageTotals()),
      cacheStatus: {
        status: "fresh",
        cachedFiles: sessions.length,
        pendingFiles: 0,
        staleFiles: 0,
      },
    })),
    loadSessionUsageTimeSeries: vi.fn(async () => ({ sessionId: "s-opus", points: [] })),
    loadSessionLogs: vi.fn(async () => []),
  };
});
import {
  discoverAllSessions,
  loadSessionCostSummariesFromCache,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
  resolveUsageSessionSource,
} from "../../infra/session-cost-usage.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { loadCombinedSessionStoreForGatewayCore } from "../session-utils.js";
import { usageHandlers } from "./usage.js";

let TEST_RUNTIME_CONFIG = {
  session: {},
  agents: { list: [{ id: "main", default: true }, { id: "opus" }] },
};
const BASE_USAGE_RANGE = { startDate: "2026-02-01", endDate: "2026-02-02", limit: 10 };
async function runSessionsUsageMethod(
  method: "sessions.usage" | "sessions.usage.timeseries" | "sessions.usage.logs",
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  const handler = expectDefined(usageHandlers[method], "usage handler");
  await handler({
    respond,
    params,
    context: { getRuntimeConfig: () => TEST_RUNTIME_CONFIG },
  } as unknown as Parameters<typeof handler>[0]);
  return respond;
}
const runSessionsUsage = (params: Record<string, unknown>) =>
  runSessionsUsageMethod("sessions.usage", params);
function readResult(respond: ReturnType<typeof vi.fn>): SessionsUsageResult {
  expect(respond).toHaveBeenCalledOnce();
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return respond.mock.calls[0]?.[1] as SessionsUsageResult;
}
function mockCombinedStore(
  store: Record<string, SessionEntry>,
  owners: ReadonlyArray<readonly [string, string]>,
) {
  vi.mocked(loadCombinedSessionStoreForGatewayCore).mockReturnValue({
    durableTargets: [],
    storePath: "(multiple)",
    store,
    targetsBySessionKey: new Map(
      owners.map(([key, agentId]) => [
        key,
        {
          agentId,
          entry: store[key],
          readSourceEntry: (sourceKey: string) => store[sourceKey],
          resolveSourceKey: (sourceKey: string) => sourceKey,
          storeTarget: { agentId, storePath: `/tmp/agents/${agentId}/agent/openclaw-agent.sqlite` },
        },
      ]),
    ),
  });
}
function mockStoredSession(
  key: string,
  entry: SessionEntry,
  resolution: "valid" | "missing" = "valid",
) {
  const storePath = "/tmp/agents/opus/agent/openclaw-agent.sqlite";
  vi.mocked(resolveGatewaySessionStoreTargetInWorker).mockResolvedValueOnce({
    agentId: "opus",
    canonicalKey: key,
    store: { [key]: entry },
    storeKeys: [key],
    storePath,
  });
  vi.mocked(resolveUsageSessionSource).mockResolvedValueOnce(
    resolution === "missing"
      ? undefined
      : { entry, sessionFile: `sqlite:opus:${entry.sessionId}:${storePath}` },
  );
}

describe("sessions.usage", () => {
  beforeEach(() => {
    TEST_RUNTIME_CONFIG = { ...TEST_RUNTIME_CONFIG };
    vi.clearAllMocks();
  });

  it("rejects all-agent scope with a specific agent or key", async () => {
    for (const selector of [{ agentId: "opus" }, { key: "agent:opus:s-opus" }]) {
      const respond = await runSessionsUsage({
        ...BASE_USAGE_RANGE,
        ...selector,
        agentScope: "all",
      });
      expect(respond.mock.calls[0]?.[0]).toBe(false);
    }
    expect(discoverAllSessions).not.toHaveBeenCalled();
  });

  it.each([
    {
      params: { mode: "specific", timeZone: "Europe/Vienna", utcOffset: "UTC+2" },
      date: "2026-10-25",
      start: "2026-10-24T22:00:00Z",
      end: "2026-10-25T23:00:00Z",
      dayBucket: { mode: "time-zone", timeZone: "Europe/Vienna" },
    },
    {
      params: { mode: "specific", utcOffset: "UTC+8" },
      date: "2026-07-06",
      start: "2026-07-05T16:00:00Z",
      end: "2026-07-06T16:00:00Z",
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 480 },
    },
    {
      params: { mode: "gateway" },
      date: "2026-03-08",
      start: "2026-03-08T05:00:00Z",
      end: "2026-03-09T04:00:00Z",
      dayBucket: undefined,
    },
  ])(
    "keeps $params date labels and calendar boundaries",
    async ({ params, date, start, end, dayBucket }) => {
      await withEnvAsync({ TZ: "America/New_York" }, async () => {
        expect(new Date("2026-03-08T05:00:00Z").getTimezoneOffset()).toBe(300);
        expect(new Date("2026-03-09T04:00:00Z").getTimezoneOffset()).toBe(240);
        const response = readResult(
          await runSessionsUsage({
            ...BASE_USAGE_RANGE,
            ...params,
            startDate: date,
            endDate: date,
          }),
        );
        expect(loadSessionCostSummariesFromCache).toHaveBeenCalledWith(
          expect.objectContaining({
            startMs: Date.parse(start),
            endMs: Date.parse(end) - 1,
            dayBucket,
          }),
        );
        expect(response.startDate).toBe(date);
        expect(response.endDate).toBe(date);
      });
    },
  );

  it("does not resolve specific usage keys through out-of-scope sessionId matches", async () => {
    await withOpenClawTestState({ label: "usage" }, async (state) => {
      const sessionFile = path.join(state.sessionsDir("opus"), "shared.jsonl");
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, "");
      mockCombinedStore(
        {
          "agent:main:shared": {
            sessionId: "shared",
            sessionFile: "shared.jsonl",
            label: "Main shared",
            updatedAt: 999,
          },
        },
        [["agent:main:shared", "main"]],
      );
      expect(
        readResult(await runSessionsUsage({ ...BASE_USAGE_RANGE, key: "shared", agentId: "opus" }))
          .sessions,
      ).toMatchObject([{ key: "agent:opus:shared", agentId: "opus" }]);
      expect(loadSessionCostSummariesFromCache).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "opus",
          sessions: expect.arrayContaining([
            expect.objectContaining({
              sessionFile: fs.realpathSync(sessionFile),
              sessionId: "shared",
            }),
          ]),
        }),
      );
      for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"] as const) {
        const respond = await runSessionsUsageMethod(method, { key: "shared", agentId: "opus" });
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(
          method === "sessions.usage.timeseries" ? loadSessionUsageTimeSeries : loadSessionLogs,
        ).toHaveBeenLastCalledWith(
          expect.objectContaining({
            agentId: "opus",
            sessionId: "shared",
            sessionFile: fs.realpathSync(sessionFile),
          }),
        );
      }
    });
  });
  it("rolls up known session family ids when historical usage is requested", async () => {
    const storeKey = "agent:opus:main";
    const sources: SessionCostSummary[] = [];
    const sourceSnapshots: SessionCostSummary[] = [];

    const oldSessionFile = "/tmp/old.jsonl.reset.2026-02-01T00-00-00.000Z";
    const oldestSessionFile = "/tmp/oldest.jsonl.reset.2026-01-31T00-00-00.000Z";
    const entry: SessionEntry = {
      sessionId: "current",
      updatedAt: 1_000,
      usageFamilyKey: storeKey,
      usageFamilySessionIds: ["old", "current", "oldest"],
    };
    mockStoredSession(storeKey, entry);
    vi.mocked(discoverAllSessions).mockResolvedValueOnce([
      { sessionId: "old", sessionFile: oldSessionFile, mtime: 1_000 },
      { sessionId: "oldest", sessionFile: oldestSessionFile, mtime: 900 },
    ]);

    mockCombinedStore({ [storeKey]: entry }, [[storeKey, "opus"]]);
    vi.mocked(loadSessionCostSummariesFromCache).mockImplementation(async ({ sessions }) => ({
      summaries: sessions.map((session) => {
        const historical = session.sessionId === "old";
        const oldest = session.sessionId === "oldest";
        const totalTokens = oldest ? 30 : historical ? 10 : 20;
        const totalCost = oldest ? 0.03 : historical ? 0.02 : 0.01;
        const date = oldest ? "2026-02-02" : "2026-02-01";
        const provider = historical ? "fixture::bedrock" : "fixture";
        const model = historical ? "arn" : "bedrock::arn";
        const messageCounts = {
          total: 1,
          user: 1,
          assistant: 0,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        };
        const latency = oldest
          ? { count: 3, avgMs: 7, p95Ms: 9, minMs: 5, maxMs: 9 }
          : historical
            ? { count: 2, avgMs: 25, p95Ms: 30, minMs: 20, maxMs: 30 }
            : { count: 1, avgMs: 10, p95Ms: 10, minMs: 10, maxMs: 10 };
        const totals = {
          ...createEmptyCostUsageTotals(),
          input: totalTokens,
          totalTokens,
          totalCost,
          inputCost: totalCost,
        };
        const daily = {
          ...totals,
          date,
          tokens: totalTokens,
          cost: totalCost,
          missingCostEntries: 1,
          missingCostByModel: { "fixture/unpriced": 1 },
        };
        const summary: SessionCostSummary = {
          ...totals,
          activityDates: [date],
          dailyBreakdown: [daily],
          messageCounts,
          dailyMessageCounts: [{ date, ...messageCounts }],
          utcQuarterHourMessageCounts: [{ date, quarterIndex: 2, ...messageCounts }],
          utcQuarterHourTokenUsage: [{ date, quarterIndex: 2, ...totals }],
          latency,
          dailyLatency: [{ date, ...latency }],
          modelUsage: [{ provider, model, count: 1, totals }],
          toolUsage: {
            totalCalls: oldest ? 1 : historical ? 2 : 3,
            uniqueTools: historical || oldest ? 1 : 2,
            tools: oldest
              ? [{ name: "z-first", count: 1 }]
              : historical
                ? [{ name: "a-second", count: 2 }]
                : [
                    { name: "z-first", count: 2 },
                    { name: "a-second", count: 1 },
                  ],
          },
          dailyModelUsage: [
            {
              date,
              provider: provider.replace("::", ":"),
              model: model.replace("::", ":"),
              tokens: totalTokens,
              cost: totalCost,
              count: 1,
            },
          ],
        };
        sources.push(summary);
        sourceSnapshots.push(structuredClone(summary));
        return summary;
      }),
      cacheStatus: {
        status: "fresh",
        cachedFiles: sessions.length,
        pendingFiles: 0,
        staleFiles: 0,
      },
    }));

    const respond = await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      key: storeKey,
      groupBy: "family",
      includeHistorical: true,
    });

    const result = readResult(respond);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.key).toBe(storeKey);
    expect(result.sessions[0]?.scope).toBe("family");
    expect(result.sessions[0]?.includedSessionIds).toEqual(["current", "old", "oldest"]);
    expect(result.sessions[0]?.usage?.totalTokens).toBe(60);
    expect(result.sessions[0]?.usage?.totalCost).toBeCloseTo(0.06);
    expect(result.sessions[0]?.usage?.dailyBreakdown).toMatchObject([
      {
        date: "2026-02-01",
        tokens: 30,
        cost: 0.03,
        totalTokens: 30,
        totalCost: 0.03,
        input: 30,
        inputCost: 0.03,
        missingCostEntries: 2,
        missingCostByModel: { "fixture/unpriced": 2 },
      },
      {
        date: "2026-02-02",
        totalTokens: 30,
        totalCost: 0.03,
        missingCostByModel: { "fixture/unpriced": 1 },
      },
    ]);
    expect(sources).toEqual(sourceSnapshots);
    const usage = result.sessions[0]?.usage;
    expect(usage?.activityDates).toEqual(["2026-02-01", "2026-02-02"]);
    expect(usage?.messageCounts?.total).toBe(3);
    expect(usage?.dailyMessageCounts).toMatchObject([
      { date: "2026-02-01", total: 2 },
      { date: "2026-02-02", total: 1 },
    ]);
    expect(usage?.utcQuarterHourMessageCounts).toMatchObject([
      { date: "2026-02-01", quarterIndex: 2, total: 2 },
      { date: "2026-02-02", quarterIndex: 2, total: 1 },
    ]);
    expect(usage?.utcQuarterHourTokenUsage).toMatchObject([
      { date: "2026-02-01", quarterIndex: 2, totalTokens: 30, totalCost: 0.03 },
      { date: "2026-02-02", quarterIndex: 2, totalTokens: 30, totalCost: 0.03 },
    ]);
    expect(usage?.dailyLatency).toEqual([
      { date: "2026-02-01", count: 3, avgMs: 20, p95Ms: 30, minMs: 10, maxMs: 30 },
      { date: "2026-02-02", count: 3, avgMs: 7, p95Ms: 9, minMs: 5, maxMs: 9 },
    ]);
    expect(usage?.latency).toEqual({ count: 6, avgMs: 13.5, p95Ms: 30, minMs: 5, maxMs: 30 });
    // a-second overtakes z-first before the final instance brings their counts level.
    expect(usage?.toolUsage?.tools).toEqual([
      { name: "a-second", count: 3 },
      { name: "z-first", count: 3 },
    ]);
    expect(result.sessions[0]?.usage?.modelUsage).toMatchObject([
      { provider: "fixture", model: "bedrock::arn" },
      { provider: "fixture::bedrock", model: "arn" },
    ]);
    expect(result.sessions[0]?.usage?.dailyModelUsage).toMatchObject([
      { provider: "fixture", model: "bedrock:arn" },
      { provider: "fixture:bedrock", model: "arn" },
      { provider: "fixture", model: "bedrock:arn" },
    ]);
    expect(result.aggregates.byModel).toMatchObject([
      { provider: "fixture", model: "bedrock::arn" },
      { provider: "fixture::bedrock", model: "arn" },
    ]);
    expect(result.aggregates.modelDaily).toMatchObject([
      { provider: "fixture:bedrock", model: "arn" },
      { provider: "fixture", model: "bedrock:arn" },
      { provider: "fixture", model: "bedrock:arn" },
    ]);
    expect(result.totals.totalTokens).toBe(60);
    expect(result.totals.totalCost).toBeCloseTo(0.06);
  });

  it("prefers the deterministic store key when duplicate sessionIds exist", async () => {
    const preferredKey = "agent:opus:acp:run-dup";
    mockStoredSession(preferredKey, { sessionId: "run-dup", updatedAt: 1_000 });
    mockCombinedStore(
      {
        [preferredKey]: { sessionId: "run-dup", sessionFile: "run-dup.jsonl", updatedAt: 1_000 },
        "agent:other:main": {
          sessionId: "run-dup",
          sessionFile: "run-dup.jsonl",
          updatedAt: 2_000,
        },
      },
      [
        [preferredKey, "opus"],
        ["agent:other:main", "other"],
      ],
    );
    expect(
      readResult(await runSessionsUsage({ ...BASE_USAGE_RANGE, key: "agent:opus:run-dup" }))
        .sessions,
    ).toMatchObject([{ key: preferredKey }]);
    expect(loadSessionCostSummariesFromCache).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "opus",
        sessions: expect.arrayContaining([
          expect.objectContaining({ sessionFile: expect.stringMatching(/^sqlite:/) }),
        ]),
      }),
    );
  });

  it("rejects traversal-style keys in specific session usage lookups", async () => {
    const respond = await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      key: "agent:opus:../../etc/passwd",
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]?.message).toContain("Invalid session reference");
  });

  it("fails closed when a canonical stored target no longer matches", async () => {
    const key = "agent:opus:stale";
    mockStoredSession(key, { sessionId: "stale", updatedAt: 1_000 }, "missing");
    const respond = await runSessionsUsageMethod("sessions.usage.timeseries", { key });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(loadSessionUsageTimeSeries).not.toHaveBeenCalled();
  });

  it("rejects traversal-style keys in timeseries/log lookups", async () => {
    const key = "agent:opus:../../etc/passwd";
    for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"] as const) {
      const respond = await runSessionsUsageMethod(method, { key });
      expect(respond.mock.calls).toEqual([
        [false, undefined, { code: "INVALID_REQUEST", message: `Invalid session key: ${key}` }],
      ]);
    }
  });
});
