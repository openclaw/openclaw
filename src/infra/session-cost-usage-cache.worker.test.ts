import fs from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withTestTimeout,
} from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { maybeRepairLegacyRuntimeFiles } from "../commands/doctor-usage-cost-cache.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createWorkerPlacementSessionEvidenceResolver } from "../gateway/server-worker-placement-session-evidence.js";
import { createWorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectNestedErrorCandidates } from "./error-graph-internal.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import {
  acquireUsageLock,
  createUsageCacheWrite,
} from "./session-cost-usage-cache.fixtures.test-support.js";
import * as usageCacheSqlite from "./session-cost-usage-cache.sqlite.js";
import { readSessionCostUsageRollupRows } from "./session-cost-usage-cache.test-support.js";
import { sessionCostUsageNotifications } from "./session-cost-usage-events.js";
import { resolveUsageCostPricingFingerprint } from "./session-cost-usage-pricing-context.js";
import { openUsageCostRefreshFailures } from "./session-cost-usage-refresh-health.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import {
  loadCostUsageSummaryFromCache,
  loadSessionCostSummariesFromCache,
} from "./session-cost-usage.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import { WorkerTaskPool } from "./worker-task-pool.js";
import type { WorkerTaskInput, WorkerTaskOptions } from "./worker-task-pool.types.js";

const config = {};

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const observed = vi.hoisted(() => ({
  workers: new Set<Worker>(),
  refreshWorkers: new Set<Worker>(),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 2,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<Worker["postMessage"]>): void {
        const message = args[0];
        if (isRecord(message) && isRecord(message.input) && message.input.kind === "usage-cost") {
          observed.workers.add(this);
          if (isRecord(message.input.operation) && message.input.operation.kind === "refresh") {
            observed.refreshWorkers.add(this);
          }
        }
        super.postMessage(...args);
      }
    },
  };
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  sessionCostUsageNotifications.onUpdated = () => {};
  const workers = [...observed.workers];
  observed.workers.clear();
  observed.refreshWorkers.clear();
  for (const worker of workers) {
    expect(worker.threadId).toBe(-1);
  }
});

function usageLine(id?: string, priced = true): string {
  return `${JSON.stringify({
    type: "message",
    ...(id ? { id, parentId: null } : {}),
    timestamp: "2026-09-18T00:00:00Z",
    message: {
      role: "assistant",
      provider: "test",
      model: "test",
      usage: { input: 7, output: 3, totalTokens: 10, ...(priced ? { cost: { total: 1 } } : {}) },
    },
  })}\n`;
}

function readSession(
  agentId: string,
  sessionFile: string,
  extra: Partial<Parameters<typeof loadSessionCostSummariesFromCache>[0]> = {},
) {
  return loadSessionCostSummariesFromCache({
    config,
    agentId,
    sessions: [{ sessionFile }],
    requestRefresh: false,
    ...extra,
  });
}

function refresh(agentId: string, sessionFiles?: string[]) {
  return refreshCostUsageCacheForAgent({ config, agentId, sessionFiles });
}

function expectFresh(result: unknown, totalTokens: number) {
  expect(result).toMatchObject({
    summaries: [{ totalTokens }],
    cacheStatus: { status: "fresh" },
  });
}

async function sessionReport(
  agentId: string,
  sessionFile: string,
  pricingConfig?: Parameters<typeof resolveUsageCostPricingFingerprint>[0],
) {
  const prepared = prepareUsageCostWorker({ config, agentId, sessionFiles: [sessionFile] });
  const pricingFingerprint = await resolveUsageCostPricingFingerprint(
    pricingConfig,
    prepared.agentDir,
  );
  const request = {
    kind: "sessions" as const,
    pricingFingerprint,
    sessions: [{ sessionFile }],
    dayBucket: { mode: "utc-offset" as const, utcOffsetMinutes: 0 },
  };
  return { prepared, request, read: () => runUsageCostWorker(prepared, request) };
}

type HostRequestResult = ReturnType<NonNullable<WorkerTaskOptions<unknown>["onRequest"]>>;
function observeHostRequests(
  observe: (value: unknown, next: () => HostRequestResult) => HostRequestResult,
) {
  // oxlint-disable-next-line typescript/unbound-method -- Forward with the original pool receiver.
  const run = WorkerTaskPool.prototype.run;
  return vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(function (
    this: WorkerTaskPool<unknown, unknown>,
    input,
    options,
  ) {
    const onRequest = options.onRequest;
    return run.call(this, input, {
      ...options,
      onRequest: onRequest && ((value, context) => observe(value, () => onRequest(value, context))),
    });
  });
}

function holdRefreshWrites(
  agentIds: string[],
  options: { commitBeforeWait?: boolean; failure?: Error } = {},
) {
  const gates = new Map(
    agentIds.map((agentId) => [
      agentId,
      {
        entered: createDeferred(),
        release: createDeferred(),
        events: [] as string[],
        writes: 0,
        cleaned: false,
      },
    ]),
  );
  const prepareLock = usageCacheSqlite.prepareSessionCostUsageRefreshLock;
  const observer = vi
    .spyOn(usageCacheSqlite, "prepareSessionCostUsageRefreshLock")
    .mockImplementation((...args) => {
      const lock = prepareLock(...args);
      const gate = args[0] === undefined ? undefined : gates.get(args[0]);
      if (!gate) {
        return lock;
      }
      return {
        ...lock,
        writeRollup: async (rows) => {
          gate.writes++;
          if (options.commitBeforeWait) {
            expect(await lock.writeRollup(rows)).toBe(true);
            gate.events.push("write-committed");
          }
          gate.entered.resolve();
          await gate.release.promise;
          gate.events.push("write-settled");
          if (options.failure) {
            throw options.failure;
          }
          return options.commitBeforeWait ? true : lock.writeRollup(rows);
        },
        release: async () => {
          gate.events.push("lock-cleanup");
          await lock.release();
          gate.cleaned = true;
        },
      };
    });
  return { observer, gate: (agentId: string) => gates.get(agentId)! };
}

function waitForHost(gate: Promise<void>, operation: Promise<unknown>, message: string) {
  return withTestTimeout(awaitGateBeforeSettlement(gate, operation, message), 10_000, message);
}

it("bounds prune writer batches and recovers partial cleanup after restart without changing live totals", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-prune-refresh";
    const sessionsDir = state.sessionsDir(agentId);
    const sessionFile = path.join(sessionsDir, "live.jsonl");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(sessionFile, usageLine("first"));
    await refresh(agentId, [sessionFile]);
    const staleKeys = Array.from({ length: 1_089 }, (_, index) =>
      path.join(sessionsDir, `removed-${String(index).padStart(4, "0")}.jsonl`),
    );
    {
      await using owner = await acquireUsageLock(agentId);
      await owner.writeRollup(
        staleKeys.map((rollupId, index) => ({
          ...createUsageCacheWrite(rollupId, {
            padding: "x".repeat(([0, 600, 600, 1024][index] ?? 0) * 1024),
          }),
          partitions: [{ date: "2026-09-01", valueJson: "{}", blob: new Uint8Array([1]) }],
        })),
      );
    }
    await fs.appendFile(sessionFile, usageLine("second"));
    await refresh(agentId, [sessionFile]);
    expect(readSessionCostUsageRollupRows(agentId)).toHaveLength(staleKeys.length + 1);

    let batches = 0;
    let oversized = false;
    const committedKeys: string[] = [];
    const failure = new Error("Prune batch interrupted");
    const prepareLock = usageCacheSqlite.prepareSessionCostUsageRefreshLock;
    using _ = vi
      .spyOn(usageCacheSqlite, "prepareSessionCostUsageRefreshLock")
      .mockImplementation((...args) => {
        const lock = prepareLock(...args);
        return {
          ...lock,
          pruneRows: async (rows, signal) => {
            const bytes = rows.reduce(
              (sum, row) => sum + Buffer.byteLength(row.valueJson) + 2 * row.key.length,
              0,
            );
            expect(rows.length).toBeLessThanOrEqual(1_024);
            expect(bytes <= 1024 * 1024 || rows.length === 1).toBe(true);
            oversized ||= bytes > 1024 * 1024;
            if (++batches === 2) {
              throw failure;
            }
            await lock.pruneRows(rows, signal);
            committedKeys.push(...rows.map((row) => row.key));
          },
        };
      });
    await expect(refresh(agentId)).rejects.toBe(failure);
    expect(committedKeys.length).toBeGreaterThan(0);
    expect(readSessionCostUsageRollupRows(agentId)).toHaveLength(
      staleKeys.length + 1 - committedKeys.length,
    );
    await closeOpenClawAgentDatabasesAsync();
    await closeStateDatabaseForTest();
    await refresh(agentId);
    expect(committedKeys.toSorted()).toEqual(staleKeys.toSorted());
    expect(oversized).toBe(true);
    expect(readSessionCostUsageRollupRows(agentId).map((row) => row.key)).toEqual([sessionFile]);

    await fs.appendFile(sessionFile, usageLine("third"));
    await refresh(agentId, [sessionFile]);
    expectFresh(await readSession(agentId, sessionFile), 30);
  });
});

it("rebuilds corrupt report bodies only for the exact rejected metadata snapshot", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-corrupt-body";
    const sessionFile = state.path("usage-corrupt-body.jsonl");
    await fs.writeFile(sessionFile, usageLine("stored"));
    await refresh(agentId, [sessionFile]);
    const report = await sessionReport(agentId, sessionFile);
    const { db } = openOpenClawAgentDatabase({ agentId });
    const stored = db
      .prepare(
        "SELECT value_json, blob, updated_at FROM cache_entries WHERE scope = 'session-cost-usage-rollup-v3' AND key = ?",
      )
      .get(sessionFile)!;
    if (!(stored.blob instanceof Uint8Array)) {
      throw new Error("Expected stored usage body");
    }
    const corrupt = () =>
      db
        .prepare(
          "UPDATE cache_entries SET blob = zeroblob(length(blob)) WHERE scope = 'session-cost-usage-rollup-v3' AND key = ?",
        )
        .run(sessionFile);
    corrupt();
    const rejected = await report.read();
    expect(rejected).toMatchObject({
      kind: "sessions",
      summaries: [null],
      cacheStatus: { status: "stale" },
    });
    if (rejected.kind !== "sessions") {
      throw new Error("Expected rejected session report");
    }
    expect(rejected.invalidRows).toHaveLength(1);

    // A valid newer writer wins before the old report's rebuild request arrives.
    const newer = JSON.stringify({ ...JSON.parse(String(stored.value_json)), scannedAt: 999_999 });
    db.prepare(
      "UPDATE cache_entries SET value_json = ?, blob = ?, updated_at = updated_at + 1 WHERE scope = 'session-cost-usage-rollup-v3' AND key = ?",
    ).run(newer, stored.blob, sessionFile);
    const before = readSessionCostUsageRollupRows(agentId);
    await refreshCostUsageCacheForAgent({
      config,
      agentId,
      sessionFiles: [sessionFile],
      rebuildRows: rejected.invalidRows,
    });
    expect(readSessionCostUsageRollupRows(agentId)).toEqual(before);
    expect(await report.read()).toMatchObject({
      summaries: [{ totalTokens: 10 }],
      invalidRows: [],
    });

    corrupt();
    const current = await report.read();
    if (current.kind !== "sessions") {
      throw new Error("Expected current session report");
    }
    await refreshCostUsageCacheForAgent({
      config,
      agentId,
      sessionFiles: [sessionFile],
      rebuildRows: current.invalidRows,
    });
    expect(await report.read()).toMatchObject({
      summaries: [{ totalTokens: 10 }],
      cacheStatus: { status: "fresh" },
      invalidRows: [],
    });
  });
});

it("refreshes and loads usage without executing cache SQL on the caller", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-worker";
    const sessionFile = state.path("usage.jsonl");
    const otherFile = state.path("other-usage.jsonl");
    await fs.writeFile(sessionFile, usageLine(undefined, false));
    await fs.writeFile(otherFile, usageLine("other-1") + usageLine("other-2"));
    const database = openOpenClawAgentDatabase({ agentId });
    const hostSql = observeHostDataSql();
    try {
      expect(await refresh(agentId, [sessionFile, otherFile])).toBe("refreshed");
      expect(hostSql.queries.filter((sql) => /\bcache_entries\b/i.test(sql))).toEqual([]);
    } finally {
      hostSql.restore();
    }
    expect(await usageCacheSqlite.isSessionCostUsageRefreshRunning(agentId)).toBe(false);
    const { prepared, request } = await sessionReport(agentId, sessionFile);
    const statement = database.db.prepare("SELECT value_json FROM cache_entries");
    const reads = observeHostDataSql();
    const cacheReads = () =>
      reads.queries.filter((sql) => /^select\b.*\bfrom\s+["`]?cache_entries["`]?/is.test(sql));
    try {
      statement.all();
      expect(cacheReads()).toHaveLength(1);
      reads.queries.length = 0;
      {
        using _ = vi
          .spyOn(usageCacheSqlite, "isSessionCostUsageRefreshRunning")
          .mockRejectedValue(new Error("Refresh status is unavailable"));
        for (let round = 0; round < 2; round++) {
          expectFresh(await readSession(agentId, sessionFile), 10);
        }
      }
      const selection = [{ sessionId: "selected", sessionFile }];
      const reading = runUsageCostWorker(prepared, { ...request, sessions: selection });
      selection[0]!.sessionFile = otherFile;
      selection.push({ sessionId: "other", sessionFile: otherFile });
      expect(await reading).toMatchObject({
        kind: "sessions",
        summaries: [{ sessionId: "selected", sessionFile, totalTokens: 10 }],
        cacheStatus: { status: "fresh", cachedFiles: 1 },
      });
      expect(await runUsageCostWorker(prepared, { ...request, sessions: [] })).toMatchObject({
        kind: "sessions",
        summaries: [],
        cacheStatus: { status: "fresh", cachedFiles: 0 },
      });
      expect(cacheReads()).toEqual([]);
    } finally {
      reads.restore();
    }
  });
});

it("leaves an empty usage store absent until a transcript needs a rollup", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-empty-refresh";
    const { databasePath } = prepareUsageCostWorker({ config, agentId }).location;
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await refresh(agentId)).toBe("refreshed");
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });

    openOpenClawAgentDatabase({ agentId });
    expect(await refresh(agentId)).toBe("refreshed");

    const sessionsDir = state.sessionsDir(agentId);
    const sessionFile = path.join(sessionsDir, "recorded.jsonl");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(sessionFile, usageLine("recorded"));
    expect(await refresh(agentId)).toBe("refreshed");
    expectFresh(await readSession(agentId, sessionFile), 10);
  });
  // A cache-miss worker retains no database; runtime shutdown owns its retirement.
  await closeStateDatabaseForTest();
});

it("waits for another session's refresh before filling its own detail cache", async () => {
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "usage-waiting-detail";
      const firstFile = state.path("first-detail.jsonl");
      const secondFile = state.path("second-detail.jsonl");
      await fs.writeFile(firstFile, usageLine("first"));
      await fs.writeFile(secondFile, usageLine("second-before"));
      const held = holdRefreshWrites([agentId]);
      const first = held.gate(agentId);
      const refreshing = refresh(agentId, [firstFile]);
      let waiting: ReturnType<typeof refreshCostUsageCacheForAgent> | undefined;
      try {
        await waitForHost(
          first.entered.promise,
          refreshing,
          "Refresh did not reach its host write",
        );
        await fs.appendFile(secondFile, usageLine("second-after"));
        waiting = refreshCostUsageCacheForAgent({
          config,
          agentId,
          sessionFiles: [secondFile],
          waitForRefresh: true,
        });
        first.release.resolve();
        expect(await refreshing).toBe("refreshed");
        expect(await waiting).toBe("refreshed");
        expectFresh(await readSession(agentId, secondFile), 20);
      } finally {
        first.release.resolve();
        await Promise.allSettled([refreshing, waiting]);
        held.observer.mockRestore();
      }
    });
  } finally {
    await closeStateDatabaseForTest();
  }
});

it("serves fresh and partial usage while refresh waits for its host writer", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot(config);
    const agentId = "usage-read-during-refresh";
    const sessionsDir = state.sessionsDir(agentId);
    const growingFile = path.join(sessionsDir, "growing.jsonl");
    const steadyFile = path.join(sessionsDir, "steady.jsonl");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(growingFile, usageLine("before-refresh"));
    await fs.writeFile(steadyFile, usageLine("unchanged"));
    expect(await refresh(agentId)).toBe("refreshed");
    await fs.appendFile(growingFile, usageLine("awaiting-write"));
    const placement = await createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase(),
    }).startDispatch({
      agentId,
      sessionId: "missing-placement-session",
      sessionKey: `agent:${agentId}:missing-placement-session`,
    });

    const writeEntered = createDeferred();
    const releaseWrite = createDeferred();
    let heldWrite = false;
    let refreshFinished = false;
    using _ = observeHostRequests(async (value, next) => {
      if (
        !heldWrite &&
        isRecord(value) &&
        value.kind === "write" &&
        Array.isArray(value.input) &&
        value.input.some((row) => isRecord(row) && row.key === growingFile)
      ) {
        heldWrite = true;
        writeEntered.resolve();
        await releaseWrite.promise;
      }
      return next();
    });
    const published = vi.fn();
    sessionCostUsageNotifications.onUpdated = published;
    const refreshing = refresh(agentId).then((result) => {
      refreshFinished = true;
      return result;
    });
    const reads: Promise<unknown>[] = [];
    const summaryParams = {
      config,
      agentId,
      startMs: Date.parse("2026-09-18T00:00:00Z"),
      endMs: Date.parse("2026-09-18T23:59:59Z"),
      requestRefresh: false,
    };
    try {
      await waitForHost(writeEntered.promise, refreshing, "Refresh did not reach its host write");
      const fresh = readSession(agentId, steadyFile);
      const partial = loadCostUsageSummaryFromCache(summaryParams);
      const stale = readSession(agentId, growingFile);
      const evidence = createWorkerPlacementSessionEvidenceResolver([placement]).then((resolve) =>
        resolve(placement),
      );
      reads.push(fresh, partial, evidence, stale);
      const [freshResult, partialResult, placementEvidence, staleResult] = await withTestTimeout(
        Promise.all([fresh, partial, evidence, stale]),
        10_000,
        "Usage reads waited for the blocked refresh writer",
      );
      expect(refreshFinished).toBe(false);
      expect(published).not.toHaveBeenCalled();
      expect(placementEvidence).toBe("absent");
      expect(freshResult).toMatchObject({
        cacheStatus: { status: "fresh", cachedFiles: 1 },
        summaries: [{ totalTokens: 10 }],
      });
      expect(partialResult).toMatchObject({
        totals: { totalTokens: 20 },
        cacheStatus: { status: "refreshing", cachedFiles: 2, staleFiles: 1 },
      });
      expect(staleResult).toMatchObject({
        summaries: [
          {
            totalTokens: 10,
            refreshing: true,
            computedAt: expect.any(Number),
            staleSince: expect.any(Number),
          },
        ],
        cacheStatus: { status: "refreshing", cachedFiles: 1, staleFiles: 1 },
      });
    } finally {
      releaseWrite.resolve();
      await Promise.allSettled([refreshing, ...reads]);
    }
    expect(await refreshing).toBe("refreshed");
    expect(published).toHaveBeenCalledExactlyOnceWith({
      agentId,
      usageUpdatedAt: expect.any(Number),
    });
    expect((await loadCostUsageSummaryFromCache(summaryParams)).totals.totalTokens).toBe(30);
  });
}, 30_000);

it("prunes a cached transcript after its queued selection disappears", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-missing-transcript";
    const sessionFile = state.path("disappearing.jsonl");
    const sessions = [{ sessionFile }];
    await fs.writeFile(sessionFile, usageLine("selected"));
    await refresh(agentId, [sessionFile]);
    expectFresh(await readSession(agentId, sessionFile), 10);
    await fs.rm(sessionFile);
    const work = new AsyncWorkScope();
    const published = vi.fn();
    sessionCostUsageNotifications.onUpdated = published;
    try {
      expect(
        await work.track(() => loadSessionCostSummariesFromCache({ config, agentId, sessions })),
      ).toMatchObject({ summaries: [null], cacheStatus: { status: "refreshing" } });
      await work.runWhenIdle(() => undefined);
      expect(published).toHaveBeenNthCalledWith(1, {
        agentId,
        usageUpdatedAt: expect.any(Number),
        usageRefreshFailed: true,
      });
      expect(published).toHaveBeenNthCalledWith(2, { agentId, usageUpdatedAt: expect.any(Number) });
      expect(readSessionCostUsageRollupRows(agentId).some((row) => row.key === sessionFile)).toBe(
        false,
      );
      await fs.writeFile(sessionFile, usageLine("restored"));
      await refresh(agentId, [sessionFile]);
      expect(published).toHaveBeenCalledTimes(3);
      expect(published).toHaveBeenLastCalledWith({ agentId, usageUpdatedAt: expect.any(Number) });
      await refresh(agentId, [sessionFile]);
      expect(published).toHaveBeenCalledTimes(3);
    } finally {
      await work.drain();
    }
  });
});

it("propagates an original host pricing error through exact report replay", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-host-pricing-failure";
    const sessionFile = state.path("unpriced.jsonl");
    const timestamp = Date.UTC(2026, 8, 18);
    await fs.writeFile(sessionFile, usageLine(undefined, false));
    await refresh(agentId, [sessionFile]);
    const { prepared, request } = await sessionReport(agentId, sessionFile, config);
    const exactRequest = { ...request, startMs: timestamp, endMs: timestamp + 1 };
    const original = new Error("Host pricing is unavailable");
    const pricing = await import("./session-cost-usage-pricing-context.js");
    {
      using _ = vi.spyOn(pricing, "createUsageCostResolver").mockReturnValue(() => {
        throw original;
      });
      await expect(runUsageCostWorker(prepared, exactRequest)).rejects.toBe(original);
    }
    await expect(runUsageCostWorker(prepared, exactRequest)).resolves.toMatchObject({
      kind: "sessions",
      summaries: [{ totalTokens: 10 }],
    });
  });
  // Close the pooled runtime before asserting every observed worker retired.
  await closeStateDatabaseForTest();
});

it("records failed rollups and clears health after retry", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-failure-health";
    const sessionFiles = ["a", "b"].map((id) => state.path(`${id}.jsonl`));
    const refreshFailed = () => refresh(agentId, sessionFiles);
    await Promise.all(sessionFiles.map((file) => fs.writeFile(file, usageLine("failed-refresh"))));
    let failedFiles: string[] = [];
    const published = vi.fn();
    sessionCostUsageNotifications.onUpdated = published;
    const prepareLock = usageCacheSqlite.prepareSessionCostUsageRefreshLock;
    {
      using _ = vi
        .spyOn(usageCacheSqlite, "prepareSessionCostUsageRefreshLock")
        .mockImplementation((...args) => ({
          ...prepareLock(...args),
          writeRollup: async (rows) => {
            failedFiles = rows.map((row) => row.rollupId);
            throw new Error("private transcript content");
          },
        }));
      await expect(refreshFailed()).rejects.toThrow("private transcript content");
      expect(published).toHaveBeenCalledExactlyOnceWith({
        agentId,
        usageUpdatedAt: expect.any(Number),
        usageRefreshFailed: true,
      });
    }
    const failures = await openUsageCostRefreshFailures(state.env).entries();
    expect(failures.map(({ value }) => value)).toMatchObject(
      failedFiles.map((sessionFile) => ({ agentId, sessionFile, failedAt: expect.any(Number) })),
    );
    expect(JSON.stringify(failures)).not.toContain("private transcript content");
    note.mockClear();
    await maybeRepairLegacyRuntimeFiles(false, state.env);
    for (const file of failedFiles) {
      expect(note).toHaveBeenCalledWith(expect.stringContaining(file), "Usage cost cache");
    }
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("cached totals may be incomplete"),
      "Usage cost cache",
    );
    await refreshFailed();
    expect(published).toHaveBeenCalledTimes(2);
    expect(published).toHaveBeenLastCalledWith({ agentId, usageUpdatedAt: expect.any(Number) });
    expect(await openUsageCostRefreshFailures(state.env).entries()).toEqual([]);
    note.mockClear();
    await maybeRepairLegacyRuntimeFiles(false, state.env);
    expect(note.mock.calls.filter(([, title]) => title === "Usage cost cache")).toEqual([]);
  });
  // A cache-miss worker retains no database; runtime shutdown owns its retirement.
  await closeStateDatabaseForTest();
});

it("retains a late host write failure after cancellation and releases the lock only after settlement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-canceled-write";
    const sessionFile = state.path("canceled-write.jsonl");
    await fs.writeFile(sessionFile, usageLine("before-cancellation"));
    expect(await refresh(agentId, [sessionFile])).toBe("refreshed");
    await fs.appendFile(sessionFile, usageLine("committed-before-cancellation"));

    const work = new AsyncWorkScope();
    const cancellation = new Error("Usage refresh canceled while its host write was pending");
    const original = Object.assign(
      new SqliteWorkerError("Rollup commit acknowledgement was lost", "outcome-unknown"),
      { operation: "session-cost-usage.rollup.write", sqliteCode: "SQLITE_IOERR" },
    );
    const held = holdRefreshWrites([agentId], { commitBeforeWait: true, failure: original });
    const write = held.gate(agentId);
    const { entered: writeAccepted, release: releaseWrite, events } = write;
    let refreshSettled = false;
    const refreshing = work.track(() => refresh(agentId, [sessionFile]));
    const outcome = refreshing.then(
      () => {
        refreshSettled = true;
        throw new Error("Canceled refresh concealed its late host write failure");
      },
      (error: unknown) => {
        refreshSettled = true;
        return error;
      },
    );
    try {
      await waitForHost(writeAccepted.promise, outcome, "Refresh did not reach its host write");
      events.push("canceled");
      work.beginClose(cancellation);
      await expect
        .poll(
          () =>
            observed.refreshWorkers.size > 0 &&
            [...observed.refreshWorkers].every((worker) => worker.threadId === -1),
          { timeout: 10_000 },
        )
        .toBe(true);
      expect(refreshSettled).toBe(false);
      expect(work.hasPendingWork).toBe(true);
      expect(events).toEqual(["write-committed", "canceled"]);

      releaseWrite.resolve();
      const failure = await withTestTimeout(
        outcome,
        10_000,
        "Canceled refresh did not join its host write",
      );
      expect(collectNestedErrorCandidates(failure)).toContain(original);
      expect(failure).toMatchObject({ code: "outcome-unknown" });
      expect(events).toEqual(["write-committed", "canceled", "write-settled", "lock-cleanup"]);
      expect(write.writes).toBe(1);
    } finally {
      work.beginClose(cancellation);
      releaseWrite.resolve();
      await Promise.allSettled([outcome]);
      await work.drain();
      held.observer.mockRestore();
    }
    expect(await usageCacheSqlite.isSessionCostUsageRefreshRunning(agentId)).toBe(false);
    expectFresh(await readSession(agentId, sessionFile), 20);
  });
}, 40_000);

it("settles canceled refresh cleanup without waiting for its admitted successor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentA = "usage-canceled-owner";
    const agentB = "usage-held-successor";
    const fileA = state.path("canceled-owner.jsonl");
    const fileB = state.path("held-successor.jsonl");
    for (const { agentId, sessionFile } of [
      { agentId: agentA, sessionFile: fileA },
      { agentId: agentB, sessionFile: fileB },
    ]) {
      openOpenClawAgentDatabase({ agentId, env: state.env });
      await fs.writeFile(sessionFile, usageLine("first") + usageLine("second"));
    }
    const workA = new AsyncWorkScope();
    const held = holdRefreshWrites([agentA, agentB]);
    const first = held.gate(agentA);
    const successor = held.gate(agentB);
    const queuedB = createDeferred();
    const canceled = new Error("First refresh canceled");
    let watchSuccessor = false;
    let successorSettled = false;
    // oxlint-disable-next-line typescript/unbound-method -- The observer forwards the pool receiver.
    const run = WorkerTaskPool.prototype.run;
    const pools = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(function (
      this: WorkerTaskPool<unknown, unknown>,
      input: WorkerTaskInput<unknown>,
      options: WorkerTaskOptions<unknown>,
    ) {
      const result = run.call(this, input, options);
      if (watchSuccessor && options.onRequest) {
        watchSuccessor = false;
        queuedB.resolve();
      }
      return result;
    });
    const refreshA = workA.track(() => refresh(agentA, [fileA]));
    const outcomeA = refreshA.then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    );
    let refreshB: Promise<"refreshed" | "busy"> | undefined;
    try {
      await waitForHost(
        first.entered.promise,
        outcomeA,
        "First refresh did not reach its host write",
      );
      watchSuccessor = true;
      refreshB = refresh(agentB, [fileB]);
      const outcomeB = refreshB.finally(() => {
        successorSettled = true;
      });
      await waitForHost(
        queuedB.promise,
        outcomeB,
        "Successor was not queued behind the first refresh",
      );
      workA.beginClose(canceled);
      await withTestTimeout(
        successor.entered.promise,
        10_000,
        "Successor did not reach its held host write",
      );
      const successorWorker = [...observed.refreshWorkers].find((worker) => worker.threadId !== -1);
      const successorThreadId = successorWorker?.threadId;
      expect(successorThreadId).toBeGreaterThan(0);
      first.release.resolve();
      expect(
        await withTestTimeout(outcomeA, 10_000, "Canceled refresh waited for its held successor"),
      ).toMatchObject({ ok: false });
      await workA.drain();
      expect(first.cleaned).toBe(true);
      expect(successor.cleaned).toBe(false);
      expect(successorSettled).toBe(false);
      expect(successorWorker?.threadId).toBe(successorThreadId);
      expect([...observed.refreshWorkers].filter((worker) => worker.threadId !== -1)).toHaveLength(
        1,
      );
      expect(await usageCacheSqlite.isSessionCostUsageRefreshRunning(agentA)).toBe(false);
      expect(await usageCacheSqlite.isSessionCostUsageRefreshRunning(agentB)).toBe(true);
    } finally {
      workA.beginClose(canceled);
      first.release.resolve();
      successor.release.resolve();
      await Promise.allSettled([refreshA, refreshB]);
      await workA.drain();
      pools.mockRestore();
      held.observer.mockRestore();
    }
    expect(await refreshB).toBe("refreshed");
    expect(successor.writes).toBe(1);
    expectFresh(await readSession(agentB, fileB), 20);
  });
}, 40_000);
