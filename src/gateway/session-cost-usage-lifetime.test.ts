import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-writable.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import * as aggregation from "../infra/session-cost-usage-aggregation.js";
import * as cacheRuntime from "../infra/session-cost-usage-cache-runtime.js";
import { sessionCostUsageNotifications } from "../infra/session-cost-usage-events.js";
import { closeAgentWorkAdmissions } from "../sessions/session-controller.lifecycle.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
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
  sessionCostUsageNotifications.onUpdated = () => {};
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function appendUsage(
  target: Parameters<typeof persistSessionTranscriptTurn>[0],
  timestamp: number,
  tokens?: number,
  role = "assistant",
  updateMode: "inline" | "file-only" = "inline",
  config?: Parameters<typeof persistSessionTranscriptTurn>[1]["config"],
) {
  const usage =
    tokens === undefined
      ? undefined
      : {
          input: tokens,
          output: 0,
          totalTokens: tokens,
          cost: { total: tokens / 100 },
        };
  return persistSessionTranscriptTurn(target, {
    config,
    messages: [
      { message: { role, content: "Synthetic usage", timestamp, ...(usage ? { usage } : {}) } },
    ],
    updateMode,
    touchSessionEntry: false,
  });
}

const fresh = (totalTokens: number, totalCost?: number) => ({
  totals: { totalTokens, ...(totalCost === undefined ? {} : { totalCost }) },
  cacheStatus: { status: "fresh" },
});
const sessionFresh = (totalTokens: number) => ({
  summaries: [{ totalTokens }],
  cacheStatus: { status: "fresh" },
});
const timestamp = Date.parse("2026-09-18T12:00:00Z");
const mainConfig = () => ({ agents: { entries: { main: {} } } });

function observeProjection(config: Parameters<typeof costWindow>[0]) {
  const publications: SessionCostUsagePublication[] = [];
  sessionCostUsageNotifications.onUpdated = (event) => publications.push(event);
  const warn = vi.fn();
  const lifetime = startProjection(config, warn);
  return { publications, warn, lifetime };
}
const startProjection = (config: Parameters<typeof costWindow>[0], warn = vi.fn()) =>
  startSessionCostUsageProjectionLifetime({ getConfig: () => config, warn });

function seedUsage(name: string, agentId = "main", key = name) {
  const target = { agentId, sessionKey: `agent:${agentId}:${key}`, sessionId: name };
  replaceSessionEntrySync(target, { sessionId: name, updatedAt: timestamp });
  return target;
}

function removeUsage(
  target: Parameters<typeof readSessionEntryInWorker>[0],
  config: Parameters<typeof costWindow>[0],
  expectedEntry: Awaited<ReturnType<typeof readSessionEntryInWorker>>,
  deleteTranscriptWithoutArchive = false,
) {
  return expect(
    deleteSessionEntryLifecycle({
      ...target,
      storePath: resolveSessionStorePathForScope(target, config),
      target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
      expectedEntry,
      archiveTranscript: false,
      deleteTranscriptWithoutArchive,
    }),
  ).resolves.toMatchObject({ deleted: true });
}

function costWindow(config: Parameters<typeof loadCostUsageSummaryCached>[0]["config"]) {
  return { config, startMs: timestamp - 1, endMs: timestamp + 1 };
}

it("keeps usage backfill and all-agent totals available while another agent's deletion drains", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config = { agents: { entries: { main: {}, retiring: {} } } };
    setRuntimeConfigSnapshot(config);
    for (const [agentId, tokens] of [
      ["main", 10],
      ["retiring", 900],
    ] as const) {
      const target = seedUsage(`${agentId}-usage`, agentId, "usage");
      await appendUsage(target, timestamp, tokens);
      await aggregation.refreshCostUsageCacheForAgent({ config, agentId });
    }
    const cost = () => loadCostUsageSummaryCached({ ...costWindow(config), agentScope: "all" });
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
    const mainRefreshStarted = createDeferred();
    const refreshUsage = aggregation.refreshCostUsageCacheForAgent;
    const refresh = vi
      .spyOn(aggregation, "refreshCostUsageCacheForAgent")
      .mockImplementation((params) => {
        if (params.agentId === "main") {
          mainRefreshStarted.resolve();
        }
        return refreshUsage(params);
      });
    const releaseBackfill = createDeferred();
    roster.mockImplementationOnce(async (cfg) => {
      await releaseBackfill.promise;
      return readRoster(cfg);
    });
    const { publications, warn, lifetime } = observeProjection(config);
    const startupRoster = roster.mock.results.at(-1)!.value;
    try {
      releaseRoster.resolve();
      expect.soft(await cost()).toMatchObject(fresh(10, 0.1));
      releaseBackfill.resolve();
      await withinTest(startupRoster, signal);
      await vi.advanceTimersByTimeAsync(0);
      await withinTest(mainRefreshStarted.promise, signal);
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
      expect(refreshed).toContainEqual({ status: "fulfilled", value: "refreshed" });
      expect.soft(refreshed.filter((result) => result.status === "rejected")).toEqual([]);
      expect.soft(publications.filter((event) => event.usageRefreshFailed)).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(await cost()).toMatchObject(fresh(10, 0.1));
      expect(await withinTest(reading, signal)).toMatchObject({ totals: { totalTokens: 10 } });
    } finally {
      releaseRoster.resolve();
      releaseBackfill.resolve();
      await lifetime.stop();
      queued.beginClose();
      await queued.drain();
      await readSettled;
      reopen();
      vi.useRealTimers();
    }
  });
});

it("coalesces usage through alias cleanup, flushes exact reads, and recovers deferred appends after restart", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = mainConfig();
    setRuntimeConfigSnapshot(config);
    const target = seedUsage("usage-coalescing");
    const append = (role: string, tokens?: number, mode: "inline" | "file-only" = "inline") =>
      appendUsage(target, timestamp, tokens, role, mode);
    await append("assistant", 10);
    const alias = { ...target, sessionKey: "agent:main:cron:usage:run:completed" };
    replaceSessionEntrySync(alias, { sessionId: target.sessionId, updatedAt: timestamp });
    const expectedAlias = await readSessionEntryInWorker(alias);
    await aggregation.refreshCostUsageCacheForAgent({ config, agentId: target.agentId });
    const roster = await agentList.listGatewayAgentsBasic(config);
    const listAgents = vi
      .spyOn(agentList, "listGatewayAgentsBasic")
      .mockResolvedValue({ ...roster, agents: [] });
    const refresh = vi.spyOn(aggregation, "refreshCostUsageCacheForAgent");
    const lifetime = startProjection(config);
    const sessions = [
      {
        sessionId: target.sessionId,
        sessionFile: formatSqliteSessionFileMarker({
          ...target,
          storePath: resolveSessionStorePathForScope(target, config),
        }),
      },
    ];
    const summaries = () =>
      cacheRuntime.loadSessionCostSummariesFromCache({
        config,
        agentId: target.agentId,
        sessions,
        requestRefresh: false,
      });
    vi.useFakeTimers();
    try {
      const cost = () =>
        loadCostUsageSummaryCached({ ...costWindow(config), agentId: target.agentId });
      expect((await cost()).totals.totalTokens).toBe(10);
      await append("user");
      await append("system");
      await vi.advanceTimersByTimeAsync(1000);
      expect(refresh).not.toHaveBeenCalled();

      await append("assistant", 20);
      await removeUsage(alias, config, expectedAlias);
      await vi.advanceTimersByTimeAsync(50);
      await append("assistant", 30);
      expect(refresh).not.toHaveBeenCalled();
      expect((await cost()).totals.totalTokens).toBe(60);
      expect(await summaries()).toMatchObject({
        ...sessionFresh(60),
        summaries: [{ totalTokens: 60, messageCounts: { user: 1, assistant: 3 } }],
      });
      expect(refresh).toHaveBeenCalledTimes(1);

      await append("assistant", 40, "file-only");
      expect(await summaries()).toMatchObject(sessionFresh(100));
      expect(refresh).toHaveBeenCalledTimes(2);

      await append("assistant", 50);
      await lifetime.stop();
      expect(refresh).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      listAgents.mockRestore();
      const recovered = createDeferred();
      sessionCostUsageNotifications.onUpdated = () => recovered.resolve();
      const restarted = startProjection(config);
      try {
        await withinTest(recovered.promise, signal);
        await refresh.mock.results.at(-1)?.value;
        expect(await summaries()).toMatchObject(sessionFresh(150));
        await removeUsage(target, config, await readSessionEntryInWorker(target), true);
        expect((await cost()).totals.totalTokens).toBe(0);
      } finally {
        sessionCostUsageNotifications.onUpdated = () => {};
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
    const config = mainConfig();
    const target = seedUsage("usage-admission");
    const append = (tokens: number) =>
      appendUsage(target, timestamp, tokens, "assistant", "inline", config);
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
    const { publications, warn, lifetime } = publisher.run("owner", () =>
      observeProjection(config),
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
          if (requested.mock.calls.length > initialRequests) {
            await withinTest(nextStarted.promise, signal);
          }
          pendingRefreshes = outcomes.length - 1;
        }),
      );
      await roster.mock.results.at(-1)?.value;
      await withinTest(nextStarted.promise, signal);
      releaseRefresh.resolve();
      const settled = await withinTest(Promise.all(outcomes), signal);
      await lifetime.stop();
      const summary = await cacheRuntime.loadCostUsageSummaryFromCache({
        ...costWindow(config),
        agentId: target.agentId,
        requestRefresh: false,
      });
      expect.soft(summary).toMatchObject(fresh(30));
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
    }
  });
  onTestFinished(() => run);
  return run;
});
