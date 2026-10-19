import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { cronRunRecordStoreKey, cronRunRecordToRunLogEntry } from "./run-history-detail.js";
import {
  readCronRunHistoryPageForTests,
  readCronRunRecordsForTests,
} from "./run-history.test-support.js";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CREATED_AT = Date.parse("2026-09-12T12:00:00.000Z");
const RUN_AT = CREATED_AT + HOUR;
const EDIT_AT = RUN_AT + 2_000;
const HOURLY = { kind: "every", everyMs: HOUR, anchorMs: CREATED_AT } as const;
const MINUTELY = { kind: "every", everyMs: MINUTE, anchorMs: EDIT_AT } as const;
const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-recovery-schedule-",
  baseTimeIso: new Date(CREATED_AT).toISOString(),
});

type RunResult = Awaited<ReturnType<CronServiceDeps["runIsolatedAgentJob"]>>;

async function createHarness(input: Partial<CronJobCreate> = {}) {
  const { storePath } = await makeStorePath();
  const evaluateCronTrigger = vi.fn(async () => ({
    kind: "evaluated" as const,
    fire: true,
    state: { observed: "completed evaluation" },
  }));
  const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
    status: "ok",
  }));
  const deps = cronTestDeps({
    storePath,
    cronConfig: { triggers: { enabled: true } },
    log: logger,
    evaluateCronTrigger,
    runIsolatedAgentJob,
  });
  const cron = new CronService(deps);
  cron.pauseScheduling();
  await cron.start();
  const job = await cron.add(
    cronTestInput({
      agentId: "main",
      schedule: HOURLY,
      trigger: { script: "json({ fire: true })" },
      wakeMode: "now",
      delivery: { mode: "none" },
      ...input,
    }),
  );
  return {
    cron,
    deps,
    evaluateCronTrigger,
    job,
    runIsolatedAgentJob,
    storePath,
    [Symbol.dispose]() {
      this.cron.stop();
    },
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

function readHistory(harness: Harness) {
  return readCronRunHistoryPageForTests({
    storeKey: cronStoreKey(harness.storePath),
    jobId: harness.job.id,
  }).entries;
}

function readTasks(harness: Harness) {
  const storeKey = cronStoreKey(harness.storePath);
  return readCronRunRecordsForTests(harness.job.id).filter(
    (task) => cronRunRecordStoreKey(task) === storeKey,
  );
}

function rejectCronRowWrite(jobId: string) {
  const database = openOpenClawStateDatabase().db;
  database.exec(`
    CREATE TRIGGER reject_cadence_row
    BEFORE UPDATE ON cron_jobs
    WHEN NEW.job_id = '${jobId.replaceAll("'", "''")}'
    BEGIN
      SELECT RAISE(ABORT, 'cadence row unavailable');
    END;
  `);
  return () => database.exec("DROP TRIGGER IF EXISTS reject_cadence_row");
}

/** Seed the released split-write crash: terminal history exists, job remains active. */
async function finishWithPendingCronRow(
  harness: Harness,
  options: {
    atMs?: number;
    endedAtMs?: number;
    result?: RunResult;
    historicalNextRunAtMs?: number;
  } = {},
) {
  const atMs = options.atMs ?? RUN_AT;
  const endedAtMs = options.endedAtMs ?? atMs + 1_000;
  const result: RunResult = options.result ?? { status: "ok" };
  const completionStatus = result.status === "ok" ? "succeeded" : "failed";
  const job = harness.cron.getJob(harness.job.id)!;
  const context = captureOpenClawStateWorkerContext();
  const storeKey = cronStoreKey(harness.storePath);
  const request = {
    jobId: job.id,
    receiptId: `released:${job.id}:${readTasks(harness).length}`,
    mode: "force" as const,
    configRevision: resolveCronJobConfigRevision(job),
  };
  vi.setSystemTime(atMs);
  const requested = await executeOpenClawStateWorker(context, {
    type: "cron.requestRuns",
    input: { storeKey, nowMs: atMs, requests: [request] },
  });
  expect(requested).toMatchObject({ rejected: [], accepted: [expect.anything()] });
  const activated = await executeOpenClawStateWorker(context, {
    type: "cron.drainQueue",
    input: { storeKey, nowMs: atMs, requests: [request], maxConcurrentRuns: 1 },
  });
  expect(activated).toMatchObject({ skipped: [], launches: [expect.anything()] });
  const receipt = activated.launches[0]!.runReceipt;
  const nextRunAtMs = Object.hasOwn(options, "historicalNextRunAtMs")
    ? options.historicalNextRunAtMs
    : job.trigger?.once
      ? undefined
      : result.status === "error"
        ? endedAtMs + 30_000
        : atMs + HOUR;
  vi.setSystemTime(endedAtMs);
  await executeOpenClawStateWorker(context, {
    type: "cron.recordRun",
    input: {
      storeKey,
      jobId: job.id,
      runId: `cron:${job.id}:${atMs}:${receipt.receiptId}`,
      agentId: receipt.agentId,
      startedAt: atMs,
      endedAt: endedAtMs,
      status: completionStatus,
      error: result.error,
      detail: {
        kind: "cron-run",
        storeKey,
        completionStatus,
        status: result.status,
        error: result.error ?? null,
        summary: null,
        runAtMs: atMs,
        durationMs: endedAtMs - atMs,
        deliveryStatus: "not-requested",
        ...(nextRunAtMs === undefined ? {} : { nextRunAtMs }),
        triggerFired: true,
        triggerStateChanged: true,
        triggerState: { observed: "completed evaluation" },
      },
    },
  });
  const history = readHistory(harness);
  const finishedTask = readTasks(harness).find(
    (row) => row.runId === `cron:${job.id}:${atMs}:${receipt.receiptId}`,
  )!;
  const entry = cronRunRecordToRunLogEntry(finishedTask)!;
  expect((await loadCronStore(harness.storePath)).jobs[0]?.state.runningAtMs).toBe(atMs);
  harness.cron.stop();
  return { entry, history, receipt, recordId: finishedTask.id };
}

async function restartAndRecover(
  harness: Harness,
  pending: Awaited<ReturnType<typeof finishWithPendingCronRow>>,
) {
  harness.cron = new CronService(harness.deps);
  harness.cron.pauseScheduling();
  await harness.cron.start();

  expect(readHistory(harness)).toEqual(pending.history);
  expect(harness.evaluateCronTrigger).not.toHaveBeenCalled();
  expect(harness.runIsolatedAgentJob).not.toHaveBeenCalled();
  expect(
    inspectActiveCronRunReceipt({ storePath: harness.storePath, jobId: harness.job.id }),
  ).toBeUndefined();
  expect(
    openOpenClawStateDatabase()
      .db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
      .get(pending.receipt.receiptId),
  ).toMatchObject({ status: pending.entry.status });
  const recovered = (await loadCronStore(harness.storePath)).jobs[0];
  if (!recovered) {
    throw new Error("Expected the recurring job to remain stored.");
  }
  expect(recovered.state.runningAtMs).toBeUndefined();
  expect(recovered.state.lastRunAtMs).toBe(pending.receipt.startedAtMs);
  expect(recovered.state.lastRunStatus).toBe(pending.entry.status);
  return recovered;
}

type EditCase = [
  label: string,
  edits: Array<[atMs: number, patch: CronJobPatch]>,
  acknowledgedNextRunAtMs: number | undefined,
  options?: Partial<CronJobCreate> & { endedAtMs?: number; historicalNextRunAtMs?: number },
];
const cronSchedule = (expr: string) => ({ kind: "cron", expr, tz: "UTC", staggerMs: 0 }) as const;

describe("CronService schedule ownership during finalized-run recovery", () => {
  it.each<EditCase>([
    [
      "an edit in the admission millisecond",
      [[RUN_AT, { schedule: { ...MINUTELY, anchorMs: RUN_AT } }]],
      RUN_AT + MINUTE,
      { endedAtMs: RUN_AT },
    ],
    [
      "an hourly-to-minute cron edit with a valid historical cron slot",
      [[EDIT_AT, { schedule: cronSchedule("* * * * *") }]],
      RUN_AT + MINUTE,
      { schedule: cronSchedule("0 * * * *") },
    ],
    [
      "a timed-to-stream edit with no timer deadline",
      [[EDIT_AT, { schedule: { kind: "stream", command: ["echo"] } }]],
      undefined,
    ],
    [
      "a stream-once-to-timed edit that must stay enabled",
      [[EDIT_AT, { schedule: MINUTELY }]],
      EDIT_AT + MINUTE,
      {
        schedule: { kind: "stream", command: ["echo"] },
        trigger: { script: "json({ fire: true })", once: true },
      },
    ],
    [
      "A-to-B-to-A edits restoring an earlier slot after clock rollback",
      [
        [RUN_AT - 2_000, { schedule: { ...MINUTELY, anchorMs: RUN_AT - 2_000 } }],
        [RUN_AT - 1_000, { schedule: HOURLY }],
      ],
      RUN_AT,
    ],
    [
      "a pacing edit after the old payload selected a dynamic deadline",
      [[EDIT_AT, { pacing: { min: "15m", max: "2h" } }]],
      RUN_AT + HOUR,
      { pacing: { min: "15m", max: "4h" }, historicalNextRunAtMs: RUN_AT + 1_000 + 30 * MINUTE },
    ],
  ])("preserves %s", async (_label, edits, expectedNext, options = {}) => {
    const { endedAtMs, historicalNextRunAtMs = RUN_AT + HOUR, ...input } = options;
    using harness = await createHarness(input);
    const historicalNext = options.trigger?.once ? undefined : historicalNextRunAtMs;
    const pending = await finishWithPendingCronRow(harness, {
      endedAtMs,
      historicalNextRunAtMs: historicalNext,
    });
    expect(pending.entry.nextRunAtMs).toBe(historicalNext);
    let acknowledged: CronJob = harness.job;
    for (const [atMs, patch] of edits) {
      vi.setSystemTime(atMs);
      acknowledged = await harness.cron.update(harness.job.id, patch);
    }
    expect(acknowledged.enabled).toBe(true);
    expect(acknowledged.state.nextRunAtMs).toBe(expectedNext);
    expect(acknowledged.state.nextRunAtMs).not.toBe(pending.entry.nextRunAtMs);
    expect(readHistory(harness)).toEqual(pending.history);

    const recovered = await restartAndRecover(harness, pending);
    expect(recovered.enabled).toBe(true);
    expect(recovered.schedule).toEqual(acknowledged.schedule);
    expect(recovered.pacing).toEqual(acknowledged.pacing);
    expect(recovered.state.nextRunAtMs).toBe(acknowledged.state.nextRunAtMs);
    expect(recovered.state.pacedNextRunAtMs).toBe(acknowledged.state.pacedNextRunAtMs);
    expect(recovered.state.forcePreservedNextRunAtMs).toBe(
      acknowledged.state.forcePreservedNextRunAtMs,
    );
    expect(recovered.state.lastError).toBeUndefined();
  });

  it.each([
    { edit: "name only", error: false },
    { edit: "idempotent schedule", error: true },
    { edit: "failed schedule write", error: true },
  ] as const)("recovers the historical deadline after $edit", async ({ edit, error }) => {
    using harness = await createHarness();
    const pending = await finishWithPendingCronRow(harness, {
      result: error ? { status: "error", error: "temporary timeout" } : { status: "ok" },
    });
    expect(pending.entry.nextRunAtMs).toBe(RUN_AT + (error ? 31_000 : HOUR));
    vi.setSystemTime(EDIT_AT);
    if (edit === "name only") {
      await harness.cron.update(harness.job.id, { name: "renamed condition" });
    } else if (edit === "idempotent schedule") {
      await harness.cron.update(harness.job.id, {
        schedule: { kind: "every", everyMs: HOUR },
        enabled: true,
      });
    } else if (edit === "failed schedule write") {
      const allowWrites = rejectCronRowWrite(harness.job.id);
      try {
        await expect(harness.cron.update(harness.job.id, { schedule: MINUTELY })).rejects.toThrow(
          "cadence row unavailable",
        );
      } finally {
        allowWrites();
      }
    }

    const recovered = await restartAndRecover(harness, pending);
    expect(recovered.enabled).toBe(true);
    expect(recovered.schedule).toEqual(HOURLY);
    expect(recovered.state.nextRunAtMs).toBe(pending.entry.nextRunAtMs);
    expect(recovered.state.consecutiveErrors).toBe(error ? 1 : 0);
    expect(recovered.name).toBe(edit === "name only" ? "renamed condition" : harness.job.name);
  });

  it("lets an unchanged successor finish once in the same admission millisecond", async () => {
    const atMs = RUN_AT;
    using harness = await createHarness({
      trigger: { script: "json({ fire: true })", once: true },
    });
    const first = await finishWithPendingCronRow(harness);
    expect(first.entry.nextRunAtMs).toBeUndefined();
    vi.setSystemTime(EDIT_AT);
    const acknowledged = await harness.cron.update(harness.job.id, { schedule: MINUTELY });
    const replacement = await restartAndRecover(harness, first);
    expect(replacement.enabled).toBe(true);
    expect(replacement.state.nextRunAtMs).toBe(acknowledged.state.nextRunAtMs);

    const second = await finishWithPendingCronRow(harness, {
      atMs,
      endedAtMs: atMs,
    });
    expect(second.receipt.receiptId).not.toBe(first.receipt.receiptId);
    expect(second.recordId).not.toBe(first.recordId);
    expect(second.entry.nextRunAtMs).toBeUndefined();
    expect(second.history).toHaveLength(2);
    const completed = await restartAndRecover(harness, second);
    expect(completed.enabled).toBe(false);
    expect(completed.state.nextRunAtMs).toBeUndefined();
    expect(completed.state.triggerEvalCount).toBe(2);
  });
});
