// Real scheduler, controller turns and SQLite; only model/channel I/O is injected.
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import type { OpenClawConfig } from "../config/config.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "../infra/heartbeat-events.js";
import {
  runHeartbeatOnce,
  startHeartbeatRunner,
  type HeartbeatDeps,
} from "../infra/heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "../infra/heartbeat-runner.test-harness.js";
import {
  seedMainSessionStore,
  setHeartbeatAgentTurnStatus,
} from "../infra/heartbeat-runner.test-utils.js";
import {
  requestHeartbeat,
  requestHeartbeatAndWait,
  setHeartbeatWakeHandler,
  setHeartbeatsEnabled,
} from "../infra/heartbeat-wake.js";
import * as heartbeatTargets from "../infra/outbound/targets.js";
import {
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { resetAllLanes } from "../process/command-queue.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  getActiveCronJobCount,
  resetCronActiveJobs,
  waitForActiveCronJobs,
} from "./active-jobs.js";
import { heartbeatTaskDeclarationKey } from "./heartbeat-task.js";
import { writeCronJobScratch } from "./scratch-store.js";
import type { CronService, CronEvent } from "./service.js";
import { createCronServiceWithStateForTest } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronJobsStore, resolveCronJobsStorePath } from "./store.js";

installHeartbeatRunnerTestRuntime();
beforeAll(async () => {
  await import("../auto-reply/dispatch.js");
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const EVERY_MS = 15 * 60_000;
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

let closeFixture: (() => Promise<void>) | undefined;

async function addHeartbeatJob(cron: CronService, kind: "monitor" | "task") {
  const monitor = kind === "monitor";
  const added = await cron.add(
    {
      declarationKey: monitor ? "heartbeat:main" : heartbeatTaskDeclarationKey("main", "inbox"),
      name: monitor ? "heartbeat-main" : "inbox",
      agentId: "main",
      enabled: true,
      schedule: { kind: "every", everyMs: EVERY_MS, ...(monitor ? { anchorMs: Date.now() } : {}) },
      payload: monitor
        ? { kind: "heartbeat" }
        : { kind: "systemEvent", text: "Check urgent inbox items" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    },
    { systemOwned: true, ...(monitor ? { enabledExplicit: true } : {}) },
  );
  return "job" in added ? added.job : added;
}

async function createPollFixture(options: { scratch?: string; isolated?: boolean } = {}) {
  const scheduler = createTestGatewayScheduler("fake-timers");
  const resources: { runner?: ReturnType<typeof startHeartbeatRunner>; cron?: CronService } = {};
  const releases: Array<() => void> = [];
  const scheduledRuns: Promise<void>[] = [];
  const heldTurns: Promise<void>[] = [];
  async function close() {
    for (const release of releases) {
      release();
    }
    resources.cron?.stop();
    resources.runner?.stop();
    // Settle retained waiters before closing their databases, including failed assertions.
    const dispose = setHeartbeatWakeHandler(async () => ({
      status: "skipped",
      reason: "disabled",
    }));
    try {
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await Promise.allSettled(heldTurns);
      await Promise.allSettled(scheduledRuns);
      await resources.cron?.waitForIdle();
      await vi.waitFor(() => expect(getActiveCronJobCount()).toBe(0));
      await scheduler.stop();
    } finally {
      dispose();
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      resetSystemEventsForTest();
      resetHeartbeatEventsForTest();
      resetCronActiveJobs();
      resetAllLanes();
      resetGatewayWorkAdmission();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  }
  closeFixture = close;

  // Keep native hrtime for SQLite worker admission deadlines.
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
  resetGatewayWorkAdmission();
  resetAllLanes();
  resetCronActiveJobs();
  resetSystemEventsForTest();
  resetHeartbeatEventsForTest();
  setHeartbeatsEnabled(true);
  const dir = tempDirs.make("openclaw-heartbeat-busy-poll-");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
  const storePath = resolveCronJobsStorePath();
  const sessionStorePath = path.join(dir, "sessions.json");
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: dir,
        heartbeat: {
          every: `${EVERY_MS}ms`,
          target: "telegram",
          ...(options.isolated ? { isolatedSession: true } : {}),
        },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    session: { store: sessionStorePath },
  };
  const sessionKey = await seedMainSessionStore(sessionStorePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "12345",
    sessionId: "busy-session",
  });
  const reply = vi.fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>().mockResolvedValue(
    createHeartbeatToolResponsePayload({
      outcome: "progress",
      notify: false,
      summary: "Monitor completed",
    }),
  );
  const deps: HeartbeatDeps = {
    getReplyFromConfig: reply,
    telegram: vi.fn().mockResolvedValue({ messageId: "m1", chatId: "12345" }),
  };
  const runOnce = vi.fn<typeof runHeartbeatOnce>((opts) =>
    runHeartbeatOnce({ ...opts, deps: { ...opts.deps, ...deps } }),
  );
  resources.runner = startHeartbeatRunner({ cfg, runOnce });
  const events: CronEvent[] = [];
  const finished = () => events.filter((event) => event.action === "finished");
  let registered = createDeferred();
  let completed = createDeferred();
  const request = vi.fn<NonNullable<CronServiceDeps["requestHeartbeatAndWait"]>>(
    (opts, lifecycle) => {
      const pending = requestHeartbeatAndWait({ ...opts, coalesceMs: 250 }, lifecycle);
      registered.resolve();
      registered = createDeferred();
      return pending;
    },
  );
  async function coalesce(count = 1) {
    while (request.mock.calls.length < count) {
      await registered.promise;
    }
    expect(request).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(250);
  }
  async function waitForFinished(count: number) {
    while (finished().length < count) {
      await completed.promise;
    }
  }
  const created = createCronServiceWithStateForTest({
    scheduler,
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    log: noopLogger,
    enqueueSystemEvent: (text, opts) => {
      const remove = enqueueSystemEventWithReceipt(text, {
        sessionKey: opts?.sessionKey ?? sessionKey,
        contextKey: opts?.contextKey,
      });
      return remove ? { accepted: true, remove } : { accepted: false };
    },
    requestHeartbeat,
    requestHeartbeatAndWait: request,
    runIsolatedAgentJob: async () => ({ status: "skipped", error: "unused test boundary" }),
    onEvent: (event) => {
      events.push(structuredClone(event));
      if (event.action === "finished") {
        completed.resolve();
        completed = createDeferred();
      }
    },
  });
  const cron = (resources.cron = created.cron);
  await cron.start();
  const monitor = await addHeartbeatJob(cron, "monitor");
  if (options.scratch !== undefined) {
    expect(
      (await writeCronJobScratch({ storePath, jobId: monitor.id, content: options.scratch })).ok,
    ).toBe(true);
  }
  async function holdSession(key = sessionKey) {
    const started = createDeferred();
    const release = createDeferred();
    releases.push(() => release.resolve());
    const work = withSessionTurn(
      {
        sessionKey: key,
        sessionId: key === sessionKey ? "busy-session" : "busy-isolated-session",
        agentId: "main",
        storePath: sessionStorePath,
      },
      async (operation, signal) => {
        operation?.setPhase("running");
        const wait = operation?.watchdog.beginWait({
          kind: "runtime_owned",
          isCurrent: () => !signal.aborted,
        });
        started.resolve();
        try {
          await release.promise;
        } finally {
          wait?.close();
        }
      },
    );
    heldTurns.push(work);
    await started.promise;
    return async () => {
      release.resolve();
      await work;
    };
  }
  return {
    cron,
    monitor,
    storePath,
    sessionKey,
    reply,
    runOnce,
    request,
    coalesce,
    finished,
    waitForFinished,
    holdSession,
    tick: () => {
      const pending = onTimer(created.state);
      scheduledRuns.push(pending);
      return pending;
    },
  };
}

describe("native heartbeat busy poll settlement", () => {
  afterEach(async () => {
    const close = closeFixture;
    closeFixture = undefined;
    await close?.();
  });
  it("ends a busy actionable scratch poll before its deadline and executes only the next persisted tick", async () => {
    const f = await createPollFixture({ scratch: "- Check the service status\n" });

    const releaseSession = await f.holdSession();
    const firstTick = f.monitor.state.nextRunAtMs!;
    await vi.advanceTimersByTimeAsync(firstTick - Date.now());
    const firstRun = f.tick();
    await f.coalesce();
    // Scratch preflight uses a real worker, which fake-clock advancement cannot join.
    await f.runOnce.mock.results[0]?.value;
    // A retained busy waiter must not survive the original watchdog window.
    await vi.advanceTimersByTimeAsync(600_001 - 250);
    await f.waitForFinished(1);
    await firstRun;
    expect(f.finished()).toHaveLength(1);
    // Finished precedes schedule maintenance and release of the active marker.
    await expect(waitForActiveCronJobs(0)).resolves.toEqual({ drained: true, active: 0 });
    const skipped = f.finished()[0];
    expect(skipped).toMatchObject({
      status: "skipped",
      error: "heartbeat skipped: requests-in-flight",
      completionStatus: "failed",
    });
    expect(skipped?.durationMs).toBeLessThan(1_000);
    expect(getLastHeartbeatEvent()).toMatchObject({
      status: "skipped",
      reason: "requests-in-flight",
    });
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.reply).not.toHaveBeenCalled();
    const nextTick = skipped!.runAtMs! + EVERY_MS;
    for (const job of [
      f.cron.getJob(f.monitor.id),
      (await loadCronJobsStore(f.storePath)).jobs.find((entry) => entry.id === f.monitor.id),
    ]) {
      expect(job?.state).toMatchObject({
        lastRunStatus: "skipped",
        lastError: "heartbeat skipped: requests-in-flight",
        consecutiveErrors: 0,
        nextRunAtMs: nextTick,
      });
      expect(job?.state.runningAtMs).toBeUndefined();
    }
    // Non-authoritative polls must see the scheduler's recorded cadence.
    const unscheduledPoll = requestHeartbeatAndWait({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: "main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    await expect(unscheduledPoll).resolves.toMatchObject({
      status: "skipped",
      reason: "not-due",
    });
    expect(f.finished()).toHaveLength(1);
    expect(f.runOnce).toHaveBeenCalledOnce();
    expect(f.reply).not.toHaveBeenCalled();
    await releaseSession();
    await vi.advanceTimersByTimeAsync(nextTick - Date.now() - 1);
    expect(f.runOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    const nextRun = f.tick();
    await f.coalesce(2);
    expect(f.runOnce).toHaveBeenCalledTimes(2);
    // Join lazy reply preparation without advancing another polling deadline.
    await f.runOnce.mock.results[1]?.value;
    await f.waitForFinished(2);
    await nextRun;
    expect(f.finished()).toHaveLength(2);
    expect(f.finished()[1]).toMatchObject({ status: "ok", completionStatus: "succeeded" });
    expect(f.reply).toHaveBeenCalledOnce();
    expect(f.runOnce).toHaveBeenCalledTimes(2);
    expect(f.cron.getJob(f.monitor.id)?.state.consecutiveErrors).toBe(0);
  });

  it("retires a forced native poll on a busy session while a direct manual wake still retries", async () => {
    const f = await createPollFixture();

    const releaseSession = await f.holdSession();
    const forced = f.cron.run(f.monitor.id, "force");
    await f.coalesce();
    await expect(forced).resolves.toMatchObject({ ok: true, ran: true });
    expect(f.finished()).toHaveLength(1);
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "interval",
        intent: "scheduled",
        scheduledEveryMs: EVERY_MS,
      }),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(f.finished()[0]).toMatchObject({
      status: "skipped",
      error: "heartbeat skipped: requests-in-flight",
    });
    const settled = vi.fn();
    const manual = requestHeartbeatAndWait({
      source: "manual",
      intent: "manual",
      agentId: "main",
      sessionKey: f.sessionKey,
      coalesceMs: 0,
    });
    void manual.then(settled);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).not.toHaveBeenCalled();
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.runOnce).toHaveBeenCalledTimes(2);
    await releaseSession();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(manual).resolves.toMatchObject({ status: "ran" });
    expect(f.reply).toHaveBeenCalledOnce();
    expect(f.finished()).toHaveLength(1);
  });

  it.each(["queued event", "coalesced task"] as const)(
    "retains a busy %s and delivers failure to every original parent",
    async (source) => {
      const f = await createPollFixture();

      const parentCount = source === "coalesced task" ? 2 : 1;
      const text = "Reminder: Check the retained reminder";
      f.reply.mockImplementationOnce(async (_ctx, options) => {
        setHeartbeatAgentTurnStatus(options, "failed");
        return undefined;
      });
      const task = source === "coalesced task" ? await addHeartbeatJob(f.cron, "task") : undefined;
      const releaseSession = await f.holdSession();
      if (!task) {
        enqueueSystemEventWithReceipt(text, {
          sessionKey: f.sessionKey,
          contextKey: "cron:retained",
        });
      }
      const parents = [f.cron.run(f.monitor.id, "force")];
      if (task) {
        parents.push(f.cron.run(task.id, "force"));
      }
      // Do not advance the coalescer until both SQLite admissions are registered.
      await f.coalesce(parentCount);
      if (task) {
        expect(f.runOnce).toHaveBeenCalledOnce();
        expect(f.runOnce.mock.calls[0]?.[0]).toMatchObject({
          intent: "task",
          scheduledEveryMs: EVERY_MS,
          tasks: [{ jobId: task.id, name: "inbox", prompt: "Check urgent inbox items" }],
        });
      } else {
        await f.runOnce.mock.results[0]?.value;
        expect(peekSystemEventEntries(f.sessionKey).map((entry) => entry.text)).toContain(text);
      }
      expect(f.finished()).toHaveLength(0);
      expect(f.reply).not.toHaveBeenCalled();
      await releaseSession();
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(Promise.all(parents)).resolves.toEqual(
        Array.from({ length: parentCount }, () => expect.objectContaining({ ok: true, ran: true })),
      );
      expect(f.reply).toHaveBeenCalledOnce();
      expect(f.finished()).toHaveLength(parentCount);
      if (task) {
        expect(f.reply.mock.calls[0]?.[0].Body).toContain("- inbox: Check urgent inbox items");
        expect(f.finished().map(({ jobId, status }) => ({ jobId, status }))).toEqual(
          expect.arrayContaining([
            { jobId: f.monitor.id, status: "error" },
            { jobId: task.id, status: "error" },
          ]),
        );
      } else {
        expect(f.finished()[0]).toMatchObject({
          status: "error",
          error: expect.stringContaining("heartbeat failed:"),
        });
        expect(f.cron.getJob(f.monitor.id)?.state.consecutiveErrors).toBe(1);
      }
    },
  );

  it("retains late isolated admission and a subsequent pre-execution busy retry", async () => {
    const f = await createPollFixture({ isolated: true });

    // The wake-stage check is clear; a real controller turn starts while
    // delivery resolution yields, before isolated admission checks again.
    const resolveTarget = heartbeatTargets.resolveHeartbeatDeliveryTargetWithSessionRoute;
    let releaseSession: (() => Promise<void>) | undefined;
    vi.spyOn(
      heartbeatTargets,
      "resolveHeartbeatDeliveryTargetWithSessionRoute",
    ).mockImplementationOnce(async (...args) => {
      const target = await resolveTarget(...args);
      releaseSession = await f.holdSession(`${f.sessionKey}:heartbeat`);
      return target;
    });
    const parent = f.cron.run(f.monitor.id, "force");
    await f.coalesce();
    await f.runOnce.mock.results[0]?.value;
    expect(releaseSession).toBeTypeOf("function");
    expect(f.finished()).toHaveLength(0);
    expect(f.reply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.runOnce).toHaveBeenCalledTimes(2);
    await f.runOnce.mock.results[1]?.value;
    expect(f.finished()).toHaveLength(0);
    await releaseSession?.();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(parent).resolves.toMatchObject({ ok: true, ran: true });
    expect(f.finished()[0]?.error).toBeUndefined();
    expect(f.finished()[0]).toMatchObject({ status: "ok" });
    expect(f.reply).toHaveBeenCalledOnce();
  });

  it("still times out executing work and never overwrites the parent error on late completion", async () => {
    const f = await createPollFixture();

    const releaseReply = createDeferred();
    const replyStarted = createDeferred();
    f.reply.mockImplementationOnce(async () => {
      replyStarted.resolve();
      await releaseReply.promise;
      return createHeartbeatToolResponsePayload({
        outcome: "progress",
        notify: false,
        summary: "Late completion",
      });
    });
    const parent = f.cron.run(f.monitor.id, "force");
    try {
      await f.coalesce();
      await replyStarted.promise;
      expect(f.reply).toHaveBeenCalledOnce();
      const waiterSignal = f.request.mock.calls[0]?.[1].abortSignal;
      expect(waiterSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(600_000);
      await expect(parent).resolves.toMatchObject({ ok: true, ran: true });
      expect(waiterSignal?.aborted).toBe(true);
      expect(f.finished()).toHaveLength(1);
      expect(f.finished()[0]).toMatchObject({
        status: "error",
        error: expect.stringContaining("job execution timed out"),
      });
      const failedState = structuredClone(f.cron.getJob(f.monitor.id)?.state);
      releaseReply.resolve();
      await f.runOnce.mock.results[0]?.value;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.finished()).toHaveLength(1);
      expect(f.cron.getJob(f.monitor.id)?.state).toEqual(failedState);
    } finally {
      releaseReply.resolve();
    }
  });
});
