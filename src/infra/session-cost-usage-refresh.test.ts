import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { describePendingFakeTimers } from "../../test/helpers/fake-timer-diagnostics.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { claimAgentRunContext, releaseAgentRunContext } from "./agent-run-registry.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { requestCostUsageCacheRefresh } from "./session-cost-usage-cache-runtime.js";
import {
  loadCostUsageSummaryFromCache,
  loadSessionCostSummariesFromCache,
} from "./session-cost-usage.js";

const config = {};
async function tick(ms: number, calls: number) {
  await vi.advanceTimersByTimeAsync(ms);
  expect(refreshCostUsageCacheForAgent).toHaveBeenCalledTimes(calls);
}
async function expectStale(params: Parameters<typeof loadCostUsageSummaryFromCache>[0]) {
  expect(await loadCostUsageSummaryFromCache({ ...params, requestRefresh: false })).toMatchObject({
    cacheStatus: { status: "stale" },
  });
}
function expectNoTimers() {
  expect(vi.getTimerCount(), describePendingFakeTimers()).toBe(0);
}
function queueRefresh(scope: AsyncWorkScope, agentId: string, sessionFile: string) {
  return scope.run(() =>
    requestCostUsageCacheRefresh({
      config,
      agentId,
      storePath: path.dirname(sessionFile),
      sessionFiles: [sessionFile],
      coalesce: true,
    }),
  );
}
function readSession(
  agentId: string,
  sessionFile: string,
  overrides: Partial<Parameters<typeof loadSessionCostSummariesFromCache>[0]> = {},
) {
  return loadSessionCostSummariesFromCache({
    config,
    agentId,
    sessions: [{ sessionFile }],
    ...overrides,
  });
}

// mock-isolation: This suite owns refresh timers; filesystem observation has separate coverage.
vi.mock("./owned-directory-observation.js", () => ({
  observeOwnedDirectory: () => ({ close() {} }),
}));

vi.mock("./session-cost-usage-aggregation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-cost-usage-aggregation.js")>()),
  refreshCostUsageCacheForAgent: vi.fn(),
}));

// Fixture teardown must join refresh work before its files are removed.
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => onTestFinished(cleanup)),
);

describe("session cost usage refresh", () => {
  it("doubles consecutive busy delays, caps them, and resets after success", async () => {
    const root = tempDirs.make("openclaw-session-cost-backoff-");
    const sessionFile = path.join(root, "agents", "backoff-test", "sessions", "next-session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(
      sessionFile,
      JSON.stringify({ message: { role: "user", content: "hello" } }),
    );

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const params = { config, agentId: "backoff-test", startMs: 0, endMs: Date.now() };
      const refresh = vi.mocked(refreshCostUsageCacheForAgent);
      const fullRefresh = createDeferredCore<"refreshed">();
      let queuedSubset: ReturnType<typeof loadSessionCostSummariesFromCache> | undefined;
      refresh.mockResolvedValue("refreshed");
      for (let attempt = 0; attempt < 10; attempt++) {
        refresh.mockResolvedValueOnce("busy");
      }
      refresh.mockImplementationOnce(() => {
        queuedSubset = readSession(params.agentId, sessionFile, { requestRefresh: false });
        return fullRefresh.promise;
      });
      refresh.mockResolvedValueOnce("busy");

      vi.useFakeTimers();
      try {
        expect(await loadCostUsageSummaryFromCache(params)).toMatchObject({
          cacheStatus: { status: "refreshing", pendingFiles: 1 },
        });
        await tick(0, 1);

        for (const [index, delayMs] of [
          50, 100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000,
        ].entries()) {
          await tick(delayMs - 1, index + 1);
          await tick(1, index + 2);
        }

        await tick(4_999, 10);
        await vi.advanceTimersByTimeAsync(1);
        // Schedule the next batch outside the timer tick, regardless of filesystem timing.
        fullRefresh.resolve("refreshed");
        await fullRefresh.promise;
        await tick(0, 12);
        expect(refresh.mock.calls[10]?.[0].sessionFiles).toBeUndefined();
        expect(refresh.mock.calls[11]?.[0].sessionFiles).toEqual([sessionFile]);

        await tick(49, 12);
        await tick(1, 13);
        await queuedSubset;
        expectNoTimers();
        await expectStale(params);
      } finally {
        try {
          // Complete queued work even if an assertion failed before the final retry.
          refresh.mockResolvedValue("refreshed");
          fullRefresh.resolve("refreshed");
          await fullRefresh.promise;
          await vi.runOnlyPendingTimersAsync();
          await queuedSubset;
          await expectStale(params);
          expectNoTimers();
        } finally {
          refresh.mockReset();
          vi.useRealTimers();
        }
      }
    });
  });

  function makeRefreshFixture(agentId: string, files: [string, string]) {
    const scope = new AsyncWorkScope();
    const refresh = vi.mocked(refreshCostUsageCacheForAgent);
    const releases: Array<() => void> = [];
    const hold = <const T>(value: T) => {
      const deferred = createDeferredCore<T>();
      releases.push(() => deferred.resolve(value));
      return deferred;
    };
    const request = (extra: Partial<Parameters<typeof requestCostUsageCacheRefresh>[0]> = {}) =>
      scope.run(() =>
        requestCostUsageCacheRefresh({
          config,
          agentId,
          storePath: path.dirname(files[0]),
          ...extra,
        }),
      );
    const read = (
      file = files[0],
      extra: Partial<Parameters<typeof loadSessionCostSummariesFromCache>[0]> = {},
    ) => readSession(agentId, file, { requestRefresh: false, ...extra });
    return {
      agentId,
      files,
      request,
      read,
      dirty: (file = files[0]) => request({ sessionFiles: [file], coalesce: true }),
      scope,
      refresh,
      hold,
      event: () => hold<void>(undefined),
      async close() {
        scope.beginClose();
        for (const release of releases) {
          release();
        }
        await vi.advanceTimersByTimeAsync(50);
        await scope.drain();
      },
    };
  }

  async function withRefreshFixture(
    run: (fixture: ReturnType<typeof makeRefreshFixture>) => Promise<void>,
  ): Promise<void> {
    const root = tempDirs.make("openclaw-session-cost-lifetime-");
    const agentId = "refresh-test";
    const sessionsDir = path.join(root, "agents", agentId, "sessions");
    const sessionFiles: [string, string] = [
      path.join(sessionsDir, "first.jsonl"),
      path.join(sessionsDir, "second.jsonl"),
    ];
    await fs.mkdir(sessionsDir, { recursive: true });
    await Promise.all(
      sessionFiles.map((sessionFile) =>
        fs.writeFile(sessionFile, JSON.stringify({ message: { role: "user", content: "hello" } })),
      ),
    );
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      vi.useFakeTimers();
      const fixture = makeRefreshFixture(agentId, sessionFiles);
      try {
        await run(fixture);
      } finally {
        try {
          await fixture.close();
        } finally {
          fixture.refresh.mockReset();
          vi.useRealTimers();
        }
      }
    });
  }

  const test = it.extend<{ usage: ReturnType<typeof makeRefreshFixture> }>({
    usage: async ({ task: _task }, use) => withRefreshFixture(use),
  });

  test("refreshes each dirty session once after its own quiet gap and parks when clean", async ({
    usage: { files, refresh, dirty },
  }) => {
    refresh.mockResolvedValue("refreshed");

    dirty(files[0]);
    await vi.advanceTimersByTimeAsync(20_000);
    dirty(files[0]);
    dirty(files[1]);
    await vi.advanceTimersByTimeAsync(20_000);
    dirty(files[1]);
    await tick(9_999, 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh.mock.calls.map(([params]) => params.sessionFiles)).toEqual([[files[0]]]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refresh.mock.calls.map(([params]) => params.sessionFiles)).toEqual(
      files.map((file) => [file]),
    );
    await tick(300_000, 2);
    expectNoTimers();
  });

  test("preserves oldest dirty age across turns and refreshes overdue work in the next idle gap", async ({
    usage: { agentId, refresh, dirty },
  }) => {
    refresh.mockResolvedValue("refreshed");
    let claim: ReturnType<typeof claimAgentRunContext>;
    try {
      dirty();
      for (let turn = 0; turn < 15; turn++) {
        claim = claimAgentRunContext("usage-batch-turn", { agentId }, { trackOwner: true });
        dirty();
        await vi.advanceTimersByTimeAsync(10_000);
        releaseAgentRunContext("usage-batch-turn", claim);
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(refresh).toHaveBeenCalledTimes(1);
      dirty();
      claim = claimAgentRunContext("usage-batch-turn", { agentId }, { trackOwner: true });
      await tick(360_000, 1);
      releaseAgentRunContext("usage-batch-turn", claim);
      await tick(0, 2);
    } finally {
      releaseAgentRunContext("usage-batch-turn", claim);
    }
  });

  test("does not flush unrelated dirty sessions for a keyed read", async ({
    signal,
    usage: { files, refresh, read, dirty },
  }) => {
    refresh.mockResolvedValue("refreshed");

    dirty();
    await withinTest(read(files[1]), signal);
    expect(refresh).not.toHaveBeenCalled();
    await tick(30_000, 1);
    expect(refresh.mock.calls[0]?.[0].sessionFiles).toEqual([files[0]]);
  });

  test("wakes a busy retry when an overlapping turn becomes idle", async ({
    usage: { agentId, refresh, hold, dirty },
  }) => {
    const held = hold("busy");
    refresh.mockResolvedValue("refreshed").mockReturnValueOnce(held.promise);
    let claim: ReturnType<typeof claimAgentRunContext>;
    try {
      dirty();
      await tick(30_000, 1);
      claim = claimAgentRunContext("usage-busy-turn", { agentId }, { trackOwner: true });
      held.resolve("busy");
      await tick(1_000, 1);
      releaseAgentRunContext("usage-busy-turn", claim);
      await tick(0, 2);
    } finally {
      releaseAgentRunContext("usage-busy-turn", claim);
      held.resolve("busy");
    }
  });

  test("retains appends arriving during refresh for the next quiet gap", async ({
    usage: { refresh, hold, dirty },
  }) => {
    const held = hold("refreshed");
    refresh.mockResolvedValue("refreshed").mockReturnValueOnce(held.promise);

    dirty();
    await tick(30_000, 1);
    dirty();
    held.resolve("refreshed");
    await tick(29_999, 1);
    await tick(1, 2);
  });

  it.for([false, true])(
    "returns exact session usage before bulk backfill finishes (dirty publication: %s)",
    async (coalesce, { signal }) => {
      const root = tempDirs.make("openclaw-usage-priority-");
      const agentId = "priority-test";
      const storePath = path.join(root, "agents", agentId, "sessions");
      const sessionFile = path.join(storePath, "selected.jsonl");
      const line = (id: string) =>
        `${JSON.stringify({
          type: "message",
          id,
          timestamp: "2026-09-18T00:00:00Z",
          message: {
            role: "assistant",
            provider: "test",
            model: "test",
            usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
          },
        })}\n`;
      await fs.mkdir(storePath, { recursive: true });
      await fs.writeFile(sessionFile, line("first"));
      const actual = await vi.importActual<typeof import("./session-cost-usage-aggregation.js")>(
        "./session-cost-usage-aggregation.js",
      );
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        await actual.refreshCostUsageCacheForAgent({
          config,
          agentId,
          sessionFiles: [sessionFile],
        });
        await fs.appendFile(sessionFile, line("second"));
        const scope = new AsyncWorkScope();
        const firstBatchEntered = createDeferredCore();
        const releaseFirstBatch = createDeferredCore<"refreshed">();
        const releaseBulk = createDeferredCore<"refreshed">();
        let appended = false;
        let bulkFinished = false;
        const dirty = () =>
          scope.run(() =>
            requestCostUsageCacheRefresh({
              config,
              agentId,
              storePath,
              sessionFiles: [sessionFile],
              coalesce: true,
            }),
          );
        vi.mocked(refreshCostUsageCacheForAgent).mockImplementation(async (params) => {
          if (!params.sessionFiles) {
            params.onRemaining?.(
              Array.from({ length: 121 }, (_, index) => {
                const file = path.join(storePath, `bulk-${index}.jsonl`);
                return { sessionFile: file, rollupId: file };
              }),
            );
            firstBatchEntered.resolve();
            return releaseFirstBatch.promise;
          }
          if (params.sessionFiles.includes(sessionFile)) {
            const result = await actual.refreshCostUsageCacheForAgent(params);
            if (!appended) {
              appended = true;
              await fs.appendFile(sessionFile, line("during-refresh"));
              dirty();
            }
            return result;
          }
          await releaseBulk.promise;
          bulkFinished = true;
          return "refreshed";
        });
        let reading: ReturnType<typeof loadSessionCostSummariesFromCache> | undefined;
        try {
          scope.run(() => requestCostUsageCacheRefresh({ config, agentId, storePath }));
          await withinTest(firstBatchEntered.promise, signal);
          if (coalesce) {
            dirty();
          }
          reading = loadSessionCostSummariesFromCache({
            config,
            agentId,
            sessions: [{ sessionFile }],
            requestRefresh: false,
          });
          let settled = false;
          void reading.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 150);
          });
          expect(settled).toBe(false);
          releaseFirstBatch.resolve("refreshed");
          const result = await withinTest(reading, signal);
          expect(result.summaries[0]).toMatchObject({
            input: 21,
            output: 9,
            totalTokens: 30,
            totalCost: 3,
          });
          expect(bulkFinished).toBe(false);
        } finally {
          scope.beginClose();
          releaseFirstBatch.resolve("refreshed");
          releaseBulk.resolve("refreshed");
          await Promise.allSettled([reading, scope.drain()]);
          vi.mocked(refreshCostUsageCacheForAgent).mockReset();
        }
      });
    },
  );

  test.for(["completes", "slow", "cancelled"] as const)(
    "bounds publication waiting when the request is %s without adopting background work",
    async (phase, { usage: { agentId, files, refresh, hold } }) => {
      const refreshOwner = new AsyncWorkScope();
      const requestOwner = new AsyncWorkScope();
      const release = hold("refreshed");
      refresh.mockReturnValue(release.promise);
      const reason = new Error("usage client disconnected");
      queueRefresh(refreshOwner, agentId, files[0]);
      const reading = requestOwner.track(() =>
        readSession(agentId, files[0], {
          requestRefresh: false,
          maxPublicationWaitMs: 100,
        }),
      );
      // Observe rejection immediately; scope cancellation must not become an
      // unhandled rejection while the fake clock advances other work.
      const result = Promise.allSettled([reading]);
      try {
        await tick(0, 1);
        if (phase === "completes") {
          release.resolve("refreshed");
        } else if (phase === "cancelled") {
          requestOwner.beginClose(reason);
        } else {
          await vi.advanceTimersByTimeAsync(100);
        }
        const [outcome] = await result;
        if (phase === "cancelled") {
          expect(outcome).toMatchObject({ status: "rejected", reason });
        } else {
          expect(outcome).toMatchObject({
            status: "fulfilled",
            value: { summaries: [null], cacheStatus: { status: "stale" } },
          });
        }
        if (phase !== "completes") {
          expect(refreshOwner.hasPendingWork).toBe(true);
          expect(refreshOwner.signal.aborted).toBe(false);
        }
        expectNoTimers();
      } finally {
        release.resolve("refreshed");
        await result;
        await refreshOwner.drain();
        await requestOwner.drain();
      }
    },
  );

  test("keeps an exact logical-selector read pending across a deferred rebuild", async ({
    usage: { agentId, files, scope, refresh, hold, read, request },
  }) => {
    const storePath = path.dirname(files[0]);
    const logical = `sqlite:${agentId}:selected:${path.join(storePath, "sessions.json")}`;
    const canonical = `sqlite:${agentId}:selected:${path.join(storePath, "openclaw-agent.sqlite")}`;
    const row = { key: canonical, valueJson: "{}", updatedAt: 1 };
    const releaseFirst = hold("refreshed");
    const releaseSecond = hold("refreshed");

    refresh.mockImplementationOnce(async (params) => {
      await releaseFirst.promise;
      params.onRemaining?.([{ sessionFile: logical, rollupId: canonical }]);
      return "refreshed";
    });
    refresh.mockReturnValueOnce(releaseSecond.promise);
    refresh.mockResolvedValue("refreshed");
    let reading: ReturnType<typeof loadSessionCostSummariesFromCache> | undefined;
    try {
      request({ sessionFiles: [logical], rebuildRows: [row] });
      await vi.advanceTimersByTimeAsync(0);
      reading = read(logical);
      let settled = false;
      void reading.then(() => {
        settled = true;
      });
      releaseFirst.resolve("refreshed");
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh.mock.calls[1]?.[0]).toMatchObject({
        sessionFiles: [logical],
        rebuildRows: [row],
      });
      expect(settled).toBe(false);
      releaseSecond.resolve("refreshed");
      await vi.advanceTimersByTimeAsync(1);
      await reading;
    } finally {
      releaseFirst.resolve("refreshed");
      releaseSecond.resolve("refreshed");
      scope.beginClose();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.allSettled([reading, scope.drain()]);
    }
  });

  test("bounds pending backfill batches and preserves queued rebuilds across a busy retry", async ({
    usage: { agentId, files, scope, refresh },
  }) => {
    const storePath = path.dirname(files[0]);
    const pending = Array.from({ length: 121 }, (_, index) =>
      path.join(storePath, `${index}.jsonl`),
    );
    const late = path.join(storePath, "late.jsonl");
    const rollupIds = pending.map((file, index) => (index === 80 ? `${file}.materialized` : file));
    const rebuild = { key: rollupIds[80]!, valueJson: "{}", updatedAt: 1 };

    let partialCalls = 0;
    refresh.mockImplementation(async (params) => {
      if (!params.sessionFiles) {
        params.onRemaining?.(
          pending.map((sessionFile, index) => ({ sessionFile, rollupId: rollupIds[index]! })),
        );
      } else if (++partialCalls === 1) {
        requestCostUsageCacheRefresh({
          config,
          agentId,
          storePath,
          sessionFiles: [late],
        });
        return "busy";
      }
      return "refreshed";
    });

    await scope.track(async () =>
      requestCostUsageCacheRefresh({ config, agentId, storePath, rebuildRows: [rebuild] }),
    );
    await tick(0, 1);
    // The first completed batch yields before admitting the next one.
    await tick(1, 2);
    expect(refresh.mock.calls[0]?.[0].rebuildRows).toEqual([rebuild]);
    expect(refresh.mock.calls[1]?.[0].sessionFiles).toEqual(pending.slice(0, 50));
    await vi.advanceTimersByTimeAsync(52);
    const accepted = refresh.mock.calls.slice(2).map(([params]) => params);
    expect(accepted.map((params) => params.sessionFiles?.length)).toEqual([50, 50, 23]);
    expect(accepted.flatMap((params) => params.sessionFiles ?? [])).toEqual([
      ...pending.slice(0, 81),
      rollupIds[80]!,
      ...pending.slice(81),
      late,
    ]);
    expect(accepted.map((params) => params.rebuildRows)).toEqual([[rebuild], [rebuild], []]);
    expectNoTimers();
  });

  test.for(["refreshed", "busy"] as const)(
    "keeps scope drain pending until its running refresh returns %s without leaving a retry",
    async (result, { usage: { files, scope, refresh, event, read } }) => {
      const release = event();
      const events: string[] = [];
      const work = release.promise.then(() => {
        events.push("refresh settled");
        return result;
      });
      refresh.mockReturnValueOnce(work);
      refresh.mockResolvedValue("refreshed");

      await scope.track(() => read(files[0], { requestRefresh: true }));
      expect(refresh).not.toHaveBeenCalled();
      await tick(0, 1);
      const draining = scope.drain().then(() => events.push("scope drained"));
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual([]);
      release.resolve();
      await draining;
      await vi.advanceTimersByTimeAsync(50);
      expect(events).toEqual(["refresh settled", "scope drained"]);
      expect(refresh).toHaveBeenCalledOnce();
      expectNoTimers();
    },
  );

  test.for([
    { failure: "abort", closing: true, level: "silent" },
    { failure: "abort", closing: false, level: "warn" },
    { failure: "write", closing: true, level: "warn" },
    { failure: "cleanup", closing: true, level: "warn" },
  ] as const)(
    "settles $failure with $level logging when closing=$closing",
    async ({ failure, closing, level }, { usage: { scope, refresh, hold, request } }) => {
      const release = hold("refreshed");
      refresh.mockReturnValue(release.promise);
      const previousLogging = {
        overrideSettings: loggingState.overrideSettings,
        cachedLogger: loggingState.cachedLogger,
        cachedSettings: loggingState.cachedSettings,
        cachedConsoleSettings: loggingState.cachedConsoleSettings,
        rawConsole: loggingState.rawConsole,
        consoleSubsystemFilter: loggingState.consoleSubsystemFilter,
      };
      const write = vi.fn();
      setLoggerOverride({ level: "silent", consoleLevel: "debug", consoleStyle: "json" });
      loggingState.rawConsole = { log: write, info: write, warn: write, error: write };
      loggingState.consoleSubsystemFilter = null;
      try {
        request();
        await tick(0, 1);
        if (closing) {
          scope.beginClose();
        }
        const aborted = new DOMException("This operation was aborted", "AbortError");
        const writeFailure = new Error("usage checkpoint write failed");
        release.reject(
          failure === "abort"
            ? aborted
            : failure === "write"
              ? writeFailure
              : new AggregateError([aborted, writeFailure], aborted.message),
        );
        await scope.runWhenIdle(() => {});
        if (level === "silent") {
          expect(write).not.toHaveBeenCalled();
        } else {
          expect(write).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(`"level":"${level}"`),
          );
          expect(write).toHaveBeenCalledWith(expect.stringContaining("background refresh"));
        }
        expect(refresh).toHaveBeenCalledOnce();
        expectNoTimers();
      } finally {
        try {
          release.resolve("refreshed");
          await scope.drain();
        } finally {
          Object.assign(loggingState, previousLogging);
        }
      }
    },
  );

  test.for(["initial timer", "busy retry"] as const)(
    "cancels a queued %s when its scope closes",
    async (phase, { usage: { files, scope, refresh, read } }) => {
      refresh.mockResolvedValue("refreshed");
      if (phase === "busy retry") {
        refresh.mockResolvedValueOnce("busy");
      }

      await scope.track(() => read(files[0], { requestRefresh: true }));
      if (phase === "busy retry") {
        await tick(0, 1);
      }
      const callsBeforeClose = refresh.mock.calls.length;
      await scope.drain();
      await tick(50, callsBeforeClose);
      expectNoTimers();
    },
  );

  test("keeps same-agent refreshes owned by independent scopes", async ({
    usage: { files, refresh, event, read },
  }) => {
    const first = new AsyncWorkScope();
    const second = new AsyncWorkScope();
    const releaseFirst = event();
    const releaseSecond = event();
    const completed: string[] = [];
    const firstWork = releaseFirst.promise.then(() => {
      completed.push("first");
      return "refreshed" as const;
    });
    const secondWork = releaseSecond.promise.then(() => {
      completed.push("second");
      return "refreshed" as const;
    });
    refresh.mockImplementation((params) =>
      params.sessionFiles?.includes(files[0]) ? firstWork : secondWork,
    );
    try {
      for (const { scope, sessionFile } of [
        { scope: first, sessionFile: files[0] },
        { scope: second, sessionFile: files[1] },
      ]) {
        await scope.track(() => read(sessionFile, { requestRefresh: true }));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh.mock.calls.map(([params]) => params.sessionFiles)).toEqual(
        files.map((sessionFile) => [sessionFile]),
      );
      let firstDrained = false;
      const drainingFirst = first.drain().then(() => {
        firstDrained = true;
      });
      releaseFirst.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(firstDrained).toBe(true);
      await drainingFirst;
      expect(completed).toEqual(["first"]);
      expect(second.signal.aborted).toBe(false);
      second.beginClose();
      releaseSecond.resolve();
      await second.drain();
      expect(completed).toEqual(["first", "second"]);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      first.beginClose();
      second.beginClose();
      await Promise.all([firstWork, secondWork]);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([first.drain(), second.drain()]);
    }
  });
});
