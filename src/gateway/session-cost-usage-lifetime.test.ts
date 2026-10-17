import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import * as aggregation from "../infra/session-cost-usage-aggregation.js";
import * as cacheRuntime from "../infra/session-cost-usage-cache-runtime.js";
import { onSessionCostUsageUpdated } from "../infra/session-cost-usage-events.js";
import { closeAgentWorkAdmissions } from "../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { buildUsageOverview } from "../shared/usage-overview.js";
import type { SessionCostUsagePublication } from "../shared/usage-types.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import {
  closeOpenClawAgentDatabasesAsync,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as agentList from "./agent-list.js";
import { loadCostUsageSummaryCached } from "./server-methods/usage-result-cache.js";
import { startSessionCostUsageProjectionLifetime } from "./session-cost-usage-lifetime.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps usage backfill and all-agent totals available while another agent's deletion drains", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config = { agents: { entries: { main: {}, retiring: {} } } };
    setRuntimeConfigSnapshot(config);
    const timestamp = Date.parse("2026-09-18T12:00:00Z");
    for (const [agentId, tokens] of [
      ["main", 10],
      ["retiring", 900],
    ] as const) {
      const target = {
        agentId,
        sessionKey: `agent:${agentId}:usage`,
        sessionId: `${agentId}-usage`,
      };
      replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: timestamp });
      await persistSessionTranscriptTurn(target, {
        messages: [
          {
            message: {
              role: "assistant",
              content: "Synthetic usage",
              timestamp,
              usage: {
                input: tokens,
                output: 0,
                totalTokens: tokens,
                cost: { total: tokens / 100 },
              },
            },
          },
        ],
        touchSessionEntry: false,
      });
      await aggregation.refreshCostUsageCacheForAgent({ config, agentId });
    }
    const cost = () =>
      loadCostUsageSummaryCached({
        config,
        agentScope: "all",
        startMs: timestamp - 1,
        endMs: timestamp + 1,
      });
    expect((await cost()).totals.totalTokens).toBe(910);
    const capturedRoster = createDeferred();
    const releaseRoster = createDeferred();
    const readRoster = agentList.listGatewayAgentsBasic;
    const roster = vi
      .spyOn(agentList, "listGatewayAgentsBasic")
      .mockImplementationOnce(async (cfg) => {
        const result = await readRoster(cfg);
        capturedRoster.resolve();
        await releaseRoster.promise;
        return result;
      });
    const reading = loadCostUsageSummaryCached({
      config,
      agentScope: "all",
      startMs: timestamp - 1,
      endMs: timestamp + 2,
    });
    const readSettled = Promise.allSettled([reading]);
    await withinTest(capturedRoster.promise, signal);
    vi.useFakeTimers();
    const queued = new AsyncWorkScope();
    queued.run(() =>
      cacheRuntime.requestCostUsageCacheRefresh({
        config,
        agentId: "retiring",
        storePath: resolveSessionStorePathForScope({ agentId: "retiring" }, config),
      }),
    );
    const reopen = closeAgentWorkAdmissions({
      agentId: "retiring",
      reason: new Error("Agent retiring deletion is draining active work."),
    });
    beginAgentDeletionJournal({
      agentId: "retiring",
      operationId: "usage-retiring",
      agentDir: state.agentDir("retiring"),
      workspaceDir: state.path("retiring-workspace"),
      sessionsDir: state.sessionsDir("retiring"),
      deleteFiles: false,
      phase: "draining",
    });
    const publications: SessionCostUsagePublication[] = [];
    const offUsage = onSessionCostUsageUpdated((event) => publications.push(event));
    const refresh = vi.spyOn(aggregation, "refreshCostUsageCacheForAgent");
    const warn = vi.fn();
    const lifetime = startSessionCostUsageProjectionLifetime({ getConfig: () => config, warn });
    try {
      releaseRoster.resolve();
      expect.soft(await cost()).toMatchObject({
        totals: { totalTokens: 10, totalCost: 0.1 },
        cacheStatus: { status: "fresh" },
      });
      await withinTest(roster.mock.results.at(-1)!.value, signal);
      await vi.advanceTimersByTimeAsync(0);
      const refreshed = await withinTest(
        Promise.allSettled(refresh.mock.results.map((result) => result.value)),
        signal,
      );
      await withinTest(
        queued.runWhenIdle(() => {}),
        signal,
      );
      await lifetime.stop();
      await queued.drain();
      expect(refreshed).not.toHaveLength(0);
      expect.soft(refreshed.filter((result) => result.status === "rejected")).toEqual([]);
      expect.soft(publications.filter((event) => event.usageRefreshFailed)).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(await cost()).toMatchObject({
        totals: { totalTokens: 10, totalCost: 0.1 },
        cacheStatus: { status: "fresh" },
      });
      expect(await withinTest(reading, signal)).toMatchObject({ totals: { totalTokens: 10 } });
    } finally {
      releaseRoster.resolve();
      await lifetime.stop();
      queued.beginClose();
      await queued.drain();
      await readSettled;
      offUsage();
      reopen();
      vi.useRealTimers();
    }
  });
});

it("coalesces usage, flushes exact reads, and recovers deferred appends after restart", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(config);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:usage-coalescing",
      sessionId: "usage-coalescing",
    };
    const timestamp = Date.parse("2026-09-18T12:00:00Z");
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: timestamp });
    const append = (role: string, tokens?: number, updateMode: "inline" | "file-only" = "inline") =>
      persistSessionTranscriptTurn(target, {
        messages: [
          {
            message: {
              role,
              content: "Synthetic usage",
              timestamp,
              ...(tokens === undefined
                ? {}
                : {
                    usage: {
                      input: tokens,
                      output: 0,
                      totalTokens: tokens,
                      cost: { total: tokens / 100 },
                    },
                  }),
            },
          },
        ],
        updateMode,
        touchSessionEntry: false,
      });
    await append("assistant", 10);
    await aggregation.refreshCostUsageCacheForAgent({ config, agentId: target.agentId });
    const roster = await agentList.listGatewayAgentsBasic(config);
    const listAgents = vi
      .spyOn(agentList, "listGatewayAgentsBasic")
      .mockResolvedValue({ ...roster, agents: [] });
    const refresh = vi.spyOn(aggregation, "refreshCostUsageCacheForAgent");
    const lifetime = startSessionCostUsageProjectionLifetime({
      getConfig: () => config,
      warn: vi.fn(),
    });
    const sessions = [
      {
        key: target.sessionKey,
        agentId: target.agentId,
        instances: [
          {
            sessionId: target.sessionId,
            sessionFile: formatSqliteSessionFileMarker({
              ...target,
              storePath: resolveSessionStorePathForScope(target, config),
            }),
          },
        ],
      },
    ];
    const overview = async () => {
      const cached = await cacheRuntime.loadSessionCostSummariesFromCache({
        config,
        agentId: target.agentId,
        sessions: sessions.flatMap((session) => session.instances),
        requestRefresh: false,
      });
      return {
        ...buildUsageOverview({
          rows: sessions.map((session, index) => ({
            key: session.key,
            agentId: session.agentId,
            usage: cached.summaries[index] ?? null,
            computing: cached.summaries[index] ? undefined : true,
          })),
          options: {},
          dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
        }),
        cacheStatus: cached.cacheStatus,
      };
    };
    vi.useFakeTimers();
    try {
      const cost = () =>
        loadCostUsageSummaryCached({
          config,
          agentId: target.agentId,
          startMs: timestamp - 1,
          endMs: timestamp + 1,
        });
      expect((await cost()).totals.totalTokens).toBe(10);
      await append("user");
      await append("system");
      await vi.advanceTimersByTimeAsync(1000);
      expect(refresh).not.toHaveBeenCalled();

      await append("assistant", 20);
      await vi.advanceTimersByTimeAsync(50);
      await append("assistant", 30);
      expect(refresh).not.toHaveBeenCalled();
      // The outer RPC memo must not hide an append waiting for its quiet period.
      expect((await cost()).totals.totalTokens).toBe(60);
      expect(await overview()).toMatchObject({
        totals: { totalTokens: 60 },
        aggregates: { messages: { user: 1, assistant: 3 } },
        cacheStatus: { status: "fresh" },
      });
      expect(refresh).toHaveBeenCalledTimes(1);

      // Invalidation-only publications also cover rewrites and compaction.
      await append("assistant", 40, "file-only");
      expect(await overview()).toMatchObject({
        totals: { totalTokens: 100 },
        cacheStatus: { status: "fresh" },
      });
      expect(refresh).toHaveBeenCalledTimes(2);

      await append("assistant", 50);
      await lifetime.stop();
      expect(refresh).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
      // Lose the dirty queue and worker caches as on process exit, keeping only
      // the committed transcript and the older durable rollup.
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      listAgents.mockRestore();
      const recovered = createDeferred();
      const offUsage = onSessionCostUsageUpdated(() => recovered.resolve());
      const restarted = startSessionCostUsageProjectionLifetime({
        getConfig: () => config,
        warn: vi.fn(),
      });
      try {
        await withinTest(recovered.promise, signal);
        await refresh.mock.results.at(-1)?.value;
        expect(await overview()).toMatchObject({
          totals: { totalTokens: 150 },
          cacheStatus: { status: "fresh" },
        });
      } finally {
        offUsage();
        await restarted.stop();
      }
    } finally {
      await lifetime.stop();
      vi.useRealTimers();
    }
  });
});

it("projects committed usage after startup preparation without borrowing its expired context", ({
  signal,
  onTestFinished,
}) => {
  const run = withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = { agents: { entries: { main: {} } } };
    const target = {
      agentId: "main",
      sessionKey: "agent:main:usage-admission",
      sessionId: "usage-admission",
    };
    const timestamp = Date.parse("2026-09-18T12:00:00Z");
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: timestamp });
    const append = (tokens: number) =>
      persistSessionTranscriptTurn(target, {
        config,
        messages: [
          {
            message: {
              role: "assistant",
              content: "Synthetic usage",
              timestamp,
              usage: {
                input: tokens,
                output: 0,
                totalTokens: tokens,
                cost: { total: tokens / 100 },
              },
            },
          },
        ],
        touchSessionEntry: false,
      });
    await append(10);
    const publisher = new AsyncLocalStorage<"owner" | "preparation">();
    const firstStarted = createDeferred();
    const nextStarted = createDeferred();
    const releaseRefresh = createDeferred();
    let holdRefresh = false;
    const outcomes: Array<
      Promise<
        | { ok: true; context: string | undefined }
        | { ok: false; context: string | undefined; error: unknown }
      >
    > = [];
    const actualRefresh = aggregation.refreshCostUsageCacheForAgent;
    vi.spyOn(aggregation, "refreshCostUsageCacheForAgent").mockImplementation((params) => {
      const context = publisher.getStore();
      const operation = (async () => {
        if (holdRefresh) {
          await releaseRefresh.promise;
        }
        return actualRefresh(params);
      })();
      outcomes.push(
        operation.then(
          () => ({ ok: true as const, context }),
          (error: unknown) => ({ ok: false as const, context, error }),
        ),
      );
      firstStarted.resolve();
      if (outcomes.length > 1) {
        nextStarted.resolve();
      }
      return operation;
    });
    const requested = vi.spyOn(cacheRuntime, "requestCostUsageCacheRefresh");
    const roster = vi.spyOn(agentList, "listGatewayAgentsBasic");
    const publications: SessionCostUsagePublication[] = [];
    const offUsage = onSessionCostUsageUpdated((event) => publications.push(event));
    const warn = vi.fn();
    const lifetime = publisher.run("owner", () =>
      startSessionCostUsageProjectionLifetime({ getConfig: () => config, warn }),
    );
    let pendingRefreshes = -1;
    try {
      await withinTest(firstStarted.promise, signal);
      expect(await withinTest(outcomes[0]!, signal)).toEqual({ ok: true, context: "owner" });
      const initialRequests = requested.mock.calls.length;
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId: target.agentId,
        paths: [resolveOpenClawAgentSqlitePath({ agentId: target.agentId })],
        pending: true,
        reason: "Startup preparation is pending",
      });
      recordAgentDatabaseAdmissions([refusal], { source: "startup" });
      holdRefresh = true;
      await preparePendingAgentDatabase(refusal, { assertCurrent() {} }, () =>
        publisher.run("preparation", async () => {
          await append(20);
          sessionChanges.emit({ all: true, scope: { agentId: target.agentId, topology: true } });
          await roster.mock.results.at(-1)?.value;
          // Let any incorrectly accepted queue enter aggregation before expiring its borrow.
          if (requested.mock.calls.length > initialRequests) {
            await withinTest(nextStarted.promise, signal);
          }
          pendingRefreshes = outcomes.length - 1;
        }),
      );
      // The admission owner's completion publication is the only recovery trigger.
      await roster.mock.results.at(-1)?.value;
      await withinTest(nextStarted.promise, signal);
      releaseRefresh.resolve();
      const settled = await withinTest(Promise.all(outcomes), signal);
      await lifetime.stop();
      const summary = await cacheRuntime.loadCostUsageSummaryFromCache({
        config,
        agentId: target.agentId,
        startMs: timestamp - 1,
        endMs: timestamp + 1,
        requestRefresh: false,
      });
      expect.soft(summary).toMatchObject({
        totals: { totalTokens: 30 },
        cacheStatus: { status: "fresh" },
      });
      expect.soft(pendingRefreshes).toBe(0);
      expect(settled).toEqual([
        { ok: true, context: "owner" },
        { ok: true, context: "owner" },
      ]);
      expect(publications.filter((event) => event.usageRefreshFailed)).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      releaseRefresh.resolve();
      await Promise.all(outcomes);
      await lifetime.stop();
      offUsage();
    }
  });
  onTestFinished(() => run);
  return run;
});
