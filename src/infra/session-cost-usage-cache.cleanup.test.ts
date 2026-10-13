import fs from "node:fs/promises";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { retireSessionHistoryWorkerDatabases } from "../config/sessions/session-transcript-worker-resources.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import * as usageCacheSqlite from "./session-cost-usage-cache.sqlite.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";

const cleanupFault = vi.hoisted(() => new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));

vi.mock("./worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worker-cpu.js")>();
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { threadId, workerData } from "node:worker_threads";
    const fault = new Int32Array(workerData.usageCleanupFault);
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (/delete from "?cache_entries"?/i.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          if (args.includes("refresh-lock") && Atomics.load(fault, 0)) {
            Atomics.add(fault, 1, 1);
            Atomics.store(fault, 2, threadId);
            if (Atomics.compareExchange(fault, 0, 1, 2) === 1) {
              Atomics.store(fault, 3, threadId);
              throw new Error("injected refresh-lock DELETE failure");
            }
          }
          return run(...args);
        };
      }
      return statement;
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: { ...options?.workerData, usageCleanupFault: cleanupFault },
      });
    },
  };
});

const observed = vi.hoisted(() => ({
  workers: new Set<Worker>(),
  refreshWorkers: new Set<Worker>(),
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
  new Int32Array(cleanupFault).fill(0);
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

it("preserves the host failure and retries a failed native lock DELETE before physical retirement", async () => {
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
    const fault = new Int32Array(cleanupFault);
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
            Atomics.store(fault, 0, 1);
            throw primary;
          },
          release: async () => {
            nativeExitBeforeCleanup =
              observed.refreshWorkers.size > 0 &&
              [...observed.refreshWorkers].every((worker) => worker.threadId === -1);
            cleanupAttempts++;
            await lock.release();
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
      expect(failure.errors[1]).toMatchObject({
        message: expect.stringContaining("injected refresh-lock DELETE failure"),
      });
      expect(failure.cause).toBe(primary);
      expect(failure).toMatchObject({ code: "outcome-unknown" });
      expect(nativeExitBeforeCleanup).toBe(true);
      expect(cleanupAttempts).toBe(1);
      expect(Atomics.load(fault, 1)).toBe(1);
      expect(await usageCacheSqlite.isSessionCostUsageRefreshRunning(agentId)).toBe(true);
      await retireSessionHistoryWorkerDatabases({ agentId, paths: [database.path] });
      await closeOpenClawAgentDatabaseByPathAsync(database.path, agentId);
      expect(cleanupAttempts).toBe(2);
      expect(Atomics.load(fault, 1)).toBe(2);
      expect(Atomics.load(fault, 2)).toBeGreaterThan(0);
      expect(Atomics.load(fault, 2)).toBe(Atomics.load(fault, 3));
      expect(await usageCacheSqlite.isSessionCostUsageRefreshRunning(agentId)).toBe(false);
    } finally {
      observer.mockRestore();
    }
  });
}, 30_000);
