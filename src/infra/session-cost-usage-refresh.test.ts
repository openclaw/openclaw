import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { describePendingFakeTimers } from "../../test/helpers/fake-timer-diagnostics.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readAgentDeletionJournalStatusInWorker } from "../state/agent-deletion-journal.read.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { claimAgentRunContext, releaseAgentRunContext } from "./agent-run-registry.js";
import { refreshCostUsageCacheForAgent as refreshAgent } from "./session-cost-usage-aggregation.js";
import { requestCostUsageCacheRefresh as requestRefresh } from "./session-cost-usage-cache-runtime.js";
import { acquireUsageLock } from "./session-cost-usage-cache.fixtures.test-support.js";
import {
  loadCostUsageSummaryFromCache as loadSummary,
  loadSessionCostSummary,
  loadSessionCostSummariesFromCache as loadSessions,
  loadSessionUsageOverviewFromCache as loadOverview,
} from "./session-cost-usage.js";

const config = {};
const userLine = JSON.stringify({ message: { role: "user", content: "hello" } });
const usageLine = (id: string) =>
  JSON.stringify({
    type: "message",
    id,
    timestamp: "2026-09-18T00:00:00Z",
    message: {
      role: "assistant",
      provider: "test",
      model: "test",
      usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
    },
  }) + "\n";
async function tick(ms: number, calls: number) {
  await vi.advanceTimersByTimeAsync(ms);
  expect(refreshAgent).toHaveBeenCalledTimes(calls);
}
async function expectStale(params: Parameters<typeof loadSummary>[0]) {
  expect(await loadSummary({ ...params, requestRefresh: false })).toMatchObject({
    cacheStatus: { status: "stale" },
  });
}
function expectNoTimers() {
  expect(vi.getTimerCount(), describePendingFakeTimers()).toBe(0);
}
function readSession(
  agentId: string,
  sessionFile: string,
  extra: Partial<Parameters<typeof loadSessions>[0]> = {},
) {
  return loadSessions({ config, agentId, sessions: [{ sessionFile }], ...extra });
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

it("doubles consecutive busy delays, caps them, and resets after success", async () => {
  await withRefreshFixture(
    async ({ agentId, files: [sessionFile], refresh, hold, request }) => {
      const params = { config, agentId, startMs: 0, endMs: Date.now() };
      const fullRefresh = hold("refreshed");
      let queuedSubset: ReturnType<typeof loadSessions> | undefined;
      refresh.mockResolvedValue("refreshed");
      for (let attempt = 0; attempt < 10; attempt++) {
        refresh.mockResolvedValueOnce("busy");
      }
      refresh.mockImplementationOnce(() => {
        queuedSubset = readSession(params.agentId, sessionFile, { requestRefresh: false });
        return fullRefresh.promise;
      });
      refresh.mockResolvedValueOnce("busy");
      try {
        // A full refresh request starts the busy retry ladder.
        request();
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
        // Complete queued work even if an assertion failed before the final retry.
        refresh.mockResolvedValue("refreshed");
        fullRefresh.resolve("refreshed");
        await fullRefresh.promise;
        await vi.runOnlyPendingTimersAsync();
        await queuedSubset;
      }
    },
    { fileCount: 1 },
  );
});

function makeRefreshFixture(agentId: string, files: [string, string]) {
  const scopes: AsyncWorkScope[] = [];
  const newScope = () => {
    const owner = new AsyncWorkScope();
    scopes.push(owner);
    return owner;
  };
  const scope = newScope();
  const refresh = vi.mocked(refreshAgent);
  const releases: Array<() => void> = [];
  const reads: Promise<unknown>[] = [];
  const hold = <const T>(value: T) => {
    const deferred = createDeferredCore<T>();
    releases.push(() => deferred.resolve(value));
    return deferred;
  };
  const request = (extra: Partial<Parameters<typeof requestRefresh>[0]> = {}, owner = scope) =>
    owner.run(() =>
      requestRefresh({
        config,
        agentId,
        storePath: path.dirname(files[0]),
        ...extra,
      }),
    );
  const read = (file = files[0], extra: Partial<Parameters<typeof loadSessions>[0]> = {}) => {
    const reading = readSession(agentId, file, { requestRefresh: false, ...extra });
    reads.push(reading);
    return reading;
  };
  return {
    agentId,
    files,
    storePath: path.dirname(files[0]),
    request,
    read,
    dirty: (file = files[0], owner = scope) =>
      request({ sessionFiles: [file], coalesce: true }, owner),
    scope,
    newScope,
    refresh,
    hold,
    event: () => hold<void>(undefined),
    async close() {
      for (const owner of scopes) {
        owner.beginClose();
      }
      for (const release of releases) {
        release();
      }
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(50);
      }
      await Promise.all(scopes.map((owner) => owner.drain()));
      await Promise.allSettled(reads);
    },
  };
}

async function withRefreshFixture(
  run: (fixture: ReturnType<typeof makeRefreshFixture>) => Promise<void>,
  { fileCount = 2, fakeTimers = true, firstRecord = userLine } = {},
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
    sessionFiles
      .slice(0, fileCount)
      .map((file, index) => fs.writeFile(file, index === 0 ? firstRecord : userLine)),
  );
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    const fixture = makeRefreshFixture(agentId, sessionFiles);
    try {
      // Prepare real admission before fake time controls the refresh deadlines.
      // A missing shared-state file requires an asynchronous filesystem probe on every batch.
      openOpenClawStateDatabase();
      await readAgentDeletionJournalStatusInWorker(agentId);
      if (fakeTimers) {
        vi.useFakeTimers();
      }
      await run(fixture);
    } finally {
      try {
        await fixture.close();
      } finally {
        fixture.refresh.mockReset();
        vi.useRealTimers();
        await closeStateDatabaseForTest();
      }
    }
  });
}

const test = it.extend<{ usage: ReturnType<typeof makeRefreshFixture> }>({
  usage: async ({ task: _task }, use) => withRefreshFixture(use),
});

it("returns marked stale session costs when another direct refresh stays busy", async () => {
  const actual = await vi.importActual<typeof import("./session-cost-usage-aggregation.js")>(
    "./session-cost-usage-aggregation.js",
  );
  await withRefreshFixture(
    async ({ agentId, files: [sessionFile], refresh, scope }) => {
      refresh.mockImplementation(actual.refreshCostUsageCacheForAgent);
      await actual.refreshCostUsageCacheForAgent({ config, agentId, sessionFiles: [sessionFile] });
      await fs.appendFile(sessionFile, usageLine("later"));
      await using lock = await acquireUsageLock(agentId);
      vi.useFakeTimers();
      const reading = scope.track(() => loadSessionCostSummary({ config, agentId, sessionFile }));
      const settled = vi.fn();
      void reading.then(settled, settled);
      try {
        await vi.waitFor(() => expect(refresh).toHaveBeenCalled(), {
          timeout: 10_000,
          interval: 1,
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.waitFor(
          () => expect(settled, "session-cost report wait budget").toHaveBeenCalled(),
          {
            timeout: 1_000,
          },
        );
        expect(await reading).toMatchObject({
          totalTokens: 10,
          totalCost: 1,
          staleSince: expect.any(Number),
          refreshing: true,
        });
        expect(scope.hasPendingWork).toBe(true);
      } finally {
        await lock.release();
        vi.useRealTimers();
        await reading;
      }
    },
    { fileCount: 1, fakeTimers: false, firstRecord: usageLine("first") },
  );
});

test("keeps per-session quiet gaps across wall-clock rollback and unrelated reads", async ({
  signal,
  usage: { files, refresh, dirty, read },
}) => {
  refresh.mockResolvedValue("refreshed");
  dirty(files[0]);
  await withinTest(read(files[1]), signal);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() - 120_000);
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

test("preserves oldest dirty age across turns and refreshes at its deadline while busy", async ({
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
    await tick(299_999, 1);
    dirty();
    await tick(1, 2);
    dirty();
    await tick(299_999, 2);
    await tick(1, 3);
    releaseAgentRunContext("usage-batch-turn", claim);
    await tick(0, 3);
  } finally {
    releaseAgentRunContext("usage-batch-turn", claim);
  }
});

test("keeps eligible retries bounded across overlapping turns and publications", async ({
  usage: { agentId, refresh, hold, dirty },
}) => {
  const held = hold("busy");
  refresh.mockResolvedValue("refreshed").mockReturnValueOnce(held.promise);
  let claim: ReturnType<typeof claimAgentRunContext>;
  try {
    dirty();
    await tick(30_000, 1);
    claim = claimAgentRunContext("usage-busy-turn", { agentId }, { trackOwner: true });
    dirty();
    held.resolve("busy");
    await tick(49, 1);
    await tick(1, 2);
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
    const actual = await vi.importActual<typeof import("./session-cost-usage-aggregation.js")>(
      "./session-cost-usage-aggregation.js",
    );
    await withRefreshFixture(
      async ({
        agentId,
        files: [sessionFile],
        storePath,
        refresh,
        hold,
        event,
        dirty,
        request,
        read,
      }) => {
        await actual.refreshCostUsageCacheForAgent({
          config,
          agentId,
          sessionFiles: [sessionFile],
        });
        await fs.appendFile(sessionFile, usageLine("second"));
        const firstBatchEntered = event();
        const releaseFirstBatch = hold("refreshed");
        const releaseBulk = hold("refreshed");
        let appended = false;
        let bulkFinished = false;
        refresh.mockImplementation(async (params) => {
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
              await fs.appendFile(sessionFile, usageLine("during-refresh"));
              dirty();
            }
            return result;
          }
          await releaseBulk.promise;
          bulkFinished = true;
          return "refreshed";
        });
        request();
        await withinTest(firstBatchEntered.promise, signal);
        if (coalesce) {
          dirty();
        }
        const reading = read();
        const settled = vi.fn();
        void reading.then(settled, settled);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 150);
        });
        expect(settled).not.toHaveBeenCalled();
        releaseFirstBatch.resolve("refreshed");
        const result = await withinTest(reading, signal);
        expect(result.summaries[0]).toMatchObject({
          input: 21,
          output: 9,
          totalTokens: 30,
          totalCost: 3,
        });
        expect(bulkFinished).toBe(false);
      },
      { fileCount: 1, fakeTimers: false, firstRecord: usageLine("first") },
    );
  },
);

test.for(["completes", "slow", "cancelled", "rollback"] as const)(
  "bounds publication waiting when the request is %s without adopting background work",
  async (phase, { usage: { agentId, files, refresh, hold, dirty, read, newScope } }) => {
    const refreshOwner = newScope();
    const requestOwner = newScope();
    const release = hold("refreshed");
    refresh.mockReturnValue(release.promise);
    const reason = new Error("usage client disconnected");
    await expectStale({ config, agentId, startMs: 0, endMs: Date.now() });
    dirty(files[0], refreshOwner);
    const reading = requestOwner.track(async () =>
      phase === "rollback"
        ? loadSummary({ config, agentId, startMs: 0, endMs: Date.now() })
        : read(files[0], { maxPublicationWaitMs: 100 }),
    );
    // Observe rejection immediately; scope cancellation must not become an
    // unhandled rejection while the fake clock advances other work.
    const result = Promise.allSettled([reading]);
    await tick(0, 1);
    if (phase === "rollback") {
      const settled = vi.fn();
      void reading.then(settled, settled);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() - 90_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(settled).toHaveBeenCalled(), { timeout: 1_000 });
    }
    if (phase === "completes") {
      release.resolve("refreshed");
    } else if (phase === "cancelled") {
      requestOwner.beginClose(reason);
    } else if (phase === "slow") {
      await vi.advanceTimersByTimeAsync(100);
    }
    const [outcome] = await result;
    if (phase === "cancelled") {
      expect(outcome).toMatchObject({ status: "rejected", reason });
    } else {
      expect(outcome).toMatchObject({
        status: "fulfilled",
        value:
          phase === "rollback"
            ? { totals: { totalTokens: 0 }, cacheStatus: { status: "refreshing", staleFiles: 2 } }
            : { summaries: [null], cacheStatus: { status: "stale" } },
      });
    }
    if (phase !== "completes") {
      expect(refreshOwner.hasPendingWork).toBe(true);
      expect(refreshOwner.signal.aborted).toBe(false);
    }
    expectNoTimers();
  },
);

test("returns the committed overview while its refresh is still pending", async ({
  usage: { agentId, files, refresh, hold, request, newScope },
}) => {
  const refreshOwner = newScope();
  const release = hold("refreshed");
  refresh.mockReturnValue(release.promise);
  request({ sessionFiles: [files[0]] }, refreshOwner);
  await tick(0, 1);
  const settled = vi.fn();
  const reading = newScope().track(() =>
    loadOverview({
      config,
      agentId,
      families: [[{ sessionFile: files[0] }]],
      startMs: Date.UTC(2026, 8, 18),
      endMs: Date.UTC(2026, 8, 19) - 1,
    }),
  );
  void reading.then(settled, settled);
  // A report must return its explicit partial state without waiting for a transcript scan.
  await vi.waitFor(() => expect(settled).toHaveBeenCalled(), { timeout: 1_000 });
  expect(await reading).toMatchObject({
    computing: [true],
    summarizing: 1,
    cacheStatus: { status: "refreshing", pendingFiles: 1 },
  });
  expect(refreshOwner.signal.aborted).toBe(false);
});

test("keeps an exact logical-selector read pending across a deferred rebuild", async ({
  usage: { agentId, storePath, refresh, hold, read, request },
}) => {
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
  request({ sessionFiles: [logical], rebuildRows: [row] });
  await vi.advanceTimersByTimeAsync(0);
  const reading = read(logical);
  const settled = vi.fn();
  void reading.then(settled, settled);
  releaseFirst.resolve("refreshed");
  await vi.advanceTimersByTimeAsync(1);
  expect(refresh.mock.calls[1]?.[0]).toMatchObject({
    sessionFiles: [logical],
    rebuildRows: [row],
  });
  expect(settled).not.toHaveBeenCalled();
  releaseSecond.resolve("refreshed");
  await vi.advanceTimersByTimeAsync(1);
  await reading;
});

test("bounds pending backfill batches and preserves queued rebuilds across a busy retry", async ({
  usage: { storePath, scope, refresh, request },
}) => {
  const pending = Array.from({ length: 121 }, (_, index) => path.join(storePath, `${index}.jsonl`));
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
      request({ sessionFiles: [late] });
      return "busy";
    }
    return "refreshed";
  });
  await scope.track(async () => request({ rebuildRows: [rebuild] }));
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
  usage: { files, refresh, event, read, newScope },
}) => {
  const first = newScope();
  const second = newScope();
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
  const drainingFirst = first.drain();
  releaseFirst.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await drainingFirst;
  expect(completed).toEqual(["first"]);
  expect(second.signal.aborted).toBe(false);
  second.beginClose();
  releaseSecond.resolve();
  await second.drain();
  expect(completed).toEqual(["first", "second"]);
});
