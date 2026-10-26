import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import type { CronEvent } from "./service.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import { createCronRunHandle, finishCronRun } from "./service/run-history.js";
import { createCronServiceState, type CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-trigger-eval-" });

type Evaluator = NonNullable<CronServiceDeps["evaluateCronTrigger"]>;
type CronEventContext = Parameters<NonNullable<CronServiceDeps["onEvent"]>>[1];

function evaluated(fire: boolean, extra: { state?: unknown; message?: string } = {}) {
  return { kind: "evaluated" as const, fire, ...extra };
}

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

function mainWatcher(name: string, overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return watcher({
    name,
    schedule: { kind: "cron", expr: "* * * * * *", tz: "UTC", staggerMs: 0 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: name },
    ...overrides,
  });
}

const readHistory = (storePath: string, jobId: string) =>
  readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId }).entries;
const readStoredJob = async (storePath: string, jobId: string) =>
  (await loadCronStore(storePath)).jobs.find((job) => job.id === jobId);
function expectUnevaluated(job: ReturnType<CronService["getJob"]>) {
  expect([
    job?.state.lastTriggerEvalAtMs,
    job?.state.lastTriggerFireAtMs,
    job?.state.triggerEvalCount,
  ]).toEqual([undefined, undefined, undefined]);
}

async function createHarness(
  params: {
    evaluateCronTrigger?: Evaluator;
    runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
    runScriptJob?: CronServiceDeps["runScriptJob"];
    sendCronWebhook?: CronServiceDeps["sendCronWebhook"];
    cronConfig?: CronServiceDeps["cronConfig"];
    storePath?: string;
  } = {},
) {
  const storePath = params.storePath ?? (await makeStorePath()).storePath;
  const events: CronEvent[] = [];
  const eventContexts: Array<CronEventContext | undefined> = [];
  const enqueueSystemEvent = vi.fn();
  const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(async () => ({
    status: "ok",
  }));
  const runIsolatedAgentJob =
    params.runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const }));
  const deps: CronServiceDeps = {
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    log: logger,
    cronConfig: { triggers: { enabled: true } },
    enqueueSystemEvent,
    runSessionEvent,
    runIsolatedAgentJob,
    ...params,
    onEvent: (event, context) => {
      events.push(structuredClone(event));
      eventContexts.push(context ? structuredClone(context) : undefined);
    },
  };
  const beforeStop: Array<() => Promise<unknown>> = [];
  const h = {
    cron: new CronService(deps),
    deps,
    enqueueSystemEvent,
    runSessionEvent,
    eventContexts,
    events,
    runIsolatedAgentJob,
    storePath,
    beforeStop,
    restart: async (at = Date.now()) => {
      h.cron.stop();
      vi.setSystemTime(at);
      h.cron = new CronService(deps);
      await h.cron.start();
    },
  };
  activeHarnesses.add(h);
  await h.cron.start();
  return h;
}

type Harness = Awaited<ReturnType<typeof createHarness>>;
const activeHarnesses = new Set<Harness>();
function installHarnessCleanup() {
  // Child-suite teardown runs before the root harness deletes stores and restores timers.
  afterEach(async () => {
    for (const h of activeHarnesses) {
      try {
        for (const finish of h.beforeStop) {
          await finish();
        }
      } finally {
        h.cron.stop();
        activeHarnesses.delete(h);
      }
    }
  });
}

function expectScheduled(h: Harness, jobId: string, nextRunAtMs: number | undefined) {
  expect(h.events.at(-1)).toMatchObject({
    jobId,
    action: "scheduled",
    nextRunAtMs,
    job: { state: { nextRunAtMs } },
  });
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

async function expectRejectedWrite(jobId: string, write: () => Promise<unknown>) {
  const allowWrites = rejectCronRowWrite(jobId);
  try {
    await expect(write()).rejects.toThrow("watcher row unavailable");
  } finally {
    allowWrites();
  }
}

async function finishWatcherRun(
  params: Awaited<ReturnType<typeof pendingWatcher>> & {
    recover: boolean;
    editAfterTask?: () => Promise<void>;
  },
) {
  const { h, jobId } = params;
  if (!params.recover) {
    params.complete();
    expect(await params.run).toEqual({ ok: true, ran: true });
    return;
  }
  const receipt = inspectActiveCronRunReceipt({ storePath: h.storePath, jobId });
  if (!receipt) {
    throw new Error("expected an active watcher receipt");
  }
  await expectRejectedWrite(jobId, () => {
    params.complete();
    return params.run;
  });

  const job = h.cron.getJob(jobId)!;
  const historyState = createCronServiceState(h.deps);
  // Recover the split history/job commit left by released schedulers.
  await finishCronRun(historyState, {
    taskRunId: createCronRunHandle({
      state: historyState,
      job,
      startedAt: receipt.startedAtMs,
      runReceipt: receipt,
    }).runId,
    job,
    event: {
      jobId,
      action: "finished",
      status: "ok",
      completionStatus: "succeeded",
      summary: "done",
      triggerFired: job.payload.kind !== "script" ? true : undefined,
      runAtMs: receipt.startedAtMs,
      durationMs: 0,
      deliveryStatus: "not-requested",
    },
    ...(job.payload.kind === "script"
      ? { scriptResult: { scriptStateChanged: true, scriptState: { owner: "obsolete payload" } } }
      : {
          triggerEval: {
            fired: true,
            stateChanged: true,
            state: { owner: "completed evaluation" },
          },
        }),
  });

  const history = readHistory(h.storePath, jobId);
  // The legacy result is durable while its job still carries the running marker.
  expect(history).toEqual([
    expect.objectContaining({ jobId, status: "ok", completionStatus: "succeeded" }),
  ]);
  expect(inspectActiveCronRunReceipt({ storePath: h.storePath, jobId })?.receiptId).toBe(
    receipt.receiptId,
  );
  expect((await readStoredJob(h.storePath, jobId))?.state.runningAtMs).toBe(receipt.startedAtMs);

  h.cron.stop();
  await params.editAfterTask?.();
  h.cron = new CronService(h.deps);
  await h.cron.start();

  expect(readHistory(h.storePath, jobId)).toEqual(history);
  expect(inspectActiveCronRunReceipt({ storePath: h.storePath, jobId })).toBeUndefined();
  expect(
    openOpenClawStateDatabase()
      .db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
      .get(receipt.receiptId),
  ).toMatchObject({ status: "ok" });
  expect(h.cron.getJob(jobId)?.state.runningAtMs).toBeUndefined();
}

async function pendingEvaluation(overrides: Partial<CronJobCreate>) {
  const started = createDeferred<AbortSignal>();
  const evaluation = createDeferred<Awaited<ReturnType<Evaluator>>>();
  const h = await createHarness({
    evaluateCronTrigger: ({ abortSignal }) => {
      if (!abortSignal) {
        throw new Error("expected condition cancellation signal");
      }
      started.resolve(abortSignal);
      return evaluation.promise;
    },
  });
  const job = await h.cron.add(watcher(overrides));
  const run = runWhenDue(h.cron, job.id);
  h.beforeStop.push(async () => {
    evaluation.resolve(evaluated(false));
    await run;
  });
  return { h, jobId: job.id, run, signal: await started.promise, resolve: evaluation.resolve };
}

async function pendingWatcher(overrides: Partial<CronJobCreate>) {
  const started = createDeferred();
  const completion = createDeferred();
  const evaluateCronTrigger = vi.fn(async () =>
    evaluated(true, { state: { owner: "completed evaluation" } }),
  );
  const script = overrides.payload?.kind === "script";
  const runPayload = vi.fn(async () => {
    started.resolve();
    await completion.promise;
    return script
      ? { status: "ok" as const, stateChanged: true, state: { owner: "obsolete payload" } }
      : { status: "ok" as const, summary: "done" };
  });
  const h = await createHarness(
    script
      ? { runScriptJob: runPayload }
      : { evaluateCronTrigger, runIsolatedAgentJob: runPayload },
  );
  const job = await h.cron.add(
    watcher({
      trigger: { script: "fire", once: true },
      delivery: { mode: "none" },
      state: { triggerState: { owner: "original" } },
      ...overrides,
    }),
  );
  const run = runWhenDue(h.cron, job.id);
  h.beforeStop.push(async () => {
    completion.resolve();
    await run.catch(() => undefined);
    expect(runPayload).toHaveBeenCalledOnce();
    if (!script) {
      expect(evaluateCronTrigger).toHaveBeenCalledOnce();
    }
  });
  await started.promise;
  return { h, jobId: job.id, run, complete: () => completion.resolve() };
}

describe("cron trigger evaluation", () => {
  installHarnessCleanup();
  it.each([
    { sessionTarget: "main", mutation: "remove" },
    { sessionTarget: "isolated", mutation: "disable" },
  ] as const)(
    "cancels a pending $sessionTarget condition on $mutation before it can fire",
    async ({ sessionTarget, mutation }) => {
      const { h, jobId, run, signal, resolve } = await pendingEvaluation({
        sessionTarget,
        payload:
          sessionTarget === "main"
            ? { kind: "systemEvent", text: "condition payload" }
            : { kind: "agentTurn", message: "condition payload" },
        state: { triggerState: { owner: "previous evaluation" } },
      });
      if (mutation === "remove") {
        await h.cron.remove(jobId);
      } else {
        await h.cron.update(jobId, { enabled: false });
      }
      resolve(evaluated(true, { state: { owner: "late result" } }));
      await run;
      expect(signal.aborted).toBe(true);
      expect(h.runSessionEvent).not.toHaveBeenCalled();
      expect(h.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(h.runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(h.events.filter((event) => event.action === "finished")).toEqual([
        expect.objectContaining({
          status: "error",
          error:
            mutation === "remove"
              ? "Cron job removed by operator."
              : "Cron job disabled by operator.",
        }),
      ]);
      if (mutation === "disable") {
        expect(h.cron.getJob(jobId)).toMatchObject({
          enabled: false,
          state: { triggerState: { owner: "previous evaluation" } },
        });
      }
    },
  );

  it("persists quiet evaluations and fires replacement triggers with fresh state", async () => {
    const replacementScript = 'return "replacement"';
    const evaluateCronTrigger = vi.fn(async (params: Parameters<Evaluator>[0]) =>
      evaluated(params.script === replacementScript && params.state === undefined, {
        state: { status: "green" },
      }),
    );
    const h = await createHarness({ evaluateCronTrigger });
    const job = await h.cron.add(watcher());
    const dueAt = job.state.nextRunAtMs!;
    h.events.length = 0;
    expect(await runWhenDue(h.cron, job.id)).toEqual({ ok: true, ran: true });
    const stored = h.cron.getJob(job.id);
    const persisted = await readStoredJob(h.storePath, job.id);
    expect(stored?.state).toMatchObject({
      lastTriggerEvalAtMs: dueAt,
      triggerEvalCount: 1,
      triggerState: { status: "green" },
      consecutiveErrors: 0,
      scheduleErrorCount: 0,
    });
    expect(stored?.state.lastRunAtMs).toBeUndefined();
    expect(stored!.state.nextRunAtMs! - dueAt).toBeGreaterThanOrEqual(30_000);
    expect(h.runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(h.events.map((event) => event.action)).toEqual(["started", "scheduled"]);
    expectScheduled(h, job.id, persisted?.state.nextRunAtMs);
    expect(readHistory(h.storePath, job.id)).toEqual([]);
    await h.cron.update(job.id, { trigger: { script: replacementScript } });
    expect(await runWhenDue(h.cron, job.id)).toEqual({ ok: true, ran: true });
    expect(evaluateCronTrigger).toHaveBeenLastCalledWith(
      expect.objectContaining({ script: replacementScript, state: undefined }),
    );
    expect(h.runIsolatedAgentJob).toHaveBeenCalledOnce();
    expect(h.cron.getJob(job.id)?.state.triggerEvalCount).toBe(1);
  });

  it("appends the fired trigger message to the main payload and history", async () => {
    const h = await createHarness({
      evaluateCronTrigger: async () =>
        evaluated(true, { message: "CI became red", state: { status: "red" } }),
    });
    const job = await h.cron.add(
      watcher({
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "base message" },
      }),
    );
    await runWhenDue(h.cron, job.id);
    expect(h.runSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ text: "base message\n\nCI became red" }),
    );
    expect(h.events.find((event) => event.action === "finished")).toMatchObject({
      status: "ok",
      triggerFired: true,
    });
    expect(readHistory(h.storePath, job.id)).toEqual([
      expect.objectContaining({ triggerFired: true }),
    ]);
    expect(h.cron.getJob(job.id)?.state).toMatchObject({
      triggerEvalCount: 1,
      lastTriggerFireAtMs: expect.any(Number),
      triggerState: { status: "red" },
    });
  });

  it("backs off evaluator errors without reporting webhook delivery or publishing private failure details", async () => {
    const sendCronWebhook = vi.fn();
    const h = await createHarness({
      evaluateCronTrigger: async () => ({
        kind: "error",
        code: "timeout",
        error: "deadline exceeded",
      }),
      sendCronWebhook,
    });
    const job = await h.cron.add(
      watcher({ delivery: { mode: "webhook", to: "https://example.invalid/hook" } }),
    );
    const dueAt = job.state.nextRunAtMs!;
    h.events.length = 0;
    h.eventContexts.length = 0;
    await runWhenDue(h.cron, job.id);
    const state = h.cron.getJob(job.id)?.state;
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
    expect(h.eventContexts[1]).toEqual({
      failureNotificationDetail: { kind: "script-failure", source: "trigger", code: "timeout" },
    });
    expect(h.events[1]).not.toHaveProperty("failureNotificationDetail");
    expect(h.events.map((event) => event.action)).toEqual(["started", "finished", "scheduled"]);
    const history = readHistory(h.storePath, job.id);
    expect(history).toHaveLength(1);
    for (const result of [h.events[1], history[0]]) {
      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("deadline exceeded"),
        deliveryStatus: "not-requested",
      });
      expect(result?.delivered).toBeUndefined();
      expect(result?.deliveryError).toBeUndefined();
    }
    const persisted = await readStoredJob(h.storePath, job.id);
    expectScheduled(h, job.id, persisted?.state.nextRunAtMs);
  });

  it("recovers the once lifecycle after a failed state edit", async () => {
    const pending = await pendingWatcher({});
    const { h, jobId } = pending;
    await expectRejectedWrite(jobId, () =>
      h.cron.update(jobId, { state: { triggerState: { owner: "uncommitted edit" } } }),
    );
    expect((await readStoredJob(h.storePath, jobId))?.state.triggerState).toEqual({
      owner: "original",
    });
    await finishWatcherRun({ ...pending, recover: true });
    expect(h.cron.getJob(jobId)).toMatchObject({
      enabled: false,
      state: { triggerState: { owner: "completed evaluation" }, triggerEvalCount: 1 },
    });
    expect(h.cron.getJob(jobId)?.state.nextRunAtMs).toBeUndefined();
  });

  it("preserves a replacement made after a legacy terminal result", async () => {
    const pending = await pendingWatcher({ agentId: "alpha" });
    const { h, jobId } = pending;
    await finishWatcherRun({
      ...pending,
      recover: true,
      editAfterTask: async () => {
        expect(readHistory(h.storePath, jobId)[0]?.nextRunAtMs).toBeUndefined();
        const updated = await h.cron.update(jobId, {
          agentId: "beta",
          trigger: { script: "replacement", once: true },
          state: { triggerState: { owner: "later edit" } },
        });
        expect(updated.enabled).toBe(true);
        expect(updated.state.nextRunAtMs).toEqual(expect.any(Number));
      },
    });
    const stored = h.cron.getJob(jobId);
    expect(stored).toMatchObject({
      enabled: true,
      agentId: "beta",
      trigger: { script: "replacement", once: true },
      state: { triggerState: { owner: "later edit" }, nextRunAtMs: expect.any(Number) },
    });
    expectUnevaluated(stored);
  });

  it.each(["trigger", "state", "script"] as const)(
    "preserves a replaced-then-restored %s against obsolete completion",
    async (field) => {
      const originalTrigger = { script: "return original", once: true };
      const originalPayload = { kind: "script" as const, script: "return original" };
      const originalState = { owner: "original" };
      const pending = await pendingWatcher({
        trigger: field === "script" ? undefined : originalTrigger,
        ...(field === "script" ? { payload: originalPayload } : {}),
      });
      const { h, jobId } = pending;
      if (field === "trigger") {
        await h.cron.update(jobId, {
          trigger: { script: "return replacement", once: true },
          state: { triggerState: { owner: "latest edit" } },
        });
        await h.cron.update(jobId, { trigger: originalTrigger });
      } else if (field === "state") {
        await h.cron.update(jobId, { state: { triggerState: { owner: "latest edit" } } });
        await h.cron.update(jobId, { state: { triggerState: originalState } });
      } else {
        await h.cron.update(jobId, {
          payload: { kind: "script", script: "return replacement" },
        });
        await h.cron.update(jobId, { payload: originalPayload });
      }
      await finishWatcherRun({ ...pending, recover: field !== "state" });
      const stored = h.cron.getJob(jobId);
      expect(stored?.enabled).toBe(true);
      expect(stored?.state.nextRunAtMs).toEqual(expect.any(Number));
      expect(stored?.state.triggerState).toEqual(field === "state" ? originalState : undefined);
      if (field === "script") {
        expect(stored?.payload).toMatchObject(originalPayload);
        expect((await readStoredJob(h.storePath, jobId))?.state.triggerState).toBeUndefined();
      } else {
        expect(stored?.trigger).toEqual(originalTrigger);
        expectUnevaluated(stored);
      }
    },
  );

  it("preserves a replacement committed during a suspended quiet evaluation", async () => {
    const { h, jobId, run, resolve } = await pendingEvaluation({
      trigger: { script: 'return "old"' },
    });
    await h.cron.update(jobId, {
      trigger: { script: 'return "replacement"' },
      state: { triggerState: { owner: "latest edit" } },
    });
    resolve(evaluated(false, { state: { owner: "obsolete" } }));
    expect(await run).toEqual({ ok: true, ran: true });
    const stored = h.cron.getJob(jobId);
    expect(stored?.trigger).toEqual({ script: 'return "replacement"' });
    expect(stored?.state.triggerState).toEqual({ owner: "latest edit" });
    expect(stored?.state.lastTriggerEvalAtMs).toBeUndefined();
    expect(stored?.state.nextRunAtMs).toEqual(expect.any(Number));
  });

  it("reports a missing evaluator as an execution error", async () => {
    const h = await createHarness({});
    const job = await h.cron.add(watcher());
    await runWhenDue(h.cron, job.id);
    expect(h.cron.getJob(job.id)?.state).toMatchObject({
      consecutiveErrors: 1,
      lastRunStatus: "error",
      lastError: "cron trigger evaluator is unavailable",
    });
  });
});

describe("cron webhook optional output", () => {
  installHarnessCleanup();
  it.each([
    { status: "ok", summary: " \n " },
    { status: "error", summary: undefined },
  ] as const)(
    "records $status with empty output without false delivery",
    async ({ status, summary }) => {
      const sendCronWebhook = vi.fn(async () => ({ status: "delivered" as const }));
      const h = await createHarness({
        runIsolatedAgentJob: async () => ({
          status,
          summary,
          ...(status === "error" ? { error: "execution failed" } : {}),
        }),
        sendCronWebhook,
      });
      const job = await h.cron.add(
        watcher({
          trigger: undefined,
          schedule: { kind: "at", at: new Date(Date.now()).toISOString() },
          wakeMode: "next-heartbeat",
          delivery: { mode: "webhook", to: "https://example.invalid/hook" },
        }),
      );
      await h.cron.run(job.id, "force");
      const failed = status === "error";
      expect(sendCronWebhook).toHaveBeenCalledTimes(failed ? 1 : 0);
      expect(h.events.find((event) => event.action === "finished")).toMatchObject({
        status,
        completionStatus: failed ? "failed" : "succeeded",
        deliveryStatus: failed ? "delivered" : "not-delivered",
        deliverySuppressionReason: failed ? undefined : "empty",
        deliveryError: undefined,
      });
      if (!failed) {
        expect(h.cron.getJob(job.id)).toBeUndefined();
      }
    },
  );
});

async function createCadence(result: () => Awaited<ReturnType<Evaluator>>) {
  const evaluate = vi.fn(async () => {
    vi.setSystemTime(Date.now() + 123);
    return result();
  });
  return {
    h: await createHarness({ evaluateCronTrigger: evaluate, cronConfig: undefined }),
    evaluate,
  };
}

describe("cron trigger cadence", () => {
  installHarnessCleanup();
  it("does not replay a quiet occurrence after an earlier fired payload", async () => {
    let first = true;
    const { h, evaluate } = await createCadence(() => {
      const fire = first;
      first = false;
      return evaluated(fire);
    });
    const job = await h.cron.add(
      mainWatcher("quiet occurrence", {
        schedule: { kind: "cron", expr: "0 * * * * *", tz: "UTC", staggerMs: 0 },
      }),
    );
    for (let occurrence = 0; occurrence < 2; occurrence += 1) {
      expect(await runWhenDue(h.cron, job.id)).toEqual({ ok: true, ran: true });
    }
    const nextAt = h.cron.getJob(job.id)!.state.nextRunAtMs;
    await h.restart(Date.now() + 5_000);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(h.runSessionEvent).toHaveBeenCalledOnce();
    expect(h.cron.getJob(job.id)?.state.nextRunAtMs).toBe(nextAt);
  });

  it.each([
    { name: "quiet immediate-wake", wakeMode: "now", result: evaluated(false) },
    { name: "fired", wakeMode: "next-heartbeat", result: evaluated(true) },
    { name: "busy", wakeMode: "next-heartbeat", result: { kind: "busy" } },
  ] as const)(
    "preserves the $name interval through maintenance and restart",
    async ({ result, wakeMode }) => {
      const { h, evaluate } = await createCadence(() => result);
      h.cron.pauseScheduling();
      const job = await h.cron.add(mainWatcher("cadence probe", { wakeMode }));
      expect(await runWhenDue(h.cron, job.id)).toEqual({ ok: true, ran: true });
      const nextAt = Date.now() + 30_000;
      expect(h.cron.getJob(job.id)?.state.nextRunAtMs).toBe(nextAt);
      h.cron.stop();
      const offline = new CronService({ ...h.deps, cronEnabled: false });
      expect((await offline.readJob(job.id))?.state.nextRunAtMs).toBe(nextAt);
      expect((await offline.list())[0]?.state.nextRunAtMs).toBe(nextAt);
      await h.restart(Date.now() + 10_000);
      h.cron.pauseScheduling();
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(h.cron.getJob(job.id)?.state.nextRunAtMs).toBe(nextAt);
      vi.setSystemTime(nextAt - 1);
      expect(await h.cron.run(job.id, "due")).toEqual({ ok: true, ran: false, reason: "not-due" });
      vi.setSystemTime(nextAt);
      expect(await h.cron.run(job.id, "due")).toEqual({ ok: true, ran: true });
      expect(evaluate).toHaveBeenCalledTimes(2);
    },
  );

  it("defers an expired quiet immediate-wake occurrence without reevaluating it at startup", async () => {
    const { h, evaluate } = await createCadence(() => evaluated(false, { state: { count: 1 } }));
    const job = await h.cron.add(
      mainWatcher("expired quiet occurrence", {
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "must remain quiet" },
      }),
    );
    expect(await runWhenDue(h.cron, job.id)).toEqual({ ok: true, ran: true });
    const evaluatedState = structuredClone(h.cron.getJob(job.id)!.state);
    const nextAt = Date.now() + 30_000;
    expect(evaluatedState).toMatchObject({
      nextRunAtMs: nextAt,
      triggerEvalCount: 1,
      triggerState: { count: 1 },
    });
    const restartAt = nextAt + 9_586;
    await h.restart(restartAt);
    const expected = {
      nextRunAtMs: restartAt + 120_000,
      startupCatchupAtMs: restartAt + 120_000,
      triggerEvalCount: 1,
      triggerState: evaluatedState.triggerState,
      lastTriggerEvalAtMs: evaluatedState.lastTriggerEvalAtMs,
    };
    const persisted = await readStoredJob(h.storePath, job.id);
    expect(h.cron.getJob(job.id)?.state).toMatchObject(expected);
    expect(persisted?.state).toMatchObject(expected);
    expect(persisted?.state.lastRunAtMs).toBeUndefined();
    expect(evaluate).toHaveBeenCalledOnce();
    expect(h.runSessionEvent).not.toHaveBeenCalled();
    expect(h.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("catches up an old occurrence whose future slot has no recent evaluation", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.now();
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          ...mainWatcher("missed watcher"),
          id: "missed-watcher",
          createdAtMs: nowMs - 120_000,
          updatedAtMs: nowMs - 60_000,
          state: { lastRunAtMs: nowMs - 60_000, lastRunStatus: "ok", nextRunAtMs: nowMs + 20_123 },
        },
      ],
    });
    const evaluate = vi.fn(async () => evaluated(false));
    const h = await createHarness({
      storePath,
      evaluateCronTrigger: evaluate,
      cronConfig: undefined,
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(h.cron.getJob("missed-watcher")?.state).toMatchObject({
      nextRunAtMs: nowMs + 120_000,
      startupCatchupAtMs: nowMs + 120_000,
    });
    expect(await runWhenDue(h.cron, "missed-watcher")).toEqual({ ok: true, ran: true });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(h.cron.getJob("missed-watcher")?.state.nextRunAtMs).toBe(nowMs + 150_000);
    expect(h.cron.getJob("missed-watcher")?.state.startupCatchupAtMs).toBeUndefined();
  });
});
