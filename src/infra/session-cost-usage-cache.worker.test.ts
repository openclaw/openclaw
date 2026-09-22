import fs from "node:fs/promises";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  createSessionEntryWithTranscript,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import { createWorkerPlacementSessionEvidenceResolver } from "../gateway/server-worker-placement-session-evidence.js";
import { createWorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import * as usageCacheSqlite from "./session-cost-usage-cache.sqlite.js";
import { readSessionCostUsageRollupRows } from "./session-cost-usage-cache.test-support.js";
import { resolveUsageCostPricingFingerprint } from "./session-cost-usage-pricing-context.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";
import {
  loadCostUsageSummaryFromCache,
  loadSessionCostSummariesFromCache,
} from "./session-cost-usage.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import { WorkerTaskPool } from "./worker-task-pool.js";
import type { WorkerTaskInput, WorkerTaskOptions } from "./worker-task-pool.types.js";

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
  const workers = [...observed.workers];
  observed.workers.clear();
  observed.refreshWorkers.clear();
  for (const worker of workers) {
    expect(worker.threadId).toBe(-1);
  }
});

function usageLine(id: string): string {
  return `${JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-18T00:00:00Z",
    message: {
      role: "assistant",
      provider: "test",
      model: "test",
      usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
    },
  })}\n`;
}

it("rebuilds corrupt report bodies only for the exact rejected metadata snapshot", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-corrupt-body";
    const sessionFile = state.path("usage-corrupt-body.jsonl");
    await fs.writeFile(sessionFile, usageLine("stored"));
    await refreshCostUsageCacheForAgent({ agentId, sessionFiles: [sessionFile] });
    const prepared = prepareUsageCostWorker({ agentId, sessionFiles: [sessionFile] });
    const pricingFingerprint = await resolveUsageCostPricingFingerprint(
      undefined,
      prepared.agentDir,
    );
    const request = {
      kind: "sessions" as const,
      pricingFingerprint,
      sessions: [{ sessionFile }],
      dayBucket: { mode: "utc-offset" as const, utcOffsetMinutes: 0 },
    };
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
    const rejected = await runUsageCostWorker(prepared, request);
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
      agentId,
      sessionFiles: [sessionFile],
      rebuildRows: rejected.invalidRows,
    });
    expect(readSessionCostUsageRollupRows(agentId)).toEqual(before);
    expect(await runUsageCostWorker(prepared, request)).toMatchObject({
      summaries: [{ totalTokens: 10 }],
      invalidRows: [],
    });

    corrupt();
    const current = await runUsageCostWorker(prepared, request);
    if (current.kind !== "sessions") {
      throw new Error("Expected current session report");
    }
    await refreshCostUsageCacheForAgent({
      agentId,
      sessionFiles: [sessionFile],
      rebuildRows: current.invalidRows,
    });
    expect(await runUsageCostWorker(prepared, request)).toMatchObject({
      summaries: [{ totalTokens: 10 }],
      cacheStatus: { status: "fresh" },
      invalidRows: [],
    });
  });
});

it("loads fresh session usage without executing cache reads on the caller", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-worker";
    const sessionFile = state.path("usage.jsonl");
    const otherFile = state.path("other-usage.jsonl");
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        timestamp: "2026-09-18T00:00:00Z",
        message: {
          role: "assistant",
          provider: "test",
          model: "test",
          usage: { input: 7, output: 3, totalTokens: 10 },
        },
      }) + "\n",
    );
    await fs.writeFile(otherFile, usageLine("other-1") + usageLine("other-2"));
    await refreshCostUsageCacheForAgent({ agentId, sessionFiles: [sessionFile, otherFile] });
    const prepared = prepareUsageCostWorker({ agentId, sessionFiles: [sessionFile, otherFile] });
    const pricingFingerprint = await resolveUsageCostPricingFingerprint(
      undefined,
      prepared.agentDir,
    );
    const database = openOpenClawAgentDatabase({ agentId });
    const statement = database.db.prepare("SELECT value_json FROM cache_entries");
    const prototype: StatementSync = Object.getPrototypeOf(statement);
    const observers = [
      vi.spyOn(prototype, "all"),
      vi.spyOn(prototype, "get"),
      vi.spyOn(prototype, "iterate"),
      vi.spyOn(prototype, "run"),
    ];
    const cacheReads = () =>
      observers.flatMap((observer) =>
        observer.mock.contexts
          .map((value) => (value as StatementSync).sourceSQL)
          .filter((sql) => /^select\b.*\bfrom\s+["`]?cache_entries["`]?/is.test(sql)),
      );
    try {
      statement.all();
      expect(cacheReads()).toHaveLength(1);
      for (const observer of observers) {
        observer.mockClear();
      }
      for (let round = 0; round < 2; round++) {
        const result = await loadSessionCostSummariesFromCache({
          agentId,
          sessions: [{ sessionFile }],
          requestRefresh: false,
        });
        expect(result.cacheStatus.status).toBe("fresh");
        expect(result.summaries[0]).toMatchObject({ totalTokens: 10 });
      }
      const selection = [{ sessionId: "selected", sessionFile }];
      const reading = runUsageCostWorker(prepared, {
        kind: "sessions",
        pricingFingerprint,
        sessions: selection,
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
      });
      selection[0]!.sessionFile = otherFile;
      selection.push({ sessionId: "other", sessionFile: otherFile });
      expect(await reading).toMatchObject({
        kind: "sessions",
        summaries: [{ sessionId: "selected", sessionFile, totalTokens: 10 }],
        cacheStatus: { status: "fresh", cachedFiles: 1 },
      });
      expect(
        await runUsageCostWorker(prepared, {
          kind: "sessions",
          pricingFingerprint,
          sessions: [],
          dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
        }),
      ).toMatchObject({
        kind: "sessions",
        summaries: [],
        cacheStatus: { status: "fresh", cachedFiles: 0 },
      });
      expect(cacheReads()).toEqual([]);
    } finally {
      for (const observer of observers) {
        observer.mockRestore();
      }
    }
  });
});

it("retains the process-held incognito cache without creating its sentinel file", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-incognito";
    const databasePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId });
    const sessionId = "incognito-usage";
    const scope = {
      agentId,
      sessionKey: `agent:${agentId}:dashboard:incognito-usage`,
      storePath: databasePath,
      env: state.env,
    };
    await createSessionEntryWithTranscript(
      scope,
      () => ({ ok: true, entry: { incognito: true as const, sessionId, updatedAt: 1 } }),
      { cwd: state.workspaceDir },
    );
    await persistSessionTranscriptTurn(
      { ...scope, sessionId },
      {
        messages: [
          {
            message: {
              role: "assistant",
              content: "incognito usage",
              timestamp: Date.parse("2026-09-18T00:00:00Z"),
              usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
            },
          },
        ],
        touchSessionEntry: false,
      },
    );
    const sessionFile = formatSqliteSessionFileMarker({
      agentId,
      sessionId,
      storePath: databasePath,
    });
    const prepared = prepareUsageCostWorker({
      agentId,
      databasePath,
      storePath: databasePath,
      sessionFiles: [sessionFile],
    });
    const pricingFingerprint = await resolveUsageCostPricingFingerprint(
      undefined,
      prepared.agentDir,
    );
    expect(
      await runUsageCostWorker(prepared, {
        kind: "refresh",
        sessionFiles: [sessionFile],
      }),
    ).toMatchObject({ kind: "refresh" });
    expect(
      await runUsageCostWorker(prepared, {
        kind: "sessions",
        pricingFingerprint,
        sessions: [{ sessionId, sessionFile }],
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
      }),
    ).toMatchObject({
      kind: "sessions",
      summaries: [{ sessionId, sessionFile, totalTokens: 10, totalCost: 1 }],
      cacheStatus: { status: "fresh", cachedFiles: 1 },
    });
    const { db } = openOpenClawAgentDatabase({ agentId, path: databasePath, env: state.env });
    for (const changes of [1, Number.POSITIVE_INFINITY]) {
      let changed = 0;
      // oxlint-disable-next-line typescript/unbound-method -- The observer forwards the pool receiver.
      const run = WorkerTaskPool.prototype.run;
      const observer = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(function (
        this: WorkerTaskPool<unknown, unknown>,
        input: WorkerTaskInput<unknown>,
        options: WorkerTaskOptions<unknown>,
      ) {
        const onRequest = options.onRequest;
        if (!onRequest) {
          return run.call(this, input, options);
        }
        return run.call(this, input, {
          ...options,
          onRequest: (value, context) => {
            if (changed < changes && isRecord(value) && value.kind === "memory-cache-body") {
              db.prepare(`UPDATE cache_entries SET
                value_json = json_set(value_json, '$.scannedAt', json_extract(value_json, '$.scannedAt') + 1),
                updated_at = updated_at + 1 WHERE scope = 'session-cost-usage-rollup-v3'`).run();
              changed++;
            }
            return onRequest(value, context);
          },
        });
      });
      try {
        const reading = runUsageCostWorker(prepared, {
          kind: "sessions",
          pricingFingerprint,
          sessions: [{ sessionId, sessionFile }],
          dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
        });
        if (changes === 1) {
          await expect(reading).resolves.toMatchObject({
            summaries: [{ totalTokens: 10, totalCost: 1 }],
            cacheStatus: { status: "fresh", cachedFiles: 1 },
          });
          expect(changed).toBe(1);
        } else {
          await expect(reading).rejects.toMatchObject({ code: "unavailable" });
          expect(changed).toBe(3);
        }
      } finally {
        observer.mockRestore();
      }
    }
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("serves fresh and partial usage while refresh waits for its host writer", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-read-during-refresh";
    const sessionsDir = state.sessionsDir(agentId);
    const growingFile = path.join(sessionsDir, "growing.jsonl");
    const steadyFile = path.join(sessionsDir, "steady.jsonl");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(growingFile, usageLine("before-refresh"));
    await fs.writeFile(steadyFile, usageLine("unchanged"));
    expect(await refreshCostUsageCacheForAgent({ agentId })).toBe("refreshed");
    await fs.appendFile(growingFile, usageLine("awaiting-write"));
    const placement = createWorkerSessionPlacementStore({
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
    // oxlint-disable-next-line typescript/unbound-method -- The observer forwards the pool receiver.
    const run = WorkerTaskPool.prototype.run;
    const observer = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(function (
      this: WorkerTaskPool<unknown, unknown>,
      input: WorkerTaskInput<unknown>,
      options: WorkerTaskOptions<unknown>,
    ) {
      const onRequest = options.onRequest;
      if (!onRequest) {
        return run.call(this, input, options);
      }
      return run.call(this, input, {
        ...options,
        onRequest: async (value, context) => {
          if (
            !heldWrite &&
            isRecord(value) &&
            value.kind === "write" &&
            isRecord(value.input) &&
            value.input.key === growingFile
          ) {
            heldWrite = true;
            writeEntered.resolve();
            await releaseWrite.promise;
          }
          return onRequest(value, context);
        },
      });
    });
    const refresh = refreshCostUsageCacheForAgent({ agentId }).then((result) => {
      refreshFinished = true;
      return result;
    });
    const reads: Promise<unknown>[] = [];
    const summaryParams = {
      agentId,
      startMs: Date.parse("2026-09-18T00:00:00Z"),
      endMs: Date.parse("2026-09-18T23:59:59Z"),
      requestRefresh: false,
    };
    try {
      await withTestTimeout(
        Promise.race([
          writeEntered.promise,
          refresh.then(() => {
            throw new Error("Refresh completed before requesting its rollup write");
          }),
        ]),
        10_000,
        "Refresh did not reach its host write",
      );
      const fresh = loadSessionCostSummariesFromCache({
        agentId,
        sessions: [{ sessionFile: steadyFile }],
        requestRefresh: false,
      });
      const partial = loadCostUsageSummaryFromCache(summaryParams);
      const evidence = createWorkerPlacementSessionEvidenceResolver([placement]).then((resolve) =>
        resolve(placement),
      );
      reads.push(fresh, partial, evidence);
      const [freshResult, partialResult, placementEvidence] = await withTestTimeout(
        Promise.all([fresh, partial, evidence]),
        10_000,
        "Usage reads waited for the blocked refresh writer",
      );
      expect(refreshFinished).toBe(false);
      expect(placementEvidence).toBe("absent");
      expect(observed.refreshWorkers.size).toBeGreaterThan(0);
      for (const worker of observed.refreshWorkers) {
        expect(worker.threadId).not.toBe(-1);
      }
      expect(freshResult.cacheStatus).toMatchObject({ status: "fresh", cachedFiles: 1 });
      expect(freshResult.summaries[0]).toMatchObject({ totalTokens: 10 });
      expect(partialResult.totals.totalTokens).toBe(20);
      expect(partialResult.cacheStatus).toMatchObject({
        status: "refreshing",
        cachedFiles: 2,
        staleFiles: 1,
      });
    } finally {
      releaseWrite.resolve();
      await Promise.allSettled([refresh, ...reads]);
      observer.mockRestore();
    }
    expect(await refresh).toBe("refreshed");
    expect((await loadCostUsageSummaryFromCache(summaryParams)).totals.totalTokens).toBe(30);
  });
}, 30_000);

it("preserves the original host failure when lock cleanup fails and retries that cleanup on close", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-host-failure";
    const sessionFile = state.path("host-failure.jsonl");
    await fs.writeFile(sessionFile, usageLine("before-failure"));
    expect(await refreshCostUsageCacheForAgent({ agentId, sessionFiles: [sessionFile] })).toBe(
      "refreshed",
    );
    await fs.appendFile(sessionFile, usageLine("rejected-write"));
    const database = openOpenClawAgentDatabase({ agentId, env: state.env });
    const primary = Object.assign(new SqliteWorkerError("host write failed", "outcome-unknown"), {
      operation: "session-cost-usage.rollup.write",
      sqliteCode: "SQLITE_IOERR",
    });
    const cleanupFailure = new Error("refresh lock cleanup acknowledgement failed");
    let cleanupAttempts = 0;
    let nativeExitBeforeCleanup = false;
    const prepareLock = usageCacheSqlite.prepareSessionCostUsageRefreshLock;
    const observer = vi
      .spyOn(usageCacheSqlite, "prepareSessionCostUsageRefreshLock")
      .mockImplementation((...args) => {
        const lock = prepareLock(...args);
        if (args[0] !== agentId) {
          return lock;
        }
        return {
          ...lock,
          writeRollup: async () => {
            throw primary;
          },
          release: async () => {
            nativeExitBeforeCleanup =
              observed.refreshWorkers.size > 0 &&
              [...observed.refreshWorkers].every((worker) => worker.threadId === -1);
            await lock.release();
            cleanupAttempts++;
            if (cleanupAttempts === 1) {
              throw cleanupFailure;
            }
          },
        };
      });
    try {
      const failure = await refreshCostUsageCacheForAgent({
        agentId,
        sessionFiles: [sessionFile],
      }).then(
        () => {
          throw new Error("Refresh accepted the injected host failure");
        },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) {
        throw new Error("Refresh did not retain both failures", { cause: failure });
      }
      expect(failure.errors).toHaveLength(2);
      expect(failure.errors[0]).toBe(primary);
      expect(failure.errors[1]).toBe(cleanupFailure);
      expect(failure.cause).toBe(primary);
      expect(failure).toMatchObject({ code: "outcome-unknown" });
      expect(nativeExitBeforeCleanup).toBe(true);
      expect(cleanupAttempts).toBe(1);
      await closeOpenClawAgentDatabaseByPathAsync(database.path, agentId);
      expect(cleanupAttempts).toBe(2);
    } finally {
      observer.mockRestore();
    }
  });
}, 30_000);

it("retains a late host write failure after cancellation and releases the lock only after settlement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-canceled-write";
    const sessionFile = state.path("canceled-write.jsonl");
    await fs.writeFile(sessionFile, usageLine("before-cancellation"));
    expect(await refreshCostUsageCacheForAgent({ agentId, sessionFiles: [sessionFile] })).toBe(
      "refreshed",
    );
    await fs.appendFile(sessionFile, usageLine("committed-before-cancellation"));

    const work = new AsyncWorkScope();
    const cancellation = new Error("Usage refresh canceled while its host write was pending");
    const original = Object.assign(
      new SqliteWorkerError("Rollup commit acknowledgement was lost", "outcome-unknown"),
      { operation: "session-cost-usage.rollup.write", sqliteCode: "SQLITE_IOERR" },
    );
    const writeAccepted = createDeferred();
    const releaseWrite = createDeferred();
    const events: string[] = [];
    let writeAttempts = 0;
    let refreshSettled = false;
    const prepareLock = usageCacheSqlite.prepareSessionCostUsageRefreshLock;
    const observer = vi
      .spyOn(usageCacheSqlite, "prepareSessionCostUsageRefreshLock")
      .mockImplementation((...args) => {
        const lock = prepareLock(...args);
        if (args[0] !== agentId) {
          return lock;
        }
        return {
          ...lock,
          writeRollup: async (params) => {
            writeAttempts++;
            const written = await lock.writeRollup(params);
            if (!written) {
              throw new Error("The prepared rollup was not committed");
            }
            events.push("write-committed");
            writeAccepted.resolve();
            await releaseWrite.promise;
            events.push("write-settled");
            throw original;
          },
          release: async () => {
            events.push("lock-cleanup");
            await lock.release();
          },
        };
      });
    const refresh = work.track(() =>
      refreshCostUsageCacheForAgent({ agentId, sessionFiles: [sessionFile] }),
    );
    const outcome = refresh.then(
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
      await withTestTimeout(
        Promise.race([
          writeAccepted.promise,
          outcome.then((error) => {
            throw new Error("Refresh ended before committing its host write", { cause: error });
          }),
        ]),
        10_000,
        "Refresh did not reach its host write",
      );
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
      const errors = new Set<unknown>();
      const pending = [failure];
      while (pending.length > 0) {
        const error = pending.pop();
        if (errors.has(error)) {
          continue;
        }
        errors.add(error);
        if (error instanceof Error) {
          pending.push(error.cause);
          if (error instanceof AggregateError) {
            pending.push(...error.errors);
          }
        }
      }
      expect(errors.has(original)).toBe(true);
      expect(failure).toMatchObject({ code: "outcome-unknown" });
      expect(events).toEqual(["write-committed", "canceled", "write-settled", "lock-cleanup"]);
      expect(writeAttempts).toBe(1);
    } finally {
      work.beginClose(cancellation);
      releaseWrite.resolve();
      await Promise.allSettled([outcome]);
      await work.drain();
      observer.mockRestore();
    }
    expect(await usageCacheSqlite.isSessionCostUsageRefreshRunning(agentId)).toBe(false);
    const persisted = await loadSessionCostSummariesFromCache({
      agentId,
      sessions: [{ sessionFile }],
      requestRefresh: false,
    });
    expect(persisted.cacheStatus.status).toBe("fresh");
    expect(persisted.summaries[0]).toMatchObject({ totalTokens: 20 });
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
      await fs.writeFile(sessionFile, usageLine("cached"));
      await refreshCostUsageCacheForAgent({ agentId, sessionFiles: [sessionFile] });
      await fs.appendFile(sessionFile, usageLine("pending"));
    }
    const workA = new AsyncWorkScope();
    const enteredA = createDeferred();
    const enteredB = createDeferred();
    const queuedB = createDeferred();
    const releaseA = createDeferred();
    const releaseB = createDeferred();
    const cleaned = new Set<string>();
    const canceled = new Error("First refresh canceled");
    let watchSuccessor = false;
    let successorSettled = false;
    let successorWrites = 0;
    const prepareLock = usageCacheSqlite.prepareSessionCostUsageRefreshLock;
    const locks = vi
      .spyOn(usageCacheSqlite, "prepareSessionCostUsageRefreshLock")
      .mockImplementation((...args) => {
        const lock = prepareLock(...args);
        const agentId = args[0];
        if (agentId !== agentA && agentId !== agentB) {
          return lock;
        }
        return {
          ...lock,
          writeRollup: async (params) => {
            if (agentId === agentB) {
              successorWrites++;
            }
            (agentId === agentA ? enteredA : enteredB).resolve();
            await (agentId === agentA ? releaseA : releaseB).promise;
            return lock.writeRollup(params);
          },
          release: async () => {
            await lock.release();
            cleaned.add(agentId);
          },
        };
      });
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
    const refreshA = workA.track(() =>
      refreshCostUsageCacheForAgent({ agentId: agentA, sessionFiles: [fileA] }),
    );
    const outcomeA = refreshA.then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    );
    let refreshB: Promise<"refreshed" | "busy"> | undefined;
    try {
      await withTestTimeout(
        Promise.race([
          enteredA.promise,
          outcomeA.then((outcome) => {
            throw new Error("First refresh ended before its host write", { cause: outcome });
          }),
        ]),
        10_000,
        "First refresh did not reach its host write",
      );
      watchSuccessor = true;
      refreshB = refreshCostUsageCacheForAgent({
        agentId: agentB,
        sessionFiles: [fileB],
      });
      const outcomeB = refreshB.then(
        (value) => {
          successorSettled = true;
          return { value };
        },
        (error: unknown) => {
          successorSettled = true;
          return { error };
        },
      );
      await withTestTimeout(
        Promise.race([
          queuedB.promise,
          outcomeB.then((outcome) => {
            throw new Error("Successor ended before worker admission", { cause: outcome });
          }),
        ]),
        10_000,
        "Successor was not queued behind the first refresh",
      );
      workA.beginClose(canceled);
      await withTestTimeout(
        enteredB.promise,
        10_000,
        "Successor did not reach its held host write",
      );
      const successorWorker = [...observed.refreshWorkers].find((worker) => worker.threadId !== -1);
      const successorThreadId = successorWorker?.threadId;
      expect(successorThreadId).toBeGreaterThan(0);
      releaseA.resolve();
      expect(
        await withTestTimeout(outcomeA, 10_000, "Canceled refresh waited for its held successor"),
      ).toMatchObject({ ok: false });
      await workA.drain();
      expect(cleaned.has(agentA)).toBe(true);
      expect(cleaned.has(agentB)).toBe(false);
      expect(successorSettled).toBe(false);
      expect(successorWorker?.threadId).toBe(successorThreadId);
      expect([...observed.refreshWorkers].filter((worker) => worker.threadId !== -1)).toHaveLength(
        1,
      );
      expect(await usageCacheSqlite.isSessionCostUsageRefreshRunning(agentA)).toBe(false);
      expect(await usageCacheSqlite.isSessionCostUsageRefreshRunning(agentB)).toBe(true);
    } finally {
      workA.beginClose(canceled);
      releaseA.resolve();
      releaseB.resolve();
      await Promise.allSettled([refreshA, refreshB]);
      await workA.drain();
      pools.mockRestore();
      locks.mockRestore();
    }
    expect(await refreshB).toBe("refreshed");
    expect(successorWrites).toBe(1);
    const result = await loadSessionCostSummariesFromCache({
      agentId: agentB,
      sessions: [{ sessionFile: fileB }],
      requestRefresh: false,
    });
    expect(result.cacheStatus.status).toBe("fresh");
    expect(result.summaries[0]).toMatchObject({ totalTokens: 20 });
  });
}, 40_000);
