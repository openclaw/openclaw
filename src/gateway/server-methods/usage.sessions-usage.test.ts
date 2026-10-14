import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import type { SessionCostSummary } from "../../infra/session-cost-usage.types.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import * as sessionSharingPreparation from "../session-sharing-preparation.js";

vi.mock("../../config/config.js", () => ({ getRuntimeConfig: vi.fn(() => TEST_RUNTIME_CONFIG) }));
vi.mock("../../config/sessions/combined-store-gateway-read.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../config/sessions/combined-store-gateway-read.js")
  >("../../config/sessions/combined-store-gateway-read.js");
  return {
    ...actual,
    loadCombinedSessionStoreForGatewayCoreAsync: vi.fn(() => ({
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
import { loadCombinedSessionStoreForGatewayCoreAsync } from "../../config/sessions/combined-store-gateway-read.js";
import {
  discoverAllSessions,
  loadSessionCostSummariesFromCache,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
  resolveUsageSessionSource,
} from "../../infra/session-cost-usage.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { usageHandlers } from "./usage.js";

let TEST_RUNTIME_CONFIG: OpenClawConfig = {
  session: {},
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: {}, opus: {} },
  },
};
const BASE_USAGE_RANGE = { startDate: "2026-02-01", endDate: "2026-02-02", limit: 10 };
async function runSessionsUsageMethod(
  method: "sessions.usage" | "sessions.usage.timeseries" | "sessions.usage.logs",
  params: Record<string, unknown>,
  options: {
    signal?: AbortSignal;
    respond?: ReturnType<typeof vi.fn>;
    context?: { getRuntimeConfig: () => OpenClawConfig; sessionRowProjectionOwner?: object };
  } = {},
) {
  const respond = options.respond ?? vi.fn();
  const handler = expectDefined(usageHandlers[method], "usage handler");
  await handler({
    respond,
    params,
    signal: options.signal,
    context: options.context ?? { getRuntimeConfig: () => TEST_RUNTIME_CONFIG },
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
  storePath?: string,
) {
  vi.mocked(loadCombinedSessionStoreForGatewayCoreAsync).mockResolvedValue({
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
          storeTarget: {
            agentId,
            storePath: storePath ?? `/tmp/agents/${agentId}/agent/openclaw-agent.sqlite`,
          },
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

  it.each(["sharing", "configuration"])(
    "keeps visible usage when unrelated %s changes during its worker read",
    async (change) => {
      const started = createDeferred();
      const released = createDeferred();
      vi.mocked(loadSessionCostSummariesFromCache).mockImplementationOnce(async () => {
        started.resolve();
        await released.promise;
        return {
          summaries: [{ ...createEmptyCostUsageTotals(), totalTokens: 123 }],
          cacheStatus: { status: "fresh", cachedFiles: 1, pendingFiles: 0, staleFiles: 0 },
        };
      });
      const pending = runSessionsUsage(BASE_USAGE_RANGE);
      await started.promise;
      if (change === "sharing") {
        bumpGatewayAccessRevision();
      } else {
        TEST_RUNTIME_CONFIG = { ...TEST_RUNTIME_CONFIG };
      }
      released.resolve();
      const respond = await pending;
      expect(readResult(respond).totals.totalTokens).toBe(123);
    },
  );

  it.each(["client cancellation", "time budget"] as const)(
    "cancels data work after %s while preserving the caller lifetime",
    async (cause) => {
      const started = createDeferred<AbortSignal | undefined>();
      const release = createDeferred();
      const controller = new AbortController();
      const respond = vi.fn();
      if (cause === "time budget") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      vi.mocked(loadSessionCostSummariesFromCache).mockImplementationOnce(async () => {
        const signal = getAsyncWorkSignal();
        started.resolve(signal);
        await release.promise;
        return {
          summaries: [createEmptyCostUsageTotals()],
          cacheStatus: { status: "fresh", cachedFiles: 1, pendingFiles: 0, staleFiles: 0 },
        };
      });
      const pending = runSessionsUsageMethod("sessions.usage", BASE_USAGE_RANGE, {
        signal: controller.signal,
        respond,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        const signal = expectDefined(await started.promise, "request-owned usage work signal");
        expect(signal.aborted).toBe(false);
        if (cause === "client cancellation") {
          controller.abort(new Error("usage client disconnected"));
        } else {
          await vi.advanceTimersByTimeAsync(14_999);
          expect(signal.aborted).toBe(false);
          expect(respond).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
        }
        expect(signal.aborted).toBe(true);
        if (cause === "time budget") {
          expect(await pending).toBeUndefined();
          expect(readResult(respond)).toMatchObject({
            totals: { totalTokens: 0 },
            cacheStatus: { status: "partial", pendingFiles: 1 },
            partial: {
              reason: "time-budget",
              message: expect.stringContaining("narrow the date range"),
            },
          });
        } else {
          expect(await pending).toBe(signal.reason);
          expect(respond).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await pending;
        vi.useRealTimers();
      }
    },
  );

  it("returns completed batches and a range hint when the next batch exceeds its budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = createDeferred();
    const release = createDeferred();
    const discovered = vi.mocked(discoverAllSessions);
    const originalDiscovery = discovered.getMockImplementation()!;
    const load = vi.mocked(loadSessionCostSummariesFromCache);
    const originalLoad = load.getMockImplementation()!;
    discovered.mockResolvedValue(
      Array.from({ length: 257 }, (_, index) => ({
        sessionId: `budget-${index}`,
        sessionFile: `/tmp/budget-${index}.jsonl`,
        mtime: 257 - index,
      })),
    );
    load.mockImplementation(async ({ sessions }) => {
      if (sessions.some(({ sessionId }) => sessionId === "budget-256")) {
        const signal = getAsyncWorkSignal()!;
        const abort = () => release.resolve();
        signal.addEventListener("abort", abort, { once: true });
        started.resolve();
        try {
          await release.promise;
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener("abort", abort);
        }
      }
      return {
        summaries: sessions.map(() => ({ ...createEmptyCostUsageTotals(), totalTokens: 7 })),
        cacheStatus: {
          status: "fresh",
          cachedFiles: sessions.length,
          pendingFiles: 0,
          staleFiles: 0,
        },
      };
    });
    const pending = runSessionsUsage({ ...BASE_USAGE_RANGE, projection: "overview" });
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      const result = readResult(await pending);
      expect(result.totals.totalTokens).toBe(256 * 7);
      expect(result.sessions).toHaveLength(50);
      expect(result.cacheStatus).toMatchObject({
        status: "partial",
        cachedFiles: 256,
        pendingFiles: 1,
      });
      expect(result.partial?.reason).toBe("time-budget");
      expect(result.overview?.queryWarnings).toContain(result.partial?.message);
      // A timed-out snapshot must not become a complete cached empty/subtotal result.
      load.mockImplementation(originalLoad);
      const retried = readResult(
        await runSessionsUsage({ ...BASE_USAGE_RANGE, projection: "overview" }),
      );
      expect(retried.partial).toBeUndefined();
      expect(retried.cacheStatus?.status).toBe("fresh");
    } finally {
      release.resolve();
      await pending;
      discovered.mockImplementation(originalDiscovery);
      load.mockImplementation(originalLoad);
      vi.useRealTimers();
    }
  });

  it("carries the remaining report allowance into later batches", async () => {
    const discovered = vi.mocked(discoverAllSessions);
    const originalDiscovery = discovered.getMockImplementation()!;
    const load = vi.mocked(loadSessionCostSummariesFromCache);
    const originalLoad = load.getMockImplementation()!;
    discovered.mockResolvedValue(
      Array.from({ length: 257 }, (_, index) => ({
        sessionId: `memory-${index}`,
        sessionFile: `/tmp/memory-${index}.jsonl`,
        mtime: 257 - index,
      })),
    );
    load.mockImplementation(async ({ sessions, reportBudgetBytes }) => ({
      summaries: sessions.map(() =>
        reportBudgetBytes === 0 ? null : { ...createEmptyCostUsageTotals(), totalTokens: 7 },
      ),
      remainingReportBytes: 0,
      cacheStatus: {
        status: reportBudgetBytes === 0 ? "partial" : "fresh",
        cachedFiles: reportBudgetBytes === 0 ? 0 : sessions.length,
        pendingFiles: reportBudgetBytes === 0 ? sessions.length : 0,
        staleFiles: 0,
      },
    }));
    try {
      const result = readResult(await runSessionsUsage(BASE_USAGE_RANGE));
      expect(load.mock.calls[1]?.[0].reportBudgetBytes).toBe(0);
      expect(result.totals.totalTokens).toBe(256 * 7);
      expect(result.cacheStatus).toMatchObject({
        status: "partial",
        cachedFiles: 256,
        pendingFiles: 1,
      });
    } finally {
      discovered.mockImplementation(originalDiscovery);
      load.mockImplementation(originalLoad);
    }
  });

  it("keeps an identical cold usage request alive when the first client disconnects", async ({
    signal: testSignal,
  }) => {
    const firstStarted = createDeferred<AbortSignal>();
    const secondStarted = createDeferred<AbortSignal>();
    const started = [firstStarted, secondStarted];
    const release = createDeferred();
    const firstClient = new AbortController();
    const secondClient = new AbortController();
    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const load = vi.mocked(loadSessionCostSummariesFromCache);
    const originalLoad = expectDefined(load.getMockImplementation(), "usage summary fixture");
    load.mockImplementation(async ({ sessions }) => {
      const signal = expectDefined(getAsyncWorkSignal(), "request-owned usage work signal");
      const aborted = createDeferred<never>();
      const abort = () => aborted.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      started.shift()?.resolve(signal);
      try {
        await Promise.race([release.promise, aborted.promise]);
        signal.throwIfAborted();
        return {
          summaries: sessions.map(() => ({ ...createEmptyCostUsageTotals(), totalTokens: 123 })),
          cacheStatus: {
            status: "fresh",
            cachedFiles: sessions.length,
            pendingFiles: 0,
            staleFiles: 0,
          },
        };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    });
    const first = runSessionsUsageMethod("sessions.usage", BASE_USAGE_RANGE, {
      signal: firstClient.signal,
      respond: firstRespond,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    let second: Promise<unknown> | undefined;
    try {
      const firstSignal = await withinTest(firstStarted.promise, testSignal);
      second = runSessionsUsageMethod("sessions.usage", BASE_USAGE_RANGE, {
        signal: secondClient.signal,
        respond: secondRespond,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      firstClient.abort(new Error("first usage client disconnected"));
      expect(await withinTest(first, testSignal)).toBe(firstSignal.reason);
      expect(firstSignal.aborted).toBe(true);
      expect(firstRespond).not.toHaveBeenCalled();
      const secondSignal = await withinTest(
        Promise.race([
          secondStarted.promise,
          second.then((error) => {
            expect(
              error,
              "connected usage client must not inherit the first disconnect",
            ).toBeUndefined();
            throw new Error("The connected usage client completed before releasing its read");
          }),
        ]),
        testSignal,
      );
      expect(secondSignal.aborted).toBe(false);
      expect(secondRespond).not.toHaveBeenCalled();
      release.resolve();
      expect(await withinTest(second, testSignal)).toBeUndefined();
      expect(readResult(secondRespond).totals.totalTokens).toBe(123);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
      load.mockImplementation(originalLoad);
    }
  });

  it("filters all overview candidates before pagination and keeps canonical filtered exports complete", async () => {
    const discovered = Array.from({ length: 1001 }, (_, index) => ({
      sessionId: `row-${index}`,
      sessionFile: `/tmp/row-${index}.jsonl`,
      mtime: index + 1,
    }));
    vi.mocked(discoverAllSessions)
      .mockResolvedValueOnce(discovered)
      .mockResolvedValueOnce(discovered);
    vi.mocked(loadSessionCostSummariesFromCache).mockImplementation(async (params) => ({
      summaries: params.sessions.map(({ sessionId }) => ({
        ...createEmptyCostUsageTotals(),
        sessionId,
        totalTokens: 7,
        firstActivity: 1,
        activityDates: ["2026-02-01"],
        dailyBreakdown: [
          {
            ...createEmptyCostUsageTotals(),
            date: "2026-02-01",
            totalTokens: 7,
            tokens: 7,
            cost: 0,
          },
        ],
      })),
      cacheStatus: {
        status: "fresh",
        cachedFiles: params.sessions.length,
        staleFiles: 0,
        pendingFiles: 0,
      },
    }));
    const overview = readResult(
      await runSessionsUsage({
        ...BASE_USAGE_RANGE,
        projection: "overview",
        offset: 50,
        query: "row-",
        sort: "recent",
        selectedSessions: ["agent:main:row-0"],
      }),
    );
    expect(overview.overview).toMatchObject({
      total: 1001,
      offset: 50,
      limit: 50,
      selectedSessionCount: 1,
    });
    expect(overview.sessions).toHaveLength(50);
    expect(overview.sessions[0]?.key).toBe("agent:main:row-950");
    expect(overview.totals.totalTokens).toBe(7);
    expect(overview.sessions[0]?.usage?.dailyBreakdown).toBeUndefined();
    const exported = readResult(
      await runSessionsUsage({
        ...BASE_USAGE_RANGE,
        query: "row-",
        limit: Number.MAX_SAFE_INTEGER,
      }),
    );
    expect(exported.sessions).toHaveLength(1001);
    expect(exported.totals.totalTokens).toBe(7007);
    expect(exported.sessions[0]?.usage?.dailyBreakdown).toHaveLength(1);
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

  it("rejects oversized usage selections before loading summaries", async () => {
    vi.mocked(discoverAllSessions).mockResolvedValueOnce(
      Array.from({ length: 20_001 }, (_, index) => ({
        sessionId: `budget-${index}`,
        sessionFile: `/tmp/budget-${index}.jsonl`,
        mtime: index + 1,
      })),
    );
    const respond = await runSessionsUsage(BASE_USAGE_RANGE);
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("20,000"),
      }),
    );
    expect(loadSessionCostSummariesFromCache).not.toHaveBeenCalled();
  });

  it("applies the usage size budget to the selected creator", async () => {
    const unrelated = Array.from({ length: 20_001 }, (_, index) => ({
      sessionId: `other-creator-${index}`,
      sessionFile: `/tmp/other-creator-${index}.jsonl`,
      mtime: index + 1,
    }));
    const selected = {
      sessionId: "selected-creator",
      sessionFile: "/tmp/selected-creator.jsonl",
      mtime: 1,
    };
    const store = Object.fromEntries(
      unrelated.map(({ sessionId, mtime }) => [
        `agent:main:${sessionId}`,
        { sessionId, updatedAt: mtime, createdActor: { type: "system" as const } },
      ]),
    );
    mockCombinedStore(
      store,
      Object.keys(store).map((key) => [key, "main"] as const),
    );
    vi.mocked(discoverAllSessions).mockResolvedValueOnce([...unrelated, selected]);
    vi.mocked(loadSessionCostSummariesFromCache).mockImplementationOnce(async ({ sessions }) => ({
      summaries: sessions.map(() => ({ ...createEmptyCostUsageTotals(), totalTokens: 7 })),
      cacheStatus: {
        status: "fresh",
        cachedFiles: sessions.length,
        pendingFiles: 0,
        staleFiles: 0,
      },
    }));
    const result = readResult(
      await runSessionsUsage({ ...BASE_USAGE_RANGE, creatorKey: '["unknown"]', limit: 1 }),
    );
    expect(result.sessions).toMatchObject([{ key: "agent:main:selected-creator" }]);
    expect(result.totals.totalTokens).toBe(7);
  });

  it.each(["available", "time budget"])(
    "uses resident authority when missing authority is %s",
    async (mode) => {
      await withOpenClawTestState({ label: "usage-context-resident" }, async (state) => {
        const storePath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
        const store: Record<string, SessionEntry> = {};
        const report = {
          source: "run" as const,
          generatedAt: 1,
          systemPrompt: { chars: 100, projectContextChars: 40, nonProjectContextChars: 60 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 0, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        };
        const discovered = Array.from({ length: 61 }, (_, index) => {
          const sessionId = `context-${index}`;
          const key = `agent:main:${sessionId}`;
          const entry = { sessionId, updatedAt: index + 1, systemPromptReport: report };
          store[key] = entry;
          replaceSessionEntrySync({ agentId: "main", sessionKey: key, storePath }, entry);
          return {
            sessionId,
            sessionFile: `sqlite:main:${sessionId}:${storePath}`,
            mtime: index + 1,
          };
        });
        mockCombinedStore(
          store,
          Object.keys(store).map((key) => [key, "main"] as const),
          storePath,
        );
        vi.mocked(discoverAllSessions).mockResolvedValueOnce(discovered);
        const projection = createSessionRowProjectionFixture({
          cfg: TEST_RUNTIME_CONFIG,
          store,
          storePath,
          agentId: "main",
        });
        const readCapabilityEntry = projection.readCapabilityEntry.bind(projection);
        const unavailableKey = "agent:main:context-60";
        vi.spyOn(projection, "readCapabilityEntry").mockImplementation((query) =>
          query.key === unavailableKey ? undefined : readCapabilityEntry(query),
        );
        const context = bindSessionRowProjection(
          { getRuntimeConfig: () => TEST_RUNTIME_CONFIG },
          () => projection,
        );
        const reads = vi.spyOn(sessionSharingPreparation, "prepareSessionMutationFacts");
        const started = createDeferred();
        const release = createDeferred();
        if (mode === "time budget") {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          reads.mockImplementationOnce(async () => {
            started.resolve();
            await release.promise;
            throw new sessionSharingPreparation.SessionMutationFactsUnavailableError();
          });
        }
        try {
          const pending = runSessionsUsageMethod(
            "sessions.usage",
            {
              range: "all",
              projection: "overview",
              query: "has:context",
              includeContextWeight: true,
            },
            { context },
          );
          if (mode === "time budget") {
            await started.promise;
            await vi.advanceTimersByTimeAsync(15_000);
          }
          const result = readResult(await pending);
          expect(result.overview?.total).toBe(mode === "time budget" ? 60 : 61);
          expect(result.sessions).toHaveLength(50);
          if (mode === "time budget") {
            expect(result.partial?.reason).toBe("time-budget");
            expect(result.sessions.some((row) => row.key === unavailableKey)).toBe(false);
          } else {
            expect(result.sessions.every((row) => row.hasContextWeight)).toBe(true);
            expect(
              result.sessions.find((row) => row.key === unavailableKey)?.contextWeight,
            ).toEqual(report);
          }
          expect(reads.mock.calls.map(([params]) => params.sessionKey)).toEqual([unavailableKey]);
        } finally {
          release.resolve();
          vi.useRealTimers();
          reads.mockRestore();
          projection.dispose();
        }
      });
    },
  );

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

    TEST_RUNTIME_CONFIG = { ...TEST_RUNTIME_CONFIG };
    const partialEntry = { ...entry, usageFamilySessionIds: ["current", "old"] };
    mockStoredSession(storeKey, partialEntry);
    mockCombinedStore({ [storeKey]: partialEntry }, [[storeKey, "opus"]]);
    vi.mocked(discoverAllSessions).mockResolvedValueOnce([
      { sessionId: "old", sessionFile: oldSessionFile, mtime: 1_000 },
    ]);
    vi.mocked(loadSessionCostSummariesFromCache).mockImplementationOnce(async ({ sessions }) => ({
      summaries: sessions.map(({ sessionId }) =>
        sessionId === "old" ? null : { ...createEmptyCostUsageTotals(), totalTokens: 20 },
      ),
      cacheStatus: { status: "partial", cachedFiles: 1, pendingFiles: 1, staleFiles: 0 },
    }));
    const partial = readResult(
      await runSessionsUsage({
        ...BASE_USAGE_RANGE,
        key: storeKey,
        groupBy: "family",
        includeHistorical: true,
      }),
    );
    expect(partial.sessions).toMatchObject([
      { key: storeKey, computing: true, usage: { totalTokens: 20 } },
    ]);
    expect(partial.totals.totalTokens).toBe(20);
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
