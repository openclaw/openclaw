import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { DEFAULT_WORKER_PENDING_BYTES } from "@openclaw/worker-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import type { SessionCostSummary } from "../../infra/session-cost-usage.types.js";
import { workerTaskPoolEntrypoints } from "../../infra/worker-task-pool-runtime.test-support.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type {
  PoolFixtureInput,
  PoolFixtureResult,
} from "../../infra/worker-task-pool.test-support.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import * as sessionSharingPreparation from "../session-sharing-preparation.js";

vi.mock("../../config/config.js", () => ({ getRuntimeConfig: vi.fn(() => TEST_RUNTIME_CONFIG) }));
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
  const loadSessionCostSummariesFromCache = vi.fn(async ({ sessions }: { sessions: unknown[] }) =>
    tokenBatch(sessions.length),
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
    loadSessionCostSummariesFromCache,
    // Overview reads fold the same per-session fixture into family rows.
    loadSessionUsageOverviewFromCache: vi.fn(
      async (params: Parameters<typeof actual.loadSessionUsageOverviewFromCache>[0]) =>
        (await import("./usage.test-support.js")).overviewFromSessionSummaries(
          params,
          loadSessionCostSummariesFromCache,
        ),
    ),
    loadSessionUsageTimeSeries: vi.fn(async () => ({ sessionId: "s-opus", points: [] })),
    loadSessionLogs: vi.fn(async () => []),
  };
});
import {
  discoverAllSessions,
  loadSessionCostSummariesFromCache,
  loadSessionUsageOverviewFromCache,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
  resolveUsageSessionSource,
} from "../../infra/session-cost-usage.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import {
  contextReport,
  createUsageSessionStoreFixture,
  freshUsageBatch,
  invokeUsage,
  overviewFromSessionSummaries,
  usageReply,
  usageTotals,
  type UsageSessionStoreFixture,
} from "./usage.test-support.js";

const summaryLoader = vi.mocked(loadSessionCostSummariesFromCache);
const discovery = vi.mocked(discoverAllSessions);

let TEST_RUNTIME_CONFIG: OpenClawConfig = {
  session: {},
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: {}, opus: {} },
  },
};
let projectionFixture: UsageSessionStoreFixture = { store: {} };
const BASE_USAGE_RANGE = { startDate: "2026-02-01", endDate: "2026-02-02", limit: 10 };
function tokenBatch(count: number, totalTokens = 0) {
  return freshUsageBatch(
    Array.from({ length: count }, () => ({ ...createEmptyCostUsageTotals(), totalTokens })),
  );
}
function discoveredRows(prefix: string, count: number, newestFirst = false) {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `${prefix}-${index}`,
    sessionFile: `/tmp/${prefix}-${index}.jsonl`,
    mtime: newestFirst ? count - index : index + 1,
  }));
}
function runSessionsUsageMethod(
  method: "sessions.usage" | "sessions.usage.timeseries" | "sessions.usage.logs",
  params: Record<string, unknown>,
  options: Parameters<typeof invokeUsage>[3] = {},
) {
  return invokeUsage(method, params, TEST_RUNTIME_CONFIG, {
    rows: projectionFixture,
    getRuntimeConfig: () => TEST_RUNTIME_CONFIG,
    ...options,
  });
}
const runSessionsUsage = (params: Record<string, unknown>) =>
  runSessionsUsageMethod("sessions.usage", params);
function readResult(respond: ReturnType<typeof vi.fn>): SessionsUsageResult {
  const [ok, payload] = usageReply(respond);
  expect(ok).toBe(true);
  return payload as SessionsUsageResult;
}
async function readSessionsUsage(params: Record<string, unknown>) {
  return readResult(await runSessionsUsage({ ...BASE_USAGE_RANGE, ...params }));
}

beforeEach(() => {
  TEST_RUNTIME_CONFIG = { ...TEST_RUNTIME_CONFIG };
  projectionFixture = { store: {} };
  vi.clearAllMocks();
});

it.each(["sharing", "configuration"])(
  "keeps visible usage when unrelated %s changes during its worker read",
  async (change) => {
    const started = createDeferred();
    const released = createDeferred();
    summaryLoader.mockImplementationOnce(async () => {
      started.resolve();
      await released.promise;
      return tokenBatch(1, 123);
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
    summaryLoader.mockImplementationOnce(async () => {
      const signal = getAsyncWorkSignal();
      started.resolve(signal);
      await release.promise;
      return tokenBatch(1);
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

it("returns complete family usage while other reports occupy worker input capacity", async () => {
  const families = [
    { key: "agent:opus:capacity-first", prefix: "capacity-first", count: 2049 },
    { key: "agent:opus:capacity-second", prefix: "capacity-second", count: 2048 },
  ];
  const storePath =
    "/tmp/synthetic-usage-admission/retained-team-shaped-session-cost-usage-fixture/agents/opus/agent/openclaw-agent.sqlite";
  const rows = families.flatMap(({ prefix, count }) =>
    Array.from({ length: count }, (_, index) => {
      const sessionId = `${prefix}-${index}`;
      const sessionFile = `sqlite:opus:${sessionId}:${storePath}`;
      return {
        sessionId,
        sessionFile,
        mtime: 1000,
      };
    }),
  );
  projectionFixture = createUsageSessionStoreFixture(
    Object.fromEntries(
      families.map(({ key, prefix, count }) => [
        key,
        {
          sessionId: `${prefix}-0`,
          updatedAt: 1000,
          usageFamilyKey: key,
          usageFamilySessionIds: Array.from({ length: count }, (_, index) => `${prefix}-${index}`),
        },
      ]),
    ),
    families.map(({ key }) => [key, "opus"] as const),
  );
  // Leave 256 KiB for reports without allocating the background payload. Two
  // slots let a report finish while the background preparation remains admitted.
  const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
    workerUrl: resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker),
    maxWorkers: 2,
    idleTimeoutMs: 0,
  });
  const release = createDeferred();
  const backgroundBytes = DEFAULT_WORKER_PENDING_BYTES - 256 * 1024;
  const background = pool.run(
    async () => {
      await release.promise;
      return { label: "background usage reports" };
    },
    { inputBytes: backgroundBytes },
  );
  const backgroundOutcome = Promise.allSettled([background]);
  const originalDiscovery = discovery.getMockImplementation()!;
  const originalLoad = summaryLoader.getMockImplementation()!;
  try {
    // Fixture sanity: the full request is larger than the remaining real budget.
    // The admission charge below omits envelope fields, so it is conservative.
    expect(2 * JSON.stringify({ sessions: rows }).length).toBeGreaterThan(
      DEFAULT_WORKER_PENDING_BYTES - backgroundBytes,
    );
    discovery.mockResolvedValue(rows);
    summaryLoader.mockImplementation(async ({ sessions }) => {
      await pool.run(
        { label: "family usage report" },
        { inputBytes: 2 * JSON.stringify({ sessions }).length },
      );
      return freshUsageBatch(
        sessions.map(({ sessionId }) =>
          sessionId?.startsWith("capacity-first-") ? usageTotals(7, 0.125) : usageTotals(11, 0.25),
        ),
      );
    });
    const result = await readSessionsUsage({ agentId: "opus", groupBy: "family" });
    expect(result.totals).toMatchObject({ totalTokens: 36_871, totalCost: 768.125 });
    expect(result.cacheStatus).toMatchObject({ status: "fresh", pendingFiles: 0, staleFiles: 0 });
    expect(result.partial).toBeUndefined();
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "agent:opus:capacity-first",
          usage: expect.objectContaining({ totalTokens: 14_343, totalCost: 256.125 }),
        }),
        expect.objectContaining({
          key: "agent:opus:capacity-second",
          usage: expect.objectContaining({ totalTokens: 22_528, totalCost: 512 }),
        }),
      ]),
    );
  } finally {
    discovery.mockImplementation(originalDiscovery);
    summaryLoader.mockImplementation(originalLoad);
    release.resolve();
    await backgroundOutcome;
    await pool.close();
  }
});

it("keeps completed batches after exhausting the report allowance", async () => {
  const originalDiscovery = discovery.getMockImplementation()!;
  const originalLoad = summaryLoader.getMockImplementation()!;
  let elapsed = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  discovery.mockResolvedValue(discoveredRows("budget", 1025, true));
  summaryLoader.mockImplementation(
    async ({ sessions, reportBudgetBytes, maxPublicationWaitMs }) => {
      elapsed += maxPublicationWaitMs ?? 0;
      return {
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
      };
    },
  );
  try {
    const result = await readSessionsUsage({});
    expect(result).toMatchObject({
      totals: { totalTokens: 256 * 7 },
      cacheStatus: { status: "partial", cachedFiles: 256, pendingFiles: 769 },
    });
    expect(summaryLoader.mock.calls[1]?.[0].reportBudgetBytes).toBe(0);
    expect(elapsed, "publication waiting is shared by every batch in the report").toBe(100);
  } finally {
    clock.mockRestore();
    discovery.mockImplementation(originalDiscovery);
    summaryLoader.mockImplementation(originalLoad);
  }
});

it("keeps completed agent overviews after exhausting time", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const started = createDeferred();
  const release = createDeferred();
  const originalDiscovery = discovery.getMockImplementation()!;
  const overview = vi.mocked(loadSessionUsageOverviewFromCache);
  const originalOverview = overview.getMockImplementation()!;
  discovery.mockImplementation(async ({ agentId }) =>
    agentId === "main"
      ? discoveredRows("budget-main", 256, true)
      : agentId === "opus"
        ? discoveredRows("budget-opus", 1)
        : [],
  );
  overview.mockImplementation(async (params) => {
    if (params.agentId === "opus") {
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
    return overviewFromSessionSummaries(params, async ({ sessions }) =>
      tokenBatch(sessions.length, 7),
    );
  });
  const params = { ...BASE_USAGE_RANGE, agentScope: "all", projection: "overview" };
  const pending = runSessionsUsage(params);
  try {
    await started.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    const result = readResult(await pending);
    // Each agent reads its overview in one worker pass; a finished agent keeps its subtotal.
    expect(result).toMatchObject({
      totals: { totalTokens: 256 * 7 },
      cacheStatus: { status: "partial", cachedFiles: 256, pendingFiles: 1 },
    });
    expect(result.sessions).toHaveLength(50);
    expect(result.partial?.reason).toBe("time-budget");
    expect(result.overview?.queryWarnings).toContain(result.partial?.message);
    // A failed refresh can serve the prior subtotal, but must retain its warning.
    overview.mockRejectedValueOnce(new Error("Usage store unavailable"));
    const fallback = await readSessionsUsage(params);
    expect(fallback.partial).toEqual(result.partial);
    // A timed-out subtotal must not be cached as a complete result.
    overview.mockImplementation(originalOverview);
    const retried = await readSessionsUsage(params);
    expect(retried.partial).toBeUndefined();
    expect(retried.cacheStatus?.status).toBe("fresh");
  } finally {
    release.resolve();
    await pending;
    discovery.mockImplementation(originalDiscovery);
    overview.mockImplementation(originalOverview);
    vi.useRealTimers();
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
  const load = summaryLoader;
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
      return tokenBatch(sessions.length, 123);
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
  const discovered = discoveredRows("row", 1001);
  discovery.mockResolvedValueOnce(discovered).mockResolvedValueOnce(discovered);
  summaryLoader.mockImplementation(async (params) =>
    freshUsageBatch(
      params.sessions.map(({ sessionId }) => ({
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
    ),
  );
  const overview = await readSessionsUsage({
    projection: "overview",
    offset: 50,
    query: "row-",
    sort: "recent",
    selectedSessions: ["agent:main:row-0"],
  });
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
  const exported = await readSessionsUsage({
    query: "row-",
    limit: Number.MAX_SAFE_INTEGER,
  });
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
  discovery.mockResolvedValueOnce(discoveredRows("budget", 20_001));
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
  await withOpenClawTestState({ label: "usage-creator-budget" }, async (state) => {
    const unrelated = discoveredRows("other-creator", 20_001);
    const selected = {
      sessionId: "selected-creator",
      sessionFile: "/tmp/selected-creator.jsonl",
      mtime: 1,
    };
    const key = "agent:main:selected-creator";
    const entry: SessionEntry = {
      sessionId: selected.sessionId,
      updatedAt: selected.mtime,
      createdActor: { type: "system" },
    };
    const storePath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
    replaceSessionEntrySync({ agentId: "main", sessionKey: key, storePath }, entry);
    projectionFixture = createUsageSessionStoreFixture(
      { [key]: entry },
      [[key, "main"]],
      () => storePath,
    );
    discovery.mockResolvedValueOnce([...unrelated, selected]);
    summaryLoader.mockImplementationOnce(async ({ sessions }) => tokenBatch(sessions.length, 7));
    const result = await readSessionsUsage({ creatorKey: '["system",null]', limit: 1 });
    expect(result.sessions).toMatchObject([{ key }]);
    expect(result.totals.totalTokens).toBe(7);
  });
});

it.each(["available", "time budget"])(
  "uses resident authority when missing authority is %s",
  async (mode) => {
    await withOpenClawTestState({ label: "usage-context-resident" }, async (state) => {
      const storePath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
      const store: Record<string, SessionEntry> = {};
      const report = contextReport(1);
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
      projectionFixture = createUsageSessionStoreFixture(
        store,
        Object.keys(store).map((key) => [key, "main"] as const),
        () => storePath,
      );
      discovery.mockResolvedValueOnce(discovered);
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
          expect(result.sessions.find((row) => row.key === unavailableKey)?.contextWeight).toEqual(
            report,
          );
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
      const response = await readSessionsUsage({
        ...params,
        startDate: date,
        endDate: date,
      });
      expect(loadSessionCostSummariesFromCache).toHaveBeenCalledWith(
        expect.objectContaining({
          startMs: Date.parse(start),
          endMs: Date.parse(end) - 1,
          dayBucket,
        }),
      );
      expect(response).toMatchObject({ startDate: date, endDate: date });
    });
  },
);

it("does not resolve specific usage keys through out-of-scope sessionId matches", async () => {
  await withOpenClawTestState({ label: "usage" }, async (state) => {
    const sessionFile = path.join(state.sessionsDir("opus"), "shared.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "");
    projectionFixture = createUsageSessionStoreFixture(
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
    expect((await readSessionsUsage({ key: "shared", agentId: "opus" })).sessions).toMatchObject([
      { key: "agent:opus:shared", agentId: "opus" },
    ]);
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
  const tools = (...rows: Array<readonly [string, number]>) => ({
    totalCalls: rows.reduce((sum, [, count]) => sum + count, 0),
    uniqueTools: rows.length,
    tools: rows.map(([name, count]) => ({ name, count })),
  });

  const oldSessionFile = "/tmp/old.jsonl.reset.2026-02-01T00-00-00.000Z";
  const oldestSessionFile = "/tmp/oldest.jsonl.reset.2026-01-31T00-00-00.000Z";
  const entry: SessionEntry = {
    sessionId: "current",
    updatedAt: 1_000,
    usageFamilyKey: storeKey,
    usageFamilySessionIds: ["old", "current", "oldest"],
  };
  discovery.mockResolvedValueOnce([
    { sessionId: "old", sessionFile: oldSessionFile, mtime: 1_000 },
    { sessionId: "oldest", sessionFile: oldestSessionFile, mtime: 900 },
  ]);

  projectionFixture = createUsageSessionStoreFixture({ [storeKey]: entry }, [[storeKey, "opus"]]);
  summaryLoader.mockImplementation(async ({ sessions }) => {
    const summaries = sessions.map((session) => {
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
      const totals = usageTotals(totalTokens, totalCost);
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
        toolUsage: oldest
          ? tools(["z-first", 1])
          : historical
            ? tools(["a-second", 2])
            : tools(["z-first", 2], ["a-second", 1]),
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
    });
    return freshUsageBatch(summaries);
  });

  const result = await readSessionsUsage({
    key: storeKey,
    groupBy: "family",
    includeHistorical: true,
  });

  const models = [
    { provider: "fixture", model: "bedrock::arn" },
    { provider: "fixture::bedrock", model: "arn" },
  ];
  const dailyModels = [
    { provider: "fixture", model: "bedrock:arn" },
    { provider: "fixture:bedrock", model: "arn" },
  ];
  expect(result).toMatchObject({
    sessions: [
      {
        key: storeKey,
        scope: "family",
        includedSessionIds: ["current", "old", "oldest"],
        usage: {
          totalTokens: 60,
          totalCost: expect.closeTo(0.06),
          dailyBreakdown: [
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
          ],
          activityDates: ["2026-02-01", "2026-02-02"],
          messageCounts: { total: 3 },
          dailyMessageCounts: [
            { date: "2026-02-01", total: 2 },
            { date: "2026-02-02", total: 1 },
          ],
          utcQuarterHourMessageCounts: [
            { date: "2026-02-01", quarterIndex: 2, total: 2 },
            { date: "2026-02-02", quarterIndex: 2, total: 1 },
          ],
          utcQuarterHourTokenUsage: [
            { date: "2026-02-01", quarterIndex: 2, totalTokens: 30, totalCost: 0.03 },
            { date: "2026-02-02", quarterIndex: 2, totalTokens: 30, totalCost: 0.03 },
          ],
          dailyLatency: [
            { date: "2026-02-01", count: 3, avgMs: 20, p95Ms: 30, minMs: 10, maxMs: 30 },
            { date: "2026-02-02", count: 3, avgMs: 7, p95Ms: 9, minMs: 5, maxMs: 9 },
          ],
          latency: { count: 6, avgMs: 13.5, p95Ms: 30, minMs: 5, maxMs: 30 },
          // a-second overtakes z-first before their counts tie again.
          toolUsage: {
            tools: [
              { name: "a-second", count: 3 },
              { name: "z-first", count: 3 },
            ],
          },
          modelUsage: models,
          dailyModelUsage: [dailyModels[0], dailyModels[1], dailyModels[0]],
        },
      },
    ],
    aggregates: { byModel: models, modelDaily: [dailyModels[1], dailyModels[0], dailyModels[0]] },
    totals: { totalTokens: 60, totalCost: expect.closeTo(0.06) },
  });
  expect(sources).toEqual(sourceSnapshots);

  TEST_RUNTIME_CONFIG = { ...TEST_RUNTIME_CONFIG };
  const partialEntry = { ...entry, usageFamilySessionIds: ["current", "old"] };
  projectionFixture = createUsageSessionStoreFixture({ [storeKey]: partialEntry }, [
    [storeKey, "opus"],
  ]);
  discovery.mockResolvedValueOnce([
    { sessionId: "old", sessionFile: oldSessionFile, mtime: 1_000 },
  ]);
  summaryLoader.mockImplementationOnce(async ({ sessions }) => ({
    summaries: sessions.map(({ sessionId }) =>
      sessionId === "old" ? null : { ...createEmptyCostUsageTotals(), totalTokens: 20 },
    ),
    cacheStatus: { status: "partial", cachedFiles: 1, pendingFiles: 1, staleFiles: 0 },
  }));
  const partial = await readSessionsUsage({
    key: storeKey,
    groupBy: "family",
    includeHistorical: true,
  });
  expect(partial.sessions).toMatchObject([
    { key: storeKey, computing: true, usage: { totalTokens: 20 } },
  ]);
  expect(partial.totals.totalTokens).toBe(20);
});

it("prefers the deterministic store key when duplicate sessionIds exist", async () => {
  const preferredKey = "agent:opus:acp:run-dup";
  projectionFixture = createUsageSessionStoreFixture(
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
  expect((await readSessionsUsage({ key: "agent:opus:run-dup" })).sessions).toMatchObject([
    { key: preferredKey },
  ]);
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
  vi.mocked(resolveGatewaySessionStoreTargetInWorker).mockResolvedValueOnce({
    agentId: "opus",
    canonicalKey: key,
    store: { [key]: { sessionId: "stale", updatedAt: 1_000 } },
    storeKeys: [key],
    storePath: "/tmp/agents/opus/agent/openclaw-agent.sqlite",
  });
  vi.mocked(resolveUsageSessionSource).mockResolvedValueOnce(undefined);
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
