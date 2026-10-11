import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import type { CronEvent } from "./service.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import { waitForActiveCronTaskRuns } from "./service/active-run-cancellation.js";
import {
  observeCronRecoveryForTest,
  recoverCronRunForTest,
} from "./service/run-recovery.test-support.js";
import { createCronServiceState, type CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-trigger-eval-" });

type Evaluator = NonNullable<CronServiceDeps["evaluateCronTrigger"]>;
type CronEventContext = Parameters<NonNullable<CronServiceDeps["onEvent"]>>[1];
type IsolatedRunner = CronServiceDeps["runIsolatedAgentJob"];
type ScriptRunner = NonNullable<CronServiceDeps["runScriptJob"]>;

function watcher(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "watcher",
    enabled: true,
    schedule: { kind: "cron", expr: "* * * * * *", staggerMs: 0 },
    trigger: { script: "json({ fire: false })" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "base message" },
    ...overrides,
  };
}

async function createHarness(params: {
  evaluateCronTrigger?: Evaluator;
  runIsolatedAgentJob?: IsolatedRunner;
  runScriptJob?: ScriptRunner;
  sendCronWebhook?: CronServiceDeps["sendCronWebhook"];
}) {
  const { storePath } = await makeStorePath();
  const events: CronEvent[] = [];
  const eventContexts: Array<CronEventContext | undefined> = [];
  const enqueueSystemEvent = vi.fn();
  const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
  const runIsolatedAgentJob =
    params.runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const }));
  const deps: CronServiceDeps = {
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    cronConfig: { triggers: { enabled: true } },
    log: logger,
    enqueueSystemEvent,
    runSessionEvent,
    enqueueSessionEvent: vi.fn(),
    runIsolatedAgentJob,
    ...(params.evaluateCronTrigger ? { evaluateCronTrigger: params.evaluateCronTrigger } : {}),
    ...(params.runScriptJob ? { runScriptJob: params.runScriptJob } : {}),
    ...(params.sendCronWebhook ? { sendCronWebhook: params.sendCronWebhook } : {}),
    onEvent: (event, context) => {
      events.push(structuredClone(event));
      eventContexts.push(context ? structuredClone(context) : undefined);
    },
  };
  const cron = new CronService(deps);
  await cron.start();
  return {
    cron,
    deps,
    enqueueSystemEvent,
    runSessionEvent,
    eventContexts,
    events,
    runIsolatedAgentJob,
    storePath,
  };
}

async function runWhenDue(cron: CronService, jobId: string) {
  const nextRunAtMs = cron.getJob(jobId)?.state.nextRunAtMs;
  if (nextRunAtMs === undefined) {
    throw new Error("test job has no next run");
  }
  vi.setSystemTime(nextRunAtMs);
  return cron.run(jobId, "due");
}

function rejectCronRowWrite(jobId: string) {
  const database = openOpenClawStateDatabase().db;
  database.exec(`
    CREATE TRIGGER reject_watcher_row
    BEFORE UPDATE ON cron_jobs
    WHEN NEW.job_id = '${jobId.replaceAll("'", "''")}'
    BEGIN
      SELECT RAISE(ABORT, 'watcher row unavailable');
    END;
  `);
  return () => database.exec("DROP TRIGGER IF EXISTS reject_watcher_row");
}

async function finishWatcherRun(params: {
  harness: Awaited<ReturnType<typeof createHarness>>;
  jobId: string;
  run: ReturnType<typeof runWhenDue>;
  complete: () => void;
  recover: boolean;
  editAfterTask?: () => Promise<void>;
  prepareRecoveryBeforeEdit?: boolean;
  expectedReceiptStatus?: "ok" | "interrupted";
}) {
  const { harness, jobId } = params;
  if (!params.recover) {
    params.complete();
    expect(await params.run).toEqual({ ok: true, ran: true });
    return;
  }
  const receipt = inspectActiveCronRunReceipt({ storePath: harness.storePath, jobId });
  if (!receipt) {
    throw new Error("expected an active watcher receipt");
  }
  const allowWrites = rejectCronRowWrite(jobId);
  try {
    params.complete();
    await expect(params.run).rejects.toThrow("watcher row unavailable");
  } finally {
    allowWrites();
  }

  const readHistory = () =>
    readCronRunHistoryPageForTests({ storeKey: cronStoreKey(harness.storePath), jobId }).entries;
  const history = readHistory();
  // The payload has durably succeeded, but its separate scheduler write failed.
  expect(history).toEqual([
    expect.objectContaining({ jobId, status: "ok", completionStatus: "succeeded" }),
  ]);
  expect(inspectActiveCronRunReceipt({ storePath: harness.storePath, jobId })?.receiptId).toBe(
    receipt.receiptId,
  );
  expect(
    (await loadCronStore(harness.storePath)).jobs.find((job) => job.id === jobId)?.state
      .runningAtMs,
  ).toBe(receipt.startedAtMs);

  harness.cron.stop();
  const recoveryState = params.prepareRecoveryBeforeEdit
    ? createCronServiceState(harness.deps)
    : undefined;
  const proposal = recoveryState
    ? await observeCronRecoveryForTest(recoveryState, jobId, undefined, receipt.startedAtMs)
    : undefined;
  await params.editAfterTask?.();
  if (params.expectedReceiptStatus === "interrupted") {
    expect(
      openOpenClawStateDatabase()
        .db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId),
    ).toMatchObject({ status: "interrupted" });
  }
  if (recoveryState && proposal) {
    expect(proposal.receipt?.receiptId).toBe(receipt.receiptId);
    expect(await recoverCronRunForTest(recoveryState, proposal, "startup")).toMatchObject({
      kind: "repaired",
    });
  }
  harness.cron = new CronService(harness.deps);
  await harness.cron.start();

  expect(readHistory()).toEqual(history);
  expect(inspectActiveCronRunReceipt({ storePath: harness.storePath, jobId })).toBeUndefined();
  expect(
    openOpenClawStateDatabase()
      .db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
      .get(receipt.receiptId),
  ).toMatchObject({ status: params.expectedReceiptStatus ?? "ok" });
  expect(harness.cron.getJob(jobId)?.state.runningAtMs).toBeUndefined();
}

type PendingWatcher = Pick<
  Parameters<typeof finishWatcherRun>[0],
  "harness" | "jobId" | "run" | "complete"
>;

async function withPendingWatcher(
  overrides: Partial<CronJobCreate>,
  exercise: (pending: PendingWatcher) => Promise<void>,
) {
  const started = createDeferred();
  const completion = createDeferred();
  const evaluateCronTrigger = vi.fn(async () => ({
    kind: "evaluated" as const,
    fire: true,
    state: { owner: "completed evaluation" },
  }));
  const runIsolatedAgentJob = vi.fn(async () => {
    started.resolve();
    await completion.promise;
    return { status: "ok" as const, summary: "done" };
  });
  const runScriptJob = vi.fn(async () => {
    started.resolve();
    await completion.promise;
    return { status: "ok" as const, stateChanged: true, state: { owner: "obsolete payload" } };
  });
  const harness = await createHarness(
    overrides.payload?.kind === "script"
      ? { runScriptJob }
      : { evaluateCronTrigger, runIsolatedAgentJob },
  );
  let run: ReturnType<typeof runWhenDue> | undefined;
  try {
    const job = await harness.cron.add(
      watcher({
        trigger: { script: "fire", once: true },
        delivery: { mode: "none" },
        state: { triggerState: { owner: "original" } },
        ...overrides,
      }),
    );
    run = runWhenDue(harness.cron, job.id);
    await started.promise;
    await exercise({ harness, jobId: job.id, run, complete: () => completion.resolve() });
    if (overrides.payload?.kind === "script") {
      expect(runScriptJob).toHaveBeenCalledOnce();
    } else {
      expect(evaluateCronTrigger).toHaveBeenCalledOnce();
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
    }
  } finally {
    completion.resolve();
    await run?.catch(() => undefined);
    harness.cron.stop();
  }
}

describe("cron trigger evaluation", () => {
  it("releases a busy main condition without updating trigger state or running its payload", async () => {
    const harness = await createHarness({ evaluateCronTrigger: async () => ({ kind: "busy" }) });
    try {
      const job = await harness.cron.add(
        watcher({
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "must not enqueue" },
        }),
      );
      await runWhenDue(harness.cron, job.id);
      expect(harness.runSessionEvent).not.toHaveBeenCalled();
      expect(harness.enqueueSystemEvent).not.toHaveBeenCalled();
      await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({ drained: true, active: 0 });
      const state = harness.cron.getJob(job.id)?.state;
      expect(state?.triggerEvalCount).toBeUndefined();
      expect(state?.lastTriggerEvalAtMs).toBeUndefined();
      expect(state?.triggerState).toBeUndefined();
      expect(harness.events.filter((event) => event.action === "finished")).toEqual([]);
    } finally {
      harness.cron.stop();
    }
  });

  it.each([
    { sessionTarget: "main", mutation: "remove" },
    { sessionTarget: "isolated", mutation: "disable" },
  ] as const)(
    "cancels a pending $sessionTarget condition on $mutation before it can fire",
    async ({ sessionTarget, mutation }) => {
      const started = createDeferred<AbortSignal>();
      const evaluation = createDeferred<Awaited<ReturnType<Evaluator>>>();
      const harness = await createHarness({
        evaluateCronTrigger: async ({ abortSignal }) => {
          if (!abortSignal) {
            throw new Error("expected condition cancellation signal");
          }
          started.resolve(abortSignal);
          return evaluation.promise;
        },
      });
      const job = await harness.cron.add(
        watcher({
          sessionTarget,
          payload:
            sessionTarget === "main"
              ? { kind: "systemEvent", text: "condition payload" }
              : { kind: "agentTurn", message: "condition payload" },
          state: { triggerState: { owner: "previous evaluation" } },
        }),
      );
      const run = runWhenDue(harness.cron, job.id);
      try {
        const signal = await started.promise;
        if (mutation === "remove") {
          await harness.cron.remove(job.id);
        } else {
          await harness.cron.update(job.id, { enabled: false });
        }
        evaluation.resolve({ kind: "evaluated", fire: true, state: { owner: "late result" } });
        await run;
        expect(signal.aborted).toBe(true);
        expect(harness.runSessionEvent).not.toHaveBeenCalled();
        expect(harness.enqueueSystemEvent).not.toHaveBeenCalled();
        expect(harness.runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(harness.events.filter((event) => event.action === "finished")).toEqual([
          expect.objectContaining({
            status: "error",
            error:
              mutation === "remove"
                ? "Cron job removed by operator."
                : "Cron job disabled by operator.",
          }),
        ]);
        if (mutation === "disable") {
          expect(harness.cron.getJob(job.id)).toMatchObject({
            enabled: false,
            state: { triggerState: { owner: "previous evaluation" } },
          });
        }
      } finally {
        evaluation.resolve({ kind: "evaluated", fire: false });
        await run;
        harness.cron.stop();
      }
    },
  );

  it("persists quiet evaluations and fires replacement triggers with fresh state", async () => {
    const replacementScript = 'return "replacement"';
    const evaluateCronTrigger = vi.fn(async (params: Parameters<Evaluator>[0]) => ({
      kind: "evaluated" as const,
      fire: params.script === replacementScript && params.state === undefined,
      state: { status: "green" },
    }));
    const harness = await createHarness({ evaluateCronTrigger });
    try {
      const job = await harness.cron.add(watcher());
      const dueAt = job.state.nextRunAtMs!;
      harness.events.length = 0;
      expect(await runWhenDue(harness.cron, job.id)).toEqual({ ok: true, ran: true });
      const stored = harness.cron.getJob(job.id);
      const persisted = (await loadCronStore(harness.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(stored?.state).toMatchObject({
        lastTriggerEvalAtMs: dueAt,
        triggerEvalCount: 1,
        triggerState: { status: "green" },
        consecutiveErrors: 0,
        scheduleErrorCount: 0,
      });
      expect(stored?.state.lastRunAtMs).toBeUndefined();
      expect(stored!.state.nextRunAtMs! - dueAt).toBeGreaterThanOrEqual(30_000);
      expect(harness.runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(harness.events.map((event) => event.action)).toEqual(["started", "scheduled"]);
      expect(harness.events.at(-1)).toMatchObject({
        jobId: job.id,
        action: "scheduled",
        nextRunAtMs: persisted?.state.nextRunAtMs,
        job: { state: { nextRunAtMs: persisted?.state.nextRunAtMs } },
      });
      expect(
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(harness.storePath), jobId: job.id })
          .entries,
      ).toEqual([]);
      await harness.cron.update(job.id, { trigger: { script: replacementScript } });
      expect(await runWhenDue(harness.cron, job.id)).toEqual({ ok: true, ran: true });
      expect(evaluateCronTrigger).toHaveBeenLastCalledWith(
        expect.objectContaining({ script: replacementScript, state: undefined }),
      );
      expect(harness.runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(harness.cron.getJob(job.id)?.state.triggerEvalCount).toBe(1);
    } finally {
      harness.cron.stop();
    }
  });

  it("appends the fired trigger message to the main payload and history", async () => {
    const harness = await createHarness({
      evaluateCronTrigger: async () => ({
        kind: "evaluated",
        fire: true,
        message: "CI became red",
        state: { status: "red" },
      }),
    });
    try {
      const job = await harness.cron.add(
        watcher({
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "base message" },
        }),
      );
      await runWhenDue(harness.cron, job.id);
      expect(harness.runSessionEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          text: "base message\n\nCI became red",
          job: expect.objectContaining({ id: job.id }),
        }),
      );
      expect(harness.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(harness.events.find((event) => event.action === "finished")).toMatchObject({
        status: "ok",
        triggerFired: true,
      });
      expect(
        readCronRunHistoryPageForTests({
          storeKey: cronStoreKey(harness.storePath),
          jobId: job.id,
        }).entries,
      ).toEqual([expect.objectContaining({ triggerFired: true })]);
      expect(harness.cron.getJob(job.id)?.state).toMatchObject({
        triggerEvalCount: 1,
        lastTriggerFireAtMs: expect.any(Number),
        triggerState: { status: "red" },
      });
    } finally {
      harness.cron.stop();
    }
  });

  it("backs off evaluator errors without reporting webhook delivery or publishing private failure details", async () => {
    const sendCronWebhook = vi.fn();
    const harness = await createHarness({
      evaluateCronTrigger: async () => ({
        kind: "error",
        code: "timeout",
        error: "deadline exceeded",
      }),
      sendCronWebhook,
    });
    try {
      const job = await harness.cron.add(
        watcher({ delivery: { mode: "webhook", to: "https://example.invalid/hook" } }),
      );
      const dueAt = job.state.nextRunAtMs!;
      harness.events.length = 0;
      harness.eventContexts.length = 0;
      await runWhenDue(harness.cron, job.id);
      const state = harness.cron.getJob(job.id)?.state;
      expect(state).toMatchObject({
        consecutiveErrors: 1,
        triggerEvalCount: 1,
        lastRunStatus: "error",
        lastDeliveryStatus: "not-requested",
      });
      expect(state?.nextRunAtMs).toBeGreaterThan(dueAt);
      expect(state?.lastDelivered).toBeUndefined();
      expect(state?.lastDeliveryError).toBeUndefined();
      expect(sendCronWebhook).not.toHaveBeenCalled();
      expect(harness.eventContexts[1]).toEqual({
        failureNotificationDetail: { kind: "script-failure", source: "trigger", code: "timeout" },
      });
      expect(harness.events[1]).not.toHaveProperty("failureNotificationDetail");
      expect(harness.events.map((event) => event.action)).toEqual([
        "started",
        "finished",
        "scheduled",
      ]);
      const history = readCronRunHistoryPageForTests({
        storeKey: cronStoreKey(harness.storePath),
        jobId: job.id,
      }).entries;
      expect(history).toHaveLength(1);
      for (const result of [harness.events[1], history[0]]) {
        expect(result).toMatchObject({
          status: "error",
          error: expect.stringContaining("deadline exceeded"),
          deliveryStatus: "not-requested",
        });
        expect(result?.delivered).toBeUndefined();
        expect(result?.deliveryError).toBeUndefined();
      }
      const persisted = (await loadCronStore(harness.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(harness.events.at(-1)).toMatchObject({
        jobId: job.id,
        action: "scheduled",
        nextRunAtMs: persisted?.state.nextRunAtMs,
        job: { state: { nextRunAtMs: persisted?.state.nextRunAtMs } },
      });
    } finally {
      harness.cron.stop();
    }
  });

  it("recovers the once lifecycle after a failed state edit", async () => {
    await withPendingWatcher({}, async (pending) => {
      const { harness, jobId } = pending;
      const allowWrites = rejectCronRowWrite(jobId);
      try {
        await expect(
          harness.cron.update(jobId, { state: { triggerState: { owner: "uncommitted edit" } } }),
        ).rejects.toThrow("watcher row unavailable");
      } finally {
        allowWrites();
      }
      expect(
        (await loadCronStore(harness.storePath)).jobs.find((entry) => entry.id === jobId)?.state
          .triggerState,
      ).toEqual({ owner: "original" });
      await finishWatcherRun({ ...pending, recover: true });
      expect(harness.cron.getJob(jobId)).toMatchObject({
        enabled: false,
        state: { triggerState: { owner: "completed evaluation" }, triggerEvalCount: 1 },
      });
      expect(harness.cron.getJob(jobId)?.state.nextRunAtMs).toBeUndefined();
    });
  });

  it("preserves a terminal replacement after recovery preparation", async () => {
    await withPendingWatcher({ agentId: "alpha" }, async (pending) => {
      const { harness, jobId } = pending;
      await finishWatcherRun({
        ...pending,
        recover: true,
        prepareRecoveryBeforeEdit: true,
        expectedReceiptStatus: "interrupted",
        editAfterTask: async () => {
          expect(
            readCronRunHistoryPageForTests({ storeKey: cronStoreKey(harness.storePath), jobId })
              .entries[0]?.nextRunAtMs,
          ).toBeUndefined();
          const updated = await harness.cron.update(jobId, {
            agentId: "beta",
            trigger: { script: "replacement", once: true },
            state: { triggerState: { owner: "later edit" } },
          });
          expect(updated.enabled).toBe(true);
          expect(updated.state.nextRunAtMs).toEqual(expect.any(Number));
        },
      });
      const stored = harness.cron.getJob(jobId);
      expect(stored).toMatchObject({
        enabled: true,
        agentId: "beta",
        trigger: { script: "replacement", once: true },
        state: { triggerState: { owner: "later edit" }, nextRunAtMs: expect.any(Number) },
      });
      expect(stored?.state.lastTriggerEvalAtMs).toBeUndefined();
      expect(stored?.state.lastTriggerFireAtMs).toBeUndefined();
      expect(stored?.state.triggerEvalCount).toBeUndefined();
    });
  });

  it.each(["trigger", "state", "script"] as const)(
    "preserves a replaced-then-restored %s against obsolete completion",
    async (field) => {
      const originalTrigger = { script: "return original", once: true };
      const originalPayload = { kind: "script" as const, script: "return original" };
      const originalState = { owner: "original" };
      await withPendingWatcher(
        {
          trigger: field === "script" ? undefined : originalTrigger,
          ...(field === "script" ? { payload: originalPayload } : {}),
        },
        async (pending) => {
          const { harness, jobId } = pending;
          if (field === "trigger") {
            await harness.cron.update(jobId, {
              trigger: { script: "return replacement", once: true },
              state: { triggerState: { owner: "latest edit" } },
            });
            await harness.cron.update(jobId, { trigger: originalTrigger });
          } else if (field === "state") {
            await harness.cron.update(jobId, { state: { triggerState: { owner: "latest edit" } } });
            await harness.cron.update(jobId, { state: { triggerState: originalState } });
          } else {
            await harness.cron.update(jobId, {
              payload: { kind: "script", script: "return replacement" },
            });
            await harness.cron.update(jobId, { payload: originalPayload });
          }
          await finishWatcherRun({ ...pending, recover: field !== "state" });
          const stored = harness.cron.getJob(jobId);
          expect(stored?.enabled).toBe(true);
          expect(stored?.state.nextRunAtMs).toEqual(expect.any(Number));
          expect(stored?.state.triggerState).toEqual(field === "state" ? originalState : undefined);
          if (field === "script") {
            expect(stored?.payload).toMatchObject(originalPayload);
            expect(
              (await loadCronStore(harness.storePath)).jobs.find((entry) => entry.id === jobId)
                ?.state.triggerState,
            ).toBeUndefined();
          } else {
            expect(stored?.trigger).toEqual(originalTrigger);
            expect(stored?.state.lastTriggerEvalAtMs).toBeUndefined();
            expect(stored?.state.lastTriggerFireAtMs).toBeUndefined();
            expect(stored?.state.triggerEvalCount).toBeUndefined();
          }
        },
      );
    },
  );

  it("preserves a replacement committed during a suspended quiet evaluation", async () => {
    const started = createDeferred();
    const evaluation = createDeferred<Awaited<ReturnType<Evaluator>>>();
    const harness = await createHarness({
      evaluateCronTrigger: async () => {
        started.resolve();
        return evaluation.promise;
      },
    });
    let run: ReturnType<typeof runWhenDue> | undefined;
    try {
      const job = await harness.cron.add(watcher({ trigger: { script: 'return "old"' } }));
      run = runWhenDue(harness.cron, job.id);
      await started.promise;
      await harness.cron.update(job.id, {
        trigger: { script: 'return "replacement"' },
        state: { triggerState: { owner: "latest edit" } },
      });
      evaluation.resolve({ kind: "evaluated", fire: false, state: { owner: "obsolete" } });
      expect(await run).toEqual({ ok: true, ran: true });
      const stored = harness.cron.getJob(job.id);
      expect(stored?.trigger).toEqual({ script: 'return "replacement"' });
      expect(stored?.state.triggerState).toEqual({ owner: "latest edit" });
      expect(stored?.state.lastTriggerEvalAtMs).toBeUndefined();
      expect(stored?.state.nextRunAtMs).toEqual(expect.any(Number));
    } finally {
      evaluation.resolve({ kind: "evaluated", fire: false });
      await run;
      harness.cron.stop();
    }
  });

  it("reports a missing evaluator as an execution error", async () => {
    const harness = await createHarness({});
    try {
      const job = await harness.cron.add(watcher());
      await runWhenDue(harness.cron, job.id);
      expect(harness.cron.getJob(job.id)?.state).toMatchObject({
        consecutiveErrors: 1,
        lastRunStatus: "error",
        lastError: "cron trigger evaluator is unavailable",
      });
    } finally {
      harness.cron.stop();
    }
  });
});

describe("cron webhook optional output", () => {
  it.each([
    { status: "ok", summary: " \n " },
    { status: "error", summary: undefined },
  ] as const)(
    "records $status with empty output without false delivery",
    async ({ status, summary }) => {
      const sendCronWebhook = vi.fn(async () => ({ status: "delivered" as const }));
      const harness = await createHarness({
        runIsolatedAgentJob: async () => ({
          status,
          summary,
          ...(status === "error" ? { error: "execution failed" } : {}),
        }),
        sendCronWebhook,
      });
      try {
        const job = await harness.cron.add(
          watcher({
            trigger: undefined,
            schedule: { kind: "at", at: new Date(Date.now()).toISOString() },
            wakeMode: "next-heartbeat",
            delivery: { mode: "webhook", to: "https://example.invalid/hook" },
          }),
        );
        await harness.cron.run(job.id, "force");
        const failed = status === "error";
        expect(sendCronWebhook).toHaveBeenCalledTimes(failed ? 1 : 0);
        expect(harness.events.find((event) => event.action === "finished")).toMatchObject({
          status,
          completionStatus: failed ? "failed" : "succeeded",
          deliveryStatus: failed ? "delivered" : "not-delivered",
          deliverySuppressionReason: failed ? undefined : "empty",
          deliveryError: undefined,
        });
        if (!failed) {
          expect(harness.cron.getJob(job.id)).toBeUndefined();
        }
      } finally {
        harness.cron.stop();
      }
    },
  );
});

function createTriggerDeps(
  storePath: string,
  evaluateCronTrigger: CronServiceDeps["evaluateCronTrigger"],
): CronServiceDeps {
  return {
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    runSessionEvent: vi.fn(async () => ({ status: "ok" as const })),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    evaluateCronTrigger,
  };
}

describe("cron trigger cadence", () => {
  it("does not replay a quiet occurrence after an earlier fired payload", async () => {
    const { storePath } = await makeStorePath();
    let firstEvaluation = true;
    const evaluateCronTrigger = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 123);
      const fire = firstEvaluation;
      firstEvaluation = false;
      return { kind: "evaluated" as const, fire };
    });
    const deps = createTriggerDeps(storePath, evaluateCronTrigger);
    let cron = new CronService(deps);
    await cron.start();
    try {
      const job = await cron.add({
        name: "quiet occurrence",
        enabled: true,
        schedule: { kind: "cron", expr: "0 * * * * *", tz: "UTC", staggerMs: 0 },
        trigger: { script: "json({ fire: false })" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "quiet occurrence" },
      });
      for (let occurrence = 0; occurrence < 2; occurrence += 1) {
        vi.setSystemTime(cron.getJob(job.id)!.state.nextRunAtMs!);
        expect(await cron.run(job.id, "due")).toEqual({ ok: true, ran: true });
      }
      const nextAt = cron.getJob(job.id)!.state.nextRunAtMs;
      cron.stop();
      vi.setSystemTime(Date.now() + 5_000);
      cron = new CronService(deps);
      await cron.start();

      expect(evaluateCronTrigger).toHaveBeenCalledTimes(2);
      expect(deps.runSessionEvent).toHaveBeenCalledOnce();
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(cron.getJob(job.id)?.state.nextRunAtMs).toBe(nextAt);
    } finally {
      cron.stop();
    }
  });

  it.each([
    { name: "quiet immediate-wake", wakeMode: "now", result: { kind: "evaluated", fire: false } },
    { name: "fired", wakeMode: "next-heartbeat", result: { kind: "evaluated", fire: true } },
    { name: "busy", wakeMode: "next-heartbeat", result: { kind: "busy" } },
  ] as const)(
    "preserves the $name interval through maintenance and restart",
    async ({ result, wakeMode }) => {
      const { storePath } = await makeStorePath();
      const evaluateCronTrigger = vi.fn(async () => {
        vi.setSystemTime(Date.now() + 123);
        return result;
      });
      const deps = createTriggerDeps(storePath, evaluateCronTrigger);
      let cron = new CronService(deps);
      await cron.start();
      try {
        const job = await cron.add({
          name: "cadence probe",
          enabled: true,
          schedule: { kind: "cron", expr: "* * * * * *", tz: "UTC", staggerMs: 0 },
          trigger: { script: "json({ fire: false })" },
          sessionTarget: "main",
          wakeMode,
          payload: { kind: "systemEvent", text: "cadence probe" },
        });
        vi.setSystemTime(job.state.nextRunAtMs!);
        expect(await cron.run(job.id, "due")).toEqual({ ok: true, ran: true });
        const nextAt = Date.now() + 30_000;
        expect(cron.getJob(job.id)?.state.nextRunAtMs).toBe(nextAt);

        cron.stop();
        const offline = new CronService({ ...deps, cronEnabled: false });
        expect((await offline.readJob(job.id))?.state.nextRunAtMs).toBe(nextAt);
        expect((await offline.list())[0]?.state.nextRunAtMs).toBe(nextAt);
        vi.setSystemTime(Date.now() + 10_000);
        cron = new CronService(deps);
        await cron.start();
        expect(evaluateCronTrigger).toHaveBeenCalledTimes(1);
        expect(cron.getJob(job.id)?.state.nextRunAtMs).toBe(nextAt);

        vi.setSystemTime(nextAt - 1);
        expect(await cron.run(job.id, "due")).toEqual({ ok: true, ran: false, reason: "not-due" });
        vi.setSystemTime(nextAt);
        expect(await cron.run(job.id, "due")).toEqual({ ok: true, ran: true });
        expect(evaluateCronTrigger).toHaveBeenCalledTimes(2);
      } finally {
        cron.stop();
      }
    },
  );

  it("defers an expired quiet immediate-wake occurrence without reevaluating it at startup", async () => {
    const { storePath } = await makeStorePath();
    const evaluateCronTrigger = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 123);
      return { kind: "evaluated" as const, fire: false, state: { count: 1 } };
    });
    const deps = createTriggerDeps(storePath, evaluateCronTrigger);
    let cron = new CronService(deps);
    await cron.start();
    try {
      const job = await cron.add({
        name: "expired quiet occurrence",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * * *", tz: "UTC", staggerMs: 0 },
        trigger: { script: "json({ fire: false })" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "must remain quiet" },
      });
      vi.setSystemTime(job.state.nextRunAtMs!);
      expect(await cron.run(job.id, "due")).toEqual({ ok: true, ran: true });
      const evaluated = structuredClone(cron.getJob(job.id)!.state);
      const nextAt = Date.now() + 30_000;
      expect(evaluated).toMatchObject({
        nextRunAtMs: nextAt,
        triggerEvalCount: 1,
        triggerState: { count: 1 },
      });
      cron.stop();
      const restartAt = nextAt + 9_586;
      vi.setSystemTime(restartAt);
      cron = new CronService(deps);
      await cron.start();

      const expected = {
        nextRunAtMs: restartAt + 120_000,
        startupCatchupAtMs: restartAt + 120_000,
        triggerEvalCount: 1,
        triggerState: evaluated.triggerState,
        lastTriggerEvalAtMs: evaluated.lastTriggerEvalAtMs,
      };
      const persisted = (await loadCronStore(storePath)).jobs.find((row) => row.id === job.id);
      expect(cron.getJob(job.id)?.state).toMatchObject(expected);
      expect(persisted?.state).toMatchObject(expected);
      expect(persisted?.state.lastRunAtMs).toBeUndefined();
      expect(evaluateCronTrigger).toHaveBeenCalledOnce();
      expect(deps.runSessionEvent).not.toHaveBeenCalled();
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      cron.stop();
    }
  });

  it("catches up an old occurrence whose future slot has no recent evaluation", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.now();
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "missed-watcher",
          name: "missed watcher",
          enabled: true,
          createdAtMs: nowMs - 120_000,
          updatedAtMs: nowMs - 60_000,
          schedule: { kind: "cron", expr: "* * * * * *", tz: "UTC", staggerMs: 0 },
          trigger: { script: "json({ fire: false })" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "missed watcher" },
          state: {
            lastRunAtMs: nowMs - 60_000,
            lastRunStatus: "ok",
            nextRunAtMs: nowMs + 20_123,
          },
        },
      ],
    });
    const evaluateCronTrigger = vi.fn(async () => ({ kind: "evaluated" as const, fire: false }));
    const clock = createGatewaySchedulerClock(nowMs);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const deps = {
      ...createTriggerDeps(storePath, evaluateCronTrigger),
      scheduler,
      nowMs: clock.clock.now,
    };
    const cron = new CronService(deps);
    try {
      await cron.start();
      const catchupAt = nowMs + 120_000;
      expect(evaluateCronTrigger).not.toHaveBeenCalled();
      expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
        nextRunAtMs: catchupAt,
        startupCatchupAtMs: catchupAt,
        lastRunAtMs: nowMs - 60_000,
      });
      vi.setSystemTime(catchupAt - 1);
      await clock.advanceTo(catchupAt - 1);
      expect(evaluateCronTrigger).not.toHaveBeenCalled();
      vi.setSystemTime(catchupAt);
      await clock.advanceTo(catchupAt);
      expect(evaluateCronTrigger).toHaveBeenCalledOnce();
      expect(cron.getJob("missed-watcher")?.state).toMatchObject({
        nextRunAtMs: catchupAt + 30_000,
        lastTriggerEvalAtMs: catchupAt,
        triggerEvalCount: 1,
      });
      expect(deps.runSessionEvent).not.toHaveBeenCalled();
    } finally {
      cron.stop();
      await cron.waitForIdle();
      await scheduler.stop();
    }
  });
});
