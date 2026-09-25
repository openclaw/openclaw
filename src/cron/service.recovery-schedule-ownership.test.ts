import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { listTaskRegistryRecordsByRuntimeSourceIdFromSqlite } from "../tasks/task-registry.store.sqlite.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";
import { cronTaskRecordStoreKey, cronTaskRecordToRunLogEntry } from "./task-run-detail.js";
import { readCronTaskRunHistoryPage } from "./task-run-history.js";
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
  const deps: CronServiceDeps = {
    storePath,
    cronEnabled: true,
    cronConfig: { triggers: { enabled: true } },
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    evaluateCronTrigger,
    runIsolatedAgentJob,
  };
  const cron = new CronService(deps);
  cron.pauseScheduling();
  await cron.start();
  const job = await cron.add({
    name: "cadence recovery",
    enabled: true,
    schedule: HOURLY,
    trigger: { script: "json({ fire: true })" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Check the scheduled condition." },
    delivery: { mode: "none" },
    ...input,
  });
  return { cron, deps, evaluateCronTrigger, job, runIsolatedAgentJob, storePath };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

function readHistory(harness: Harness) {
  return readCronTaskRunHistoryPage({
    storeKey: cronStoreKey(harness.storePath),
    jobId: harness.job.id,
  }).entries;
}

function readTasks(harness: Harness) {
  const storeKey = cronStoreKey(harness.storePath);
  return listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
    runtime: "cron",
    sourceId: harness.job.id,
  }).filter((task) => cronTaskRecordStoreKey(task) === storeKey);
}

function rejectCronRowWrite(jobId: string) {
  const database = openOpenClawStateDatabase().db;
  database.exec(`
    CREATE TEMP TRIGGER reject_cadence_row
    BEFORE UPDATE ON cron_jobs
    WHEN NEW.job_id = '${jobId.replaceAll("'", "''")}'
    BEGIN
      SELECT RAISE(ABORT, 'cadence row unavailable');
    END;
  `);
  return () => database.exec("DROP TRIGGER IF EXISTS reject_cadence_row");
}

async function finishWithPendingCronRow(
  harness: Harness,
  options: { atMs?: number; endedAtMs?: number; mode?: "due" | "force"; result?: RunResult } = {},
) {
  const atMs = options.atMs ?? RUN_AT;
  const result: RunResult = options.result ?? { status: "ok", summary: "Completed once." };
  const previousTaskIds = new Set(readTasks(harness).map((task) => task.taskId));
  const started = createDeferred();
  const completion = createDeferred<RunResult>();
  harness.runIsolatedAgentJob.mockImplementationOnce(async () => {
    started.resolve();
    return await completion.promise;
  });
  vi.setSystemTime(atMs);
  const job = harness.cron.getJob(harness.job.id);
  if (!job) {
    throw new Error("Expected the job to remain available for execution.");
  }
  const stream = job.schedule.kind === "stream";
  const run = harness.cron.run(harness.job.id, options.mode ?? (stream ? "force" : "due"), {
    evaluateTrigger: true,
    ...(stream ? { streamBatch: "one synthetic batch", payload: job.payload } : {}),
  });
  await Promise.race([
    started.promise,
    run.then(() => {
      throw new Error("The run settled before entering its payload.");
    }),
  ]);
  const receipt = inspectActiveCronRunReceipt({
    storePath: harness.storePath,
    jobId: harness.job.id,
  });
  if (!receipt) {
    throw new Error("Expected the admitted run's receipt.");
  }
  expect(receipt.startedAtMs).toBe(atMs);
  const admittedTasks = readTasks(harness).filter((task) => !previousTaskIds.has(task.taskId));
  expect(admittedTasks).toHaveLength(1);
  const taskId = admittedTasks[0]?.taskId;
  if (!taskId) {
    throw new Error("Expected the admitted run's task.");
  }

  const allowWrites = rejectCronRowWrite(harness.job.id);
  try {
    vi.setSystemTime(options.endedAtMs ?? atMs + 1_000);
    completion.resolve(result);
    await expect(run).rejects.toThrow("cadence row unavailable");
  } finally {
    allowWrites();
  }

  const history = readHistory(harness);
  const finishedTask = readTasks(harness).find((task) => task.taskId === taskId);
  const entry = finishedTask ? cronTaskRecordToRunLogEntry(finishedTask) : undefined;
  if (!entry) {
    throw new Error("Expected the admitted task to retain its completed history entry.");
  }
  // The real task commit precedes the failed scheduler row, leaving recovery work.
  expect(entry).toMatchObject({
    jobId: harness.job.id,
    runAtMs: atMs,
    status: result.status,
    completionStatus: result.status === "ok" ? "succeeded" : "failed",
  });
  expect(finishedTask?.endedAt).toEqual(expect.any(Number));
  expect(history).toHaveLength(previousTaskIds.size + 1);
  expect(
    inspectActiveCronRunReceipt({ storePath: harness.storePath, jobId: harness.job.id })?.receiptId,
  ).toBe(receipt.receiptId);
  expect((await loadCronStore(harness.storePath)).jobs[0]?.state.runningAtMs).toBe(atMs);
  harness.cron.stop();
  return { entry, history, receipt, taskId, runs: harness.runIsolatedAgentJob.mock.calls.length };
}

async function restartAndRecover(
  harness: Harness,
  pending: Awaited<ReturnType<typeof finishWithPendingCronRow>>,
) {
  harness.cron = new CronService(harness.deps);
  harness.cron.pauseScheduling();
  await harness.cron.start();

  expect(readHistory(harness)).toEqual(pending.history);
  expect(harness.evaluateCronTrigger).toHaveBeenCalledTimes(pending.runs);
  expect(harness.runIsolatedAgentJob).toHaveBeenCalledTimes(pending.runs);
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

type EditCase = {
  label: string;
  input?: Partial<CronJobCreate>;
  result?: RunResult;
  endedAtMs?: number;
  edits: Array<{ atMs: number; patch: CronJobPatch }>;
  historicalNextRunAtMs: number | undefined;
  acknowledgedNextRunAtMs: number | undefined;
};

describe("CronService schedule ownership during finalized-run recovery", () => {
  it.each<EditCase>([
    {
      label: "an hourly-to-minute interval edit",
      edits: [{ atMs: EDIT_AT, patch: { schedule: MINUTELY } }],
      historicalNextRunAtMs: RUN_AT + HOUR,
      acknowledgedNextRunAtMs: EDIT_AT + MINUTE,
    },
    {
      label: "an edit in the admission millisecond",
      endedAtMs: RUN_AT,
      edits: [{ atMs: RUN_AT, patch: { schedule: { ...MINUTELY, anchorMs: RUN_AT } } }],
      historicalNextRunAtMs: RUN_AT + HOUR,
      acknowledgedNextRunAtMs: RUN_AT + MINUTE,
    },
    {
      label: "an edit after clock rollback",
      edits: [
        {
          atMs: RUN_AT - 2_000,
          patch: { schedule: { ...MINUTELY, anchorMs: RUN_AT - 2_000 } },
        },
      ],
      historicalNextRunAtMs: RUN_AT + HOUR,
      acknowledgedNextRunAtMs: RUN_AT - 2_000 + MINUTE,
    },
    {
      label: "an hourly-to-minute cron edit with a valid historical cron slot",
      input: { schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 0 } },
      edits: [
        {
          atMs: EDIT_AT,
          patch: { schedule: { kind: "cron", expr: "* * * * *", tz: "UTC", staggerMs: 0 } },
        },
      ],
      historicalNextRunAtMs: RUN_AT + HOUR,
      acknowledgedNextRunAtMs: RUN_AT + MINUTE,
    },
    {
      label: "a timed-to-stream edit with no timer deadline",
      edits: [{ atMs: EDIT_AT, patch: { schedule: { kind: "stream", command: ["echo"] } } }],
      historicalNextRunAtMs: RUN_AT + HOUR,
      acknowledgedNextRunAtMs: undefined,
    },
    {
      label: "a stream-once-to-timed edit that must stay enabled",
      input: {
        schedule: { kind: "stream", command: ["echo"] },
        trigger: { script: "json({ fire: true })", once: true },
      },
      edits: [{ atMs: EDIT_AT, patch: { schedule: MINUTELY } }],
      historicalNextRunAtMs: undefined,
      acknowledgedNextRunAtMs: EDIT_AT + MINUTE,
    },
    {
      label: "A-to-B-to-A edits restoring an earlier slot after clock rollback",
      edits: [
        {
          atMs: RUN_AT - 2_000,
          patch: { schedule: { ...MINUTELY, anchorMs: RUN_AT - 2_000 } },
        },
        { atMs: RUN_AT - 1_000, patch: { schedule: HOURLY } },
      ],
      historicalNextRunAtMs: RUN_AT + HOUR,
      acknowledgedNextRunAtMs: RUN_AT,
    },
    {
      label: "a pacing edit after the old payload selected a dynamic deadline",
      input: { pacing: { min: "15m", max: "4h" } },
      result: { status: "ok", nextCheck: { delayMs: 30 * MINUTE } },
      edits: [{ atMs: EDIT_AT, patch: { pacing: { min: "15m", max: "2h" } } }],
      historicalNextRunAtMs: RUN_AT + 1_000 + 30 * MINUTE,
      acknowledgedNextRunAtMs: RUN_AT + HOUR,
    },
    {
      label: "a cadence edit after an old transient error selected a retry",
      result: { status: "error", error: "temporary timeout" },
      edits: [{ atMs: EDIT_AT, patch: { schedule: MINUTELY } }],
      historicalNextRunAtMs: RUN_AT + 31_000,
      acknowledgedNextRunAtMs: EDIT_AT + MINUTE,
    },
  ])("preserves $label", async (scenario) => {
    const harness = await createHarness(scenario.input);
    try {
      const pending = await finishWithPendingCronRow(harness, scenario);
      expect(pending.entry.nextRunAtMs).toBe(scenario.historicalNextRunAtMs);
      let acknowledged: CronJob = harness.job;
      for (const edit of scenario.edits) {
        vi.setSystemTime(edit.atMs);
        acknowledged = await harness.cron.update(harness.job.id, edit.patch);
      }
      expect(acknowledged.enabled).toBe(true);
      expect(acknowledged.state.nextRunAtMs).toBe(scenario.acknowledgedNextRunAtMs);
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
      expect(recovered.state.lastError).toBe(scenario.result?.error);
    } finally {
      harness.cron.stop();
    }
  });

  it.each([
    { edit: "unchanged", error: false },
    { edit: "name only", error: false },
    { edit: "idempotent schedule", error: true },
    { edit: "failed schedule write", error: true },
  ] as const)("recovers the historical deadline after $edit", async ({ edit, error }) => {
    const harness = await createHarness();
    try {
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
    } finally {
      harness.cron.stop();
    }
  });

  it.each([
    { clock: "its next due slot", atMs: EDIT_AT + MINUTE, mode: "due" },
    { clock: "the same admission millisecond", atMs: RUN_AT, mode: "force" },
    { clock: "a rolled-back clock", atMs: RUN_AT - 1_000, mode: "force" },
  ] as const)("lets an unchanged successor finish once at $clock", async ({ atMs, mode }) => {
    const harness = await createHarness({
      trigger: { script: "json({ fire: true })", once: true },
    });
    try {
      const first = await finishWithPendingCronRow(harness);
      expect(first.entry.nextRunAtMs).toBeUndefined();
      vi.setSystemTime(EDIT_AT);
      const acknowledged = await harness.cron.update(harness.job.id, { schedule: MINUTELY });
      const replacement = await restartAndRecover(harness, first);
      expect(replacement.enabled).toBe(true);
      expect(replacement.state.nextRunAtMs).toBe(acknowledged.state.nextRunAtMs);

      const second = await finishWithPendingCronRow(harness, { atMs, endedAtMs: atMs, mode });
      expect(second.receipt.receiptId).not.toBe(first.receipt.receiptId);
      expect(second.taskId).not.toBe(first.taskId);
      expect(second.entry.nextRunAtMs).toBeUndefined();
      expect(second.history).toHaveLength(2);
      const completed = await restartAndRecover(harness, second);
      expect(completed.enabled).toBe(false);
      expect(completed.state.nextRunAtMs).toBeUndefined();
      expect(completed.state.triggerEvalCount).toBe(2);
    } finally {
      harness.cron.stop();
    }
  });
});
