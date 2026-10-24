import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState as createCronServiceStateBase } from "../../cron/service/state.js";
import { onTimer } from "../../cron/service/timer.test-support.js";
import { loadCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import type { CronJob } from "../../cron/types.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { advanceCronActiveJobGeneration } from "../active-jobs.js";
import { start, stop } from "./ops-lifecycle.js";
import { add as addJob, update as updateJob } from "./ops-mutations.js";
import { status as cronStatus } from "./ops-read.js";
import { run } from "./ops-run.js";
import { executeJobCore } from "./timer-execution.js";
import {
  createDueCommandJob,
  createDueIsolatedAgentJob,
  createDueMainJob,
  createDueScriptJob,
  findCronRunByBaseRunId,
} from "./timer.seam.test-support.js";

const now = Date.parse("2026-03-23T12:00:00.000Z");

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-timer-seam",
});
let storePath: string;
let enqueueSystemEvent = vi.fn();
let runSessionEvent = vi.fn<NonNullable<StateDeps["runSessionEvent"]>>(async () => ({
  status: "ok",
}));
let states: ReturnType<typeof createCronServiceStateBase>[];
beforeEach(async () => {
  ({ storePath } = await makeStorePath());
  enqueueSystemEvent = vi.fn();
  runSessionEvent = vi.fn<NonNullable<StateDeps["runSessionEvent"]>>(async () => ({
    status: "ok",
  }));
  states = [];
});

type StateDeps = Parameters<typeof createCronServiceStateBase>[0];
function createCronServiceState(
  params: Partial<Omit<StateDeps, "storePath">> = {},
): ReturnType<typeof createCronServiceStateBase> {
  const state = createCronServiceStateBase({
    storePath,
    defaultAgentId: "main",
    nowMs: () => now,
    scheduler: createTestGatewayScheduler(),
    enqueueSystemEvent,
    runSessionEvent,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    cronEnabled: true,
    log: logger,
    ...params,
  });
  states.push(state);
  return state;
}

const readJob = async () => (await loadCronStore(storePath)).jobs[0]!;
const writeJobs = (...jobs: CronJob[]) => writeCronStoreSnapshot({ storePath, jobs });
const findRun = (jobId: string) => findCronRunByBaseRunId(storePath, `cron:${jobId}:${now}`);

function scriptFixture(
  outcome: Awaited<ReturnType<NonNullable<StateDeps["runScriptJob"]>>>,
  deps: Parameters<typeof createCronServiceState>[0] = {},
) {
  const runScriptJob = vi.fn(async () => outcome);
  const state = createCronServiceState({
    cronConfig: { triggers: { enabled: true } },
    runScriptJob,
    ...deps,
  });
  return { state, runScriptJob };
}

describe("cron service timer seam coverage", () => {
  afterEach(() => states.forEach(stop));
  it("startup ignores stale event schedule slots", async () => {
    const schedules: CronJob["schedule"][] = [
      { kind: "on-exit", command: "true" },
      { kind: "stream", command: ["true"], mode: "line" },
    ];
    const jobs = schedules.map((schedule) => {
      const job = createDueMainJob({ now, wakeMode: "next-heartbeat" });
      job.id = `stale-${schedule.kind}`;
      job.schedule = schedule;
      job.state = {
        nextRunAtMs: now - 1,
        startupCatchupAtMs: now - 1,
        pacedNextRunAtMs: now - 1,
        forcePreservedNextRunAtMs: now - 1,
      };
      return job;
    });
    await writeJobs(...jobs);
    const state = createCronServiceState();

    await start(state);
    expect(runSessionEvent).not.toHaveBeenCalled();
    const stored = await loadCronStore(storePath);
    expect(stored.jobs).toHaveLength(2);
    for (const job of stored.jobs) {
      expect(job.enabled).toBe(true);
      expect(job.state.nextRunAtMs).toBeUndefined();
      expect(job.state.startupCatchupAtMs).toBeUndefined();
      expect(job.state.pacedNextRunAtMs).toBeUndefined();
      expect(job.state.forcePreservedNextRunAtMs).toBeUndefined();
      await expect(run(state, job.id, "due")).resolves.toEqual({
        ok: true,
        ran: false,
        reason: "not-due",
      });
      await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    }
    expect(runSessionEvent).toHaveBeenCalledTimes(2);
  });

  it("persists the next schedule after the main-session run settles", async () => {
    const jobWithoutExplicitOwner = createDueMainJob({ now, wakeMode: "next-heartbeat" });
    delete jobWithoutExplicitOwner.sessionKey;
    await writeJobs(jobWithoutExplicitOwner);

    const state = createCronServiceState({
      defaultAgentId: "stale-default",
      resolveDefaultAgentId: () => "ops",
    });

    await onTimer(state);

    expect(runSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "heartbeat seam tick",
        job: expect.objectContaining({ id: "main-heartbeat-job", sessionTarget: "main" }),
      }),
    );
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    const persistedState = (await readJob()).state;
    expect(persistedState).toMatchObject({
      lastStatus: "ok",
      nextRunAtMs: now + 60_000,
    });
    expect(persistedState.runningAtMs).toBeUndefined();
    const task = findRun("main-heartbeat-job");
    expect(task).toMatchObject({
      jobId: "main-heartbeat-job",
      agentId: "ops",
      status: "succeeded",
      startedAt: now,
      lastEventAt: now,
      endedAt: now,
      cleanupAfter: now + 7 * 24 * 60 * 60_000,
      runId: expect.stringMatching(new RegExp(`^cron:main-heartbeat-job:${now}:`)),
    });
    expect(task?.sessionKey).toBeUndefined();

    expect((await cronStatus(state)).nextWakeAtMs).toBe(now + 60_000);
  });

  it("does not dispatch payload work when trigger evaluation resolves after cancellation", async () => {
    const evaluation = createDeferred<{
      kind: "evaluated";
      fire: true;
      state: { revision: number };
    }>();
    const evaluationEntered = createDeferred();
    const evaluateCronTrigger = vi.fn(() => {
      evaluationEntered.resolve();
      return evaluation.promise;
    });
    const runCommandJob = vi.fn(() => Promise.resolve({ status: "ok" as const }));
    const runScriptJob = vi.fn(() => Promise.resolve({ status: "ok" as const }));
    const runIsolatedAgentJob = vi.fn(() => Promise.resolve({ status: "ok" as const }));
    const state = createCronServiceState({
      cronConfig: { triggers: { enabled: true } },
      evaluateCronTrigger,
      runCommandJob,
      runScriptJob,
      runIsolatedAgentJob,
    });
    const job: CronJob = {
      ...createDueCommandJob({ now }),
      trigger: { script: "json({ fire: true })" },
    };
    const controller = new AbortController();

    const result = executeJobCore(state, job, controller.signal);
    try {
      await awaitGateBeforeSettlement(
        evaluationEntered.promise,
        result,
        "Cron did not enter trigger evaluation",
      );
      expect(evaluateCronTrigger).toHaveBeenCalledOnce();
      controller.abort(new Error("operator cancelled the scheduled run"));
      evaluation.resolve({ kind: "evaluated", fire: true, state: { revision: 2 } });

      await expect(result).resolves.toMatchObject({ status: "error" });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(runCommandJob).not.toHaveBeenCalled();
      expect(runScriptJob).not.toHaveBeenCalled();
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      // Abort before releasing evaluation so failed assertions cannot start payload work.
      controller.abort(new Error("operator cancelled the scheduled run"));
      evaluation.resolve({ kind: "evaluated", fire: true, state: { revision: 2 } });
      await result.catch(() => undefined);
    }
  });

  it("keeps stream jobs event-driven after a next-run state update", async () => {
    const runPayload = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      runIsolatedAgentJob: runPayload,
      runCommandJob: runPayload,
    });

    const job = await addJob(state, {
      agentId: "finn",
      name: "event command",
      enabled: true,
      schedule: { kind: "stream", command: ["true"] },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Handle stream events" },
    });
    await updateJob(state, job.id, { state: { nextRunAtMs: now - 1 } });
    await onTimer(state);
    expect(runPayload).not.toHaveBeenCalled();
    await expect(cronStatus(state)).resolves.toMatchObject({
      enabled: true,
      jobs: 1,
      nextWakeAtMs: null,
    });
    await expect(run(state, job.id, "due")).resolves.toEqual({
      ok: true,
      ran: false,
      reason: "not-due",
    });
    await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    expect(runPayload).toHaveBeenCalledOnce();
  });

  it("records an execution error when script payloads are disabled", async () => {
    const { state, runScriptJob } = scriptFixture(
      { status: "ok" },
      { cronConfig: { triggers: { enabled: false } } },
    );

    await expect(executeJobCore(state, createDueScriptJob({ now }))).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("the operator set cron.triggers.enabled: false"),
    });
    expect(runScriptJob).not.toHaveBeenCalled();
  });

  it.each([
    { target: "isolated", notify: "queue changed", wake: "now" },
    { target: "main", notify: undefined, wake: "now" },
  ] as const)(
    "routes $target script side effects (notify=$notify, wake=$wake)",
    async ({ target, notify, wake }) => {
      const sessionKey = "agent:ops:telegram:group:42:topic:77";
      const sessionStorePath = path.join(path.dirname(path.dirname(storePath)), "sessions.json");
      const deliveryContext = {
        channel: "telegram",
        to: "telegram:42",
        accountId: "ops-bot",
        threadId: 77,
      };
      await upsertSessionEntryCore(
        { storePath: sessionStorePath, sessionKey },
        {
          sessionId: "ops-telegram-session",
          updatedAt: now,
          delivery: normalizeSessionDeliveryState({ context: deliveryContext }),
        },
      );
      const enqueueSessionEvent = vi.fn();
      const expectedTarget = {
        agentId: "ops",
        sessionKey,
        sessionId: "ops-telegram-session",
        generation: "original",
        deliveryContext,
      };
      const { state } = scriptFixture(
        { status: "ok", notify, wake },
        {
          resolveDefaultAgentId: () => "other",
          resolveSessionStorePath: () => sessionStorePath,
          captureSessionEventTarget: async () => expectedTarget,
          enqueueSessionEvent,
        },
      );
      const job = {
        ...createDueScriptJob({ now, sessionTarget: target }),
        agentId: undefined,
        sessionKey,
      };
      await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });
      expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
        notify ?? "script job script job completed",
        expect.objectContaining({ agentId: "ops", sessionKey, expectedTarget, deliveryContext }),
      );
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

  it("delivers nothing and enqueues nothing when notify and wake are absent", async () => {
    const enqueueSessionEvent = vi.fn<NonNullable<StateDeps["enqueueSessionEvent"]>>();
    const { state, runScriptJob } = scriptFixture(
      {
        status: "ok",
        stateChanged: true,
        state: { revision: 2 },
        delivered: false,
        deliveryAttempted: false,
      },
      { defaultAgentId: undefined, resolveDefaultAgentId: () => undefined, enqueueSessionEvent },
    );

    await expect(
      executeJobCore(state, {
        ...createDueScriptJob({ now, sessionTarget: "main" }),
        agentId: undefined,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      scriptStateChanged: true,
      scriptState: { revision: 2 },
      delivered: false,
      deliveryAttempted: false,
    });
    expect(runScriptJob).toHaveBeenCalledOnce();
    expect(runSessionEvent).not.toHaveBeenCalled();
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("rejects nextCheck without pacing before applying state", async () => {
    const { state } = scriptFixture({
      status: "ok",
      stateChanged: true,
      state: { revision: 2 },
      nextCheck: { delayMs: 5_000 },
    });

    await expect(executeJobCore(state, createDueScriptJob({ now }))).resolves.toEqual({
      status: "error",
      error: "cron script payload returned nextCheck, but this job has no pacing bounds",
      errorClassification: { kind: "permanent" },
      failureNotificationDetail: {
        kind: "script-failure",
        source: "payload",
        code: "invalid_input",
      },
    });
  });

  it("does not persist script state from a failed run", async () => {
    const { state } = scriptFixture({
      status: "error",
      error: "script threw",
      stateChanged: true,
      state: { revision: 2 },
    });
    await writeJobs(createDueScriptJob({ now }));
    await onTimer(state);
    const job = await readJob();
    expect(job?.state.triggerState).toEqual({ revision: 1 });
    expect(job?.state.consecutiveErrors ?? 0).toBe(1);
  });

  it("records current-bound cron metadata against the backing cron session", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionId: "session-run-1",
      delivered: true,
      sessionKey: "agent:finn:cron:isolated-agent-job:run:run-1",
      delivery: { intended: { channel: "telegram", to: "42" } },
      model: "gpt-test",
      provider: "openai",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    }));

    await writeJobs({
      ...createDueIsolatedAgentJob({ now }),
      sessionTarget: "current",
      sessionKey: "agent:finn:telegram:direct:42",
    });

    const state = createCronServiceState({ runIsolatedAgentJob });

    await onTimer(state);

    expect(findRun("isolated-agent-job")).toMatchObject({
      sessionKey: "agent:finn:cron:isolated-agent-job:run:run-1",
      status: "succeeded",
      summary: "done",
      detail: {
        kind: "cron-run",
        status: "ok",
        sessionId: "session-run-1",
        durationMs: 0,
        nextRunAtMs: now + 60_000,
        delivery: { intended: { channel: "telegram", to: "42" } },
        model: "gpt-test",
        provider: "openai",
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    });
  });
});

describe("cron quiet outcome finalization", () => {
  afterEach(() => states.forEach(stop));
  it.each([
    { mode: "retired-timer", failWrite: false },
    { mode: "timer", failWrite: true },
    { mode: "retired-manual", failWrite: true },
    { mode: "manual-force", failWrite: false },
  ])(
    "commits quiet trigger history with cron state ($mode, failWrite=$failWrite)",
    async ({ mode, failWrite }) => {
      const job = {
        ...createDueIsolatedAgentJob({ now }),
        trigger: { script: "json({ fire: false })" },
      };
      const force = mode === "manual-force";
      const pendingSlot = now + 30 * 60_000;
      if (force) {
        job.pacing = { min: "15m", max: "4h" };
        job.state = {
          ...job.state,
          nextRunAtMs: pendingSlot,
          pacedNextRunAtMs: pendingSlot,
          startupCatchupAtMs: pendingSlot,
          forcePreservedNextRunAtMs: now + 15 * 60_000,
        };
      } else {
        job.state.pacedNextRunAtMs = job.state.nextRunAtMs;
      }
      await writeJobs(job);
      const database = openOpenClawStateDatabase().db;
      const state = createCronServiceState({
        cronConfig: { triggers: { enabled: true } },
        evaluateCronTrigger: vi.fn(async () => {
          if (mode.startsWith("retired")) {
            advanceCronActiveJobGeneration();
          }
          return { kind: "evaluated" as const, fire: false };
        }),
      });

      if (failWrite) {
        database.exec(`
        CREATE TRIGGER reject_quiet_terminal_row
        BEFORE UPDATE ON cron_jobs
        WHEN NEW.job_id = 'isolated-agent-job'
          AND json_extract(OLD.state_json, '$.runningAtMs') IS NOT NULL
          AND json_extract(NEW.state_json, '$.runningAtMs') IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'quiet row unavailable');
        END;
      `);
      }
      try {
        const execution = mode.includes("manual")
          ? run(
              state,
              job.id,
              force ? "force" : "due",
              force ? { evaluateTrigger: true } : undefined,
            )
          : onTimer(state);
        if (failWrite) {
          await expect(execution).rejects.toThrow("quiet row unavailable");
          expect(findRun(job.id)).toBeUndefined();
          expect((await readJob()).state.runningAtMs).toBe(now);
          return;
        }
        await execution;
        expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(
          database
            .prepare(
              "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
            )
            .get(cronStoreKey(storePath), job.id),
        ).toEqual({ status: "skipped" });
        const persistedJob = await readJob();
        expect(persistedJob.state.runningAtMs).toBeUndefined();
        expect(persistedJob.state.nextRunAtMs).toBeGreaterThan(now);
        if (force) {
          expect(persistedJob.state).toMatchObject({
            nextRunAtMs: pendingSlot,
            pacedNextRunAtMs: pendingSlot,
            startupCatchupAtMs: pendingSlot,
            forcePreservedNextRunAtMs: pendingSlot,
          });
        } else {
          expect(persistedJob.state.pacedNextRunAtMs).toBeUndefined();
        }
        const task = findRun(job.id);
        expect(task).toMatchObject({ status: "succeeded" });
        expect(task?.detail).toEqual({
          storeKey: cronStoreKey(storePath),
          triggerFired: false,
          triggerStateChanged: false,
        });
      } finally {
        database.exec("DROP TRIGGER IF EXISTS reject_quiet_terminal_row");
      }
    },
  );
});
