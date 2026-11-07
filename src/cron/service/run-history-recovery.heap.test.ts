import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { cronRunLogEntryToDetail } from "../run-history-detail.js";
import { createCronExecutionId } from "../run-id.js";
import { recordCronRunInDatabase } from "../store/run-history.kernel.js";
import type { findCronRunRecoveryInDatabase } from "./run-history-recovery.js";

type Recovery = ReturnType<typeof findCronRunRecoveryInDatabase>;
type RecoveryInput = {
  path: string;
  jobId: string;
  startedAt: number;
  storeKey: string;
  receiptId?: string;
};

const MiB = 1024 * 1024;
const jobId = "hourly-cleanup";
const storeKey = "/fixture/cron/jobs.json";
const hourMs = 60 * 60_000;
const firstStartedAt = Date.UTC(2026, 10, 1);
// Retained history (~144 MiB of payload) exceeds the worker heap; one run (~3 MiB) does not.
const retainedRuns = 48;
const targetStartedAt = firstStartedAt + retainedRuns * hourMs;
const interruptedStartedAt = targetStartedAt + hourMs;
const targetSummary = `target summary ${"t".repeat(MiB)}`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function seedRetainedHistory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-recovery-heap-"));
  const dbPath = path.join(dir, "openclaw.sqlite");
  cleanups.push(async () => {
    await closeOpenClawStateDatabaseByPathAsync(dbPath);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const record = (startedAt: number, summary: string) => {
    const runId = `${createCronExecutionId(jobId, startedAt)}:receipt-${startedAt}`;
    const endedAt = startedAt + 60_000;
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        recordCronRunInDatabase(db, {
          storeKey,
          jobId,
          runId,
          startedAt,
          endedAt,
          status: "succeeded",
          summary,
          detail: cronRunLogEntryToDetail(
            { ts: endedAt, jobId, action: "finished", status: "ok", summary, runId },
            { storeKey },
          ),
        }),
      { path: dbPath },
    );
  };
  for (let index = 0; index < retainedRuns; index += 1) {
    record(firstStartedAt + index * hourMs, `run ${index} ${"x".repeat(1.5 * MiB)}`);
  }
  record(targetStartedAt, targetSummary);
  await closeOpenClawStateDatabaseByPathAsync(dbPath);
  return dbPath;
}

function createRecoveryPool() {
  const pool = new WorkerTaskPool<RecoveryInput, Recovery>({
    workerUrl: new URL("./run-history-recovery.heap.test-support.ts", import.meta.url),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    restartOnError: false,
    workerOptions: { resourceLimits: { maxOldGenerationSizeMb: 128 } },
  });
  cleanups.push(async () => await pool.close());
  return pool;
}

it("recovers runs of a job whose retained history exceeds the SQLite worker heap", async () => {
  const dbPath = await seedRetainedHistory();
  const pool = createRecoveryPool();

  // A run interrupted before it recorded history resolves to its receipt identity.
  const interruptedReceipt = "interrupted-receipt";
  await expect(
    pool.run(
      {
        path: dbPath,
        jobId,
        startedAt: interruptedStartedAt,
        storeKey,
        receiptId: interruptedReceipt,
      },
      {},
    ),
  ).resolves.toEqual({
    taskRunId: `${createCronExecutionId(jobId, interruptedStartedAt)}:${interruptedReceipt}`,
    receiptId: interruptedReceipt,
  });

  // A recorded run is finalized from its own complete payload.
  const recovered = await pool.run(
    {
      path: dbPath,
      jobId,
      startedAt: targetStartedAt,
      storeKey,
      receiptId: `receipt-${targetStartedAt}`,
    },
    {},
  );
  expect(recovered.taskRunId).toBe(
    `${createCronExecutionId(jobId, targetStartedAt)}:receipt-${targetStartedAt}`,
  );
  expect(recovered.finalized?.entry).toMatchObject({
    jobId,
    status: "ok",
    ts: targetStartedAt + 60_000,
    summary: targetSummary,
  });
});
