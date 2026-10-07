import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState as createCronServiceStateBase } from "../../cron/service/state.js";
import { onTimer } from "../../cron/service/timer.test-support.js";
import { loadCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import type { CronJob } from "../../cron/types.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { advanceCronActiveJobGeneration } from "../active-jobs.js";
import * as runHistory from "../store/run-history.js";
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

type StateDeps = Parameters<typeof createCronServiceStateBase>[0];
type DefaultDeps =
  | "scheduler"
  | "cronEnabled"
  | "log"
  | "enqueueSystemEvent"
  | "runSessionEvent"
  | "enqueueSessionEvent"
  | "runIsolatedAgentJob";
function createCronServiceState(
  params: Omit<StateDeps, DefaultDeps> & Partial<Pick<StateDeps, DefaultDeps>>,
): ReturnType<typeof createCronServiceStateBase> {
  return createCronServiceStateBase({
    defaultAgentId: "main",
    nowMs: () => now,
    scheduler: createTestGatewayScheduler(),
    enqueueSystemEvent: vi.fn(),
    runSessionEvent: vi.fn(async () => ({ status: "ok" as const })),
    enqueueSessionEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    cronEnabled: true,
    log: logger,
    ...params,
  });
}

async function runStoredScript(
  job: CronJob,
  outcome: Awaited<ReturnType<NonNullable<StateDeps["runScriptJob"]>>>,
) {
  const { storePath } = await makeStorePath();
  await writeCronStoreSnapshot({ storePath, jobs: [job] });
  const state = createCronServiceState({
    storePath,
    cronConfig: { triggers: { enabled: true } },
    runScriptJob: vi.fn(async () => outcome),
  });
  await onTimer(state);
  return (await loadCronStore(storePath)).jobs[0];
}

describe("cron service timer seam coverage", () => {
  it("startup ignores stale event schedule slots", async () => {
    const { storePath } = await makeStorePath();
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
    await writeCronStoreSnapshot({ storePath, jobs });
    const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      runSessionEvent,
    });

    try {
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
    } finally {
      stop(state);
    }
  });

  it("persists the next schedule and executes legacy-wake main jobs normally", async () => {
    const { storePath } = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
    const clock = createGatewaySchedulerClock(now);

    const jobWithoutExplicitOwner = createDueMainJob({ now, wakeMode: "next-heartbeat" });
    delete jobWithoutExplicitOwner.sessionKey;
    await writeCronStoreSnapshot({ storePath, jobs: [jobWithoutExplicitOwner] });

    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(clock.clock),
      storePath,
      defaultAgentId: "stale-default",
      resolveDefaultAgentId: () => "ops",
      enqueueSystemEvent,
      runSessionEvent,
    });

    await onTimer(state);

    expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        text: "heartbeat seam tick",
        job: expect.objectContaining({ id: "main-heartbeat-job", sessionTarget: "main" }),
      }),
    );
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    const persisted = await loadCronStore(storePath);
    const job = persisted.jobs[0];
    if (!job) {
      throw new Error("expected persisted heartbeat cron job");
    }
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.nextRunAtMs).toBe(now + 60_000);
    const task = findCronRunByBaseRunId(storePath, `cron:main-heartbeat-job:${now}`);
    if (!task) {
      throw new Error("expected cron task ledger record");
    }
    expect(task.jobId).toBe("main-heartbeat-job");
    expect(task.agentId).toBe("ops");
    expect(task.sessionKey).toBeUndefined();
    expect(task.runId).toMatch(new RegExp(`^cron:main-heartbeat-job:${now}:`));
    expect(task.status).toBe("succeeded");
    expect(task.startedAt).toBe(now);
    expect(task.lastEventAt).toBe(now);
    expect(task.endedAt).toBe(now);
    expect(task.cleanupAfter).toBe(now + 7 * 24 * 60 * 60_000);

    expect(clock.armedAtMs).toBe(now + 60_000);
  });

  it("does not dispatch payload work when trigger evaluation resolves after cancellation", async () => {
    const { storePath } = await makeStorePath();
    const evaluation = createDeferred<{
      kind: "evaluated";
      fire: true;
      state: { revision: number };
    }>();
    const evaluationStarted = createDeferred();
    const evaluateCronTrigger = vi.fn(() => {
      evaluationStarted.resolve();
      return evaluation.promise;
    });
    const enqueueSystemEvent = vi.fn();
    const runSessionEvent = vi.fn();
    const runCommandJob = vi.fn(() => Promise.resolve({ status: "ok" as const }));
    const runScriptJob = vi.fn(() => Promise.resolve({ status: "ok" as const }));
    const runIsolatedAgentJob = vi.fn(() => Promise.resolve({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      cronConfig: { triggers: { enabled: true } },
      enqueueSystemEvent,
      runSessionEvent,
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
      await evaluationStarted.promise;
      expect(evaluateCronTrigger).toHaveBeenCalledOnce();
      controller.abort(new Error("operator cancelled the scheduled run"));
      evaluation.resolve({ kind: "evaluated", fire: true, state: { revision: 2 } });

      await expect(result).resolves.toMatchObject({ status: "error" });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(runSessionEvent).not.toHaveBeenCalled();
      expect(runCommandJob).not.toHaveBeenCalled();
      expect(runScriptJob).not.toHaveBeenCalled();
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      // Abort before releasing evaluation so failed assertions cannot start payload work.
      controller.abort(new Error("operator cancelled the scheduled run"));
      evaluation.resolve({ kind: "evaluated", fire: true, state: { revision: 2 } });
      await result;
    }
  });

  it.each([{ kind: "stream", command: ["true"] }] satisfies CronJob["schedule"][])(
    "keeps $kind jobs event-driven after a next-run state update",
    async (schedule) => {
      const { storePath } = await makeStorePath();
      const runPayload = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        storePath,
        runIsolatedAgentJob: runPayload,
        runCommandJob: runPayload,
      });

      try {
        const job = await addJob(state, {
          agentId: "finn",
          name: "event command",
          enabled: true,
          schedule,
          sessionTarget: "isolated",
          wakeMode: "now",
          payload:
            schedule.kind === "stream"
              ? { kind: "agentTurn", message: "Handle stream events" }
              : { kind: "command", argv: ["true"] },
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
      } finally {
        stop(state);
      }
    },
  );

  it("records an execution error when script payloads are disabled", async () => {
    const { storePath } = await makeStorePath();
    const runScriptJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      cronConfig: { triggers: { enabled: false } },
      runScriptJob,
    });

    await expect(executeJobCore(state, createDueScriptJob({ now }))).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("the operator set cron.triggers.enabled: false"),
    });
    expect(runScriptJob).not.toHaveBeenCalled();
  });

  it.each([
    { target: "main", notify: "queue changed", wake: "next-heartbeat" },
    { target: "isolated", notify: "queue changed", wake: "now" },
    { target: "main", notify: undefined, wake: "now" },
  ] as const)(
    "routes $target script side effects (notify=$notify, wake=$wake)",
    async ({ target, notify, wake }) => {
      const { storePath } = await makeStorePath();
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
      const enqueueSystemEvent = vi.fn();
      const enqueueSessionEvent = vi.fn();
      const expectedTarget = {
        agentId: "ops",
        sessionKey,
        sessionId: "ops-telegram-session",
        generation: "original",
        deliveryContext,
      };
      const state = createCronServiceState({
        storePath,
        cronConfig: { triggers: { enabled: true } },
        resolveDefaultAgentId: () => "other",
        resolveSessionStorePath: () => sessionStorePath,
        enqueueSystemEvent,
        enqueueSessionEvent,
        captureSessionEventTarget: vi.fn(async () => expectedTarget),
        runScriptJob: vi.fn(async () => ({ status: "ok" as const, notify, wake })),
      });
      const job = {
        ...createDueScriptJob({ now, sessionTarget: target }),
        agentId: undefined,
        sessionKey,
      };
      await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });
      if (wake) {
        expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
          notify ?? "script job script job completed",
          { agentId: "ops", sessionKey, expectedTarget, deliveryContext },
        );
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
      } else {
        expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(notify, {
          agentId: "ops",
          contextKey: "cron:script-job:script",
          deliveryContext,
        });
        expect(enqueueSessionEvent).not.toHaveBeenCalled();
      }
    },
  );

  it("delivers nothing and enqueues nothing when notify and wake are absent", async () => {
    const { storePath } = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const enqueueSessionEvent = vi.fn();
    const resolveDefaultAgentId = vi.fn(() => undefined);
    const state = createCronServiceState({
      storePath,
      defaultAgentId: undefined,
      resolveDefaultAgentId,
      cronConfig: { triggers: { enabled: true } },
      enqueueSystemEvent,
      enqueueSessionEvent,
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        stateChanged: true,
        state: { revision: 2 },
        delivered: false,
        deliveryAttempted: false,
      })),
    });

    await expect(
      executeJobCore(state, {
        ...createDueScriptJob({ now, sessionTarget: "main" }),
        agentId: undefined,
      }),
    ).resolves.toMatchObject({ status: "ok", scriptStateChanged: true });
    expect(resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
  });

  it("rejects nextCheck without pacing before applying state", async () => {
    const { storePath } = await makeStorePath();
    const state = createCronServiceState({
      storePath,
      cronConfig: { triggers: { enabled: true } },
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        stateChanged: true,
        state: { revision: 2 },
        nextCheck: { delayMs: 5_000 },
      })),
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

  it.each([
    { status: "ok", error: undefined, revision: 2, errors: 0 },
    { status: "error", error: "script threw", revision: 1, errors: 1 },
  ] as const)(
    "persists script state on $status runs only",
    async ({ status, error, revision, errors }) => {
      const job = await runStoredScript(createDueScriptJob({ now }), {
        status,
        error,
        stateChanged: true,
        state: { revision: 2 },
      });
      expect(job?.state.triggerState).toEqual({ revision });
      expect(job?.state.consecutiveErrors ?? 0).toBe(errors);
    },
  );

  it("records current-bound cron metadata against the backing cron session", async () => {
    const { storePath } = await makeStorePath();
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

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          ...createDueIsolatedAgentJob({ now }),
          sessionTarget: "current",
          sessionKey: "agent:finn:telegram:direct:42",
        },
      ],
    });

    const state = createCronServiceState({
      storePath,
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const task = findCronRunByBaseRunId(storePath, `cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected isolated cron history record");
    }
    expect(task.sessionKey).toBe("agent:finn:cron:isolated-agent-job:run:run-1");
    expect(task.status).toBe("succeeded");
    expect(task.summary).toBe("done");
    expect(task.detail).toMatchObject({
      kind: "cron-run",
      status: "ok",
      sessionId: "session-run-1",
      durationMs: 0,
      nextRunAtMs: now + 60_000,
      delivery: { intended: { channel: "telegram", to: "42" } },
      model: "gpt-test",
      provider: "openai",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });
  });
});

describe("cron quiet outcome finalization", () => {
  it.each([
    { mode: "retired-timer", failWrite: false },
    { mode: "timer", failWrite: true },
    { mode: "retired-manual", failWrite: true },
    { mode: "manual-force", failWrite: false },
  ])(
    "records quiet trigger recovery only after cron state persists ($mode, failWrite=$failWrite)",
    async ({ mode, failWrite }) => {
      const { storePath } = await makeStorePath();
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
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const finalizedAfterPersist: boolean[] = [];
      const database = openOpenClawStateDatabase().db;
      const finalize = runHistory.recordCronRun;
      const finalizeSpy = vi.spyOn(runHistory, "recordCronRun").mockImplementation((params) => {
        const persistedJob = openOpenClawStateDatabase()
          .db.prepare(
            "SELECT json_extract(state_json, '$.runningAtMs') AS runningAtMs, json_extract(state_json, '$.nextRunAtMs') AS nextRunAtMs FROM cron_jobs WHERE store_key = ? AND job_id = ?",
          )
          .get(cronStoreKey(storePath), job.id) as {
          runningAtMs: number | null;
          nextRunAtMs: number | null;
        };
        finalizedAfterPersist.push(
          persistedJob.runningAtMs === null && (persistedJob.nextRunAtMs ?? 0) > now,
        );
        return finalize(params);
      });
      const state = createCronServiceState({
        storePath,
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
          expect(finalizedAfterPersist).toEqual([]);
          expect(findCronRunByBaseRunId(storePath, `cron:${job.id}:${now}`)).toBeUndefined();
          expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(now);
          return;
        }
        await execution;
        expect(finalizedAfterPersist).toEqual([true]);
        if (force) {
          expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
            nextRunAtMs: pendingSlot,
            pacedNextRunAtMs: pendingSlot,
            startupCatchupAtMs: pendingSlot,
            forcePreservedNextRunAtMs: pendingSlot,
          });
        } else {
          expect((await loadCronStore(storePath)).jobs[0]?.state.pacedNextRunAtMs).toBeUndefined();
        }
        const task = findCronRunByBaseRunId(storePath, `cron:${job.id}:${now}`);
        expect(task).toMatchObject({ status: "succeeded" });
        expect(task?.detail).toEqual({
          storeKey: cronStoreKey(storePath),
          triggerFired: false,
          triggerStateChanged: false,
        });
      } finally {
        stop(state);
        database.exec("DROP TRIGGER IF EXISTS reject_quiet_terminal_row");
        finalizeSpy.mockRestore();
      }
    },
  );
});
