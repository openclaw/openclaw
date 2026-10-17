// Keep the real scheduler, wake owner, preflight, busy guards, and SQLite stores.
// Busy polls hold actual command-lane work; a fabricated skipped result misses this bug.
// Model/channel I/O and late-admission activity are injected at their owned boundaries.
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { createReplyOperation, replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
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
import {
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { enqueueCommandInLane, getQueueSize, resetAllLanes } from "../process/command-queue.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { CommandLane } from "../process/lanes.js";
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

type PollFixture = Awaited<ReturnType<typeof createPollFixture>>;

async function createPollFixture(options: { scratch?: string; isolated?: boolean } = {}) {
  const scheduler = createTestGatewayScheduler("fake-timers");
  let runner: ReturnType<typeof startHeartbeatRunner> | undefined;
  let cron: CronService | undefined;
  const releases: Array<() => void> = [];
  const scheduledRuns: Promise<void>[] = [];
  async function close() {
    for (const release of releases) {
      release();
    }
    cron?.stop();
    runner?.stop();
    // Also unwind failed assertions on the unfixed branch: settle retained waiters
    // before closing their databases, rather than leaving a live Cron execution.
    const dispose = setHeartbeatWakeHandler(async () => ({
      status: "skipped",
      reason: "disabled",
    }));
    try {
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await Promise.allSettled(scheduledRuns);
      await cron?.waitForIdle();
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
  try {
    // SQLite admission shares native hrtime deadlines with a real worker thread.
    // Fake the heartbeat clock and timers without replacing that cross-thread clock.
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
    runner = startHeartbeatRunner({ cfg, runOnce });
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
    async function waitForRequest(count: number) {
      while (request.mock.calls.length < count) {
        await registered.promise;
      }
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
    cron = created.cron;
    await cron.start();
    const added = await cron.add(
      {
        declarationKey: "heartbeat:main",
        name: "heartbeat-main",
        agentId: "main",
        enabled: true,
        schedule: { kind: "every", everyMs: EVERY_MS, anchorMs: Date.now() },
        payload: { kind: "heartbeat" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      },
      { enabledExplicit: true, systemOwned: true },
    );
    const monitor = "job" in added ? added.job : added;
    if (options.scratch !== undefined) {
      expect(
        (await writeCronJobScratch({ storePath, jobId: monitor.id, content: options.scratch })).ok,
      ).toBe(true);
    }
    async function holdLane(lane: string) {
      const started = createDeferred();
      const release = createDeferred();
      releases.push(() => release.resolve());
      const work = enqueueCommandInLane(lane, async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      expect(getQueueSize(lane)).toBe(1);
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
      waitForRequest,
      finished,
      waitForFinished,
      holdLane,
      tick: () => {
        const pending = onTimer(created.state);
        scheduledRuns.push(pending);
        return pending;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function withPollFixture(
  exercise: (fixture: PollFixture) => Promise<void>,
  options?: Parameters<typeof createPollFixture>[0],
) {
  return async () => {
    const fixture = await createPollFixture(options);
    try {
      await exercise(fixture);
    } finally {
      await fixture.close();
    }
  };
}

describe("native heartbeat busy poll settlement", () => {
  it(
    "ends a busy actionable scratch poll before its deadline and executes only the next persisted tick",
    withPollFixture(
      async (f) => {
        const releaseMain = await f.holdLane(CommandLane.Main);
        const firstTick = f.monitor.state.nextRunAtMs!;
        await vi.advanceTimersByTimeAsync(firstTick - Date.now());
        const firstRun = f.tick();
        await f.waitForRequest(1);
        expect(f.request).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(250);
        // Scratch preflight uses a real worker, which fake-clock advancement cannot join.
        await f.runOnce.mock.results[0]?.value;
        // Observe the full original watchdog window on both versions. The
        // unfixed scheduler records a timeout; the fixed poll settled promptly.
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
        // A non-authoritative poll sees the scheduler's recorded cadence too.
        // Merely settling the wake without runOneAgent bookkeeping misses this.
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
        await releaseMain();
        await vi.advanceTimersByTimeAsync(nextTick - Date.now() - 1);
        expect(f.runOnce).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        const nextRun = f.tick();
        await f.waitForRequest(2);
        await vi.advanceTimersByTimeAsync(250);
        expect(f.runOnce).toHaveBeenCalledTimes(2);
        // Wait for the admitted turn itself, not a short polling deadline while
        // its first lazy-loaded reply path is preparing under fake timers.
        await f.runOnce.mock.results[1]?.value;
        await f.waitForFinished(2);
        await nextRun;
        expect(f.finished()).toHaveLength(2);
        expect(f.finished()[1]).toMatchObject({ status: "ok", completionStatus: "succeeded" });
        expect(f.reply).toHaveBeenCalledOnce();
        expect(f.runOnce).toHaveBeenCalledTimes(2);
        expect(f.cron.getJob(f.monitor.id)?.state.consecutiveErrors).toBe(0);
      },
      { scratch: "- Check the service status\n" },
    ),
  );

  it(
    "keeps cron-in-progress and native force semantics while a direct manual wake still retries",
    withPollFixture(async (f) => {
      const releaseCron = await f.holdLane(CommandLane.CronNested);
      const forced = f.cron.run(f.monitor.id, "force");
      await f.waitForRequest(1);
      await vi.advanceTimersByTimeAsync(250);
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
        error: "heartbeat skipped: cron-in-progress",
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
      await releaseCron();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(manual).resolves.toMatchObject({ status: "ran" });
      expect(f.reply).toHaveBeenCalledOnce();
      expect(f.finished()).toHaveLength(1);
    }),
  );

  it(
    "retains a poll carrying a queued cron event and reports its eventual failure to the original parent",
    withPollFixture(async (f) => {
      const releaseMain = await f.holdLane(CommandLane.Main);
      const text = "Reminder: Check the retained reminder";
      enqueueSystemEventWithReceipt(text, {
        sessionKey: f.sessionKey,
        contextKey: "cron:retained",
      });
      f.reply.mockImplementationOnce(async (_ctx, options) => {
        setHeartbeatAgentTurnStatus(options, "failed");
        return undefined;
      });
      const parent = f.cron.run(f.monitor.id, "force");
      await f.waitForRequest(1);
      expect(f.request).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(250);
      await f.runOnce.mock.results[0]?.value;
      expect(f.finished()).toHaveLength(0);
      expect(peekSystemEventEntries(f.sessionKey).map((entry) => entry.text)).toContain(text);
      expect(f.reply).not.toHaveBeenCalled();
      await releaseMain();
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(parent).resolves.toMatchObject({ ok: true, ran: true });
      expect(f.finished()).toHaveLength(1);
      expect(f.finished()[0]).toMatchObject({
        status: "error",
        error: expect.stringContaining("heartbeat failed:"),
      });
      expect(f.cron.getJob(f.monitor.id)?.state.consecutiveErrors).toBe(1);
      expect(f.reply).toHaveBeenCalledOnce();
    }),
  );

  it(
    "coalesces a native monitor with a task, retains the exact payload, and settles both parents on failure",
    withPollFixture(async (f) => {
      f.reply.mockImplementationOnce(async (_ctx, options) => {
        setHeartbeatAgentTurnStatus(options, "failed");
        return undefined;
      });
      const added = await f.cron.add(
        {
          declarationKey: heartbeatTaskDeclarationKey("main", "inbox"),
          name: "inbox",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: EVERY_MS },
          payload: { kind: "systemEvent", text: "Check urgent inbox items" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        },
        { systemOwned: true },
      );
      const task = "job" in added ? added.job : added;
      const releaseMain = await f.holdLane(CommandLane.Main);
      const parents = [f.cron.run(f.monitor.id, "force"), f.cron.run(task.id, "force")];
      // Polling with vi.waitFor advances the coalescer while SQLite admission is still pending.
      await f.waitForRequest(2);
      expect(f.request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(250);
      expect(f.runOnce).toHaveBeenCalledOnce();
      expect(f.runOnce.mock.calls[0]?.[0]).toMatchObject({
        intent: "task",
        scheduledEveryMs: EVERY_MS,
        tasks: [{ jobId: task.id, name: "inbox", prompt: "Check urgent inbox items" }],
      });
      expect(f.finished()).toHaveLength(0);
      expect(f.reply).not.toHaveBeenCalled();
      await releaseMain();
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(Promise.all(parents)).resolves.toEqual([
        expect.objectContaining({ ok: true, ran: true }),
        expect.objectContaining({ ok: true, ran: true }),
      ]);
      expect(f.reply).toHaveBeenCalledOnce();
      expect(f.reply.mock.calls[0]?.[0].Body).toContain("- inbox: Check urgent inbox items");
      expect(f.finished().map(({ jobId, status }) => ({ jobId, status }))).toEqual(
        expect.arrayContaining([
          { jobId: f.monitor.id, status: "error" },
          { jobId: task.id, status: "error" },
        ]),
      );
      expect(f.finished()).toHaveLength(2);
    }),
  );

  it(
    "retains late isolated admission and a subsequent pre-execution busy retry",
    withPollFixture(
      async (f) => {
        // Register real isolated work after the base-session fence; preparation
        // must observe it after delivery resolution and retain this occurrence.
        const isActive = replyRunRegistry.isActive.bind(replyRunRegistry);
        let lateRun: ReturnType<typeof createReplyOperation> | undefined;
        const activeReply = vi.spyOn(replyRunRegistry, "isActive").mockImplementationOnce((key) => {
          const active = isActive(key);
          lateRun = createReplyOperation({
            sessionKey: `${f.sessionKey}:heartbeat`,
            sessionId: "late-isolated-reply",
            resetTriggered: false,
          });
          lateRun.setPhase("running");
          return active;
        });
        const parent = f.cron.run(f.monitor.id, "force");
        try {
          await f.waitForRequest(1);
          expect(f.request).toHaveBeenCalledOnce();
          await vi.advanceTimersByTimeAsync(250);
          await f.runOnce.mock.results[0]?.value;
          expect(activeReply).toHaveBeenCalledTimes(2);
          expect(f.finished()).toHaveLength(0);
          expect(f.reply).not.toHaveBeenCalled();
        } finally {
          lateRun?.complete();
        }
        const releaseMain = await f.holdLane(CommandLane.Main);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.runOnce).toHaveBeenCalledTimes(2);
        await f.runOnce.mock.results[1]?.value;
        expect(f.finished()).toHaveLength(0);
        await releaseMain();
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(parent).resolves.toMatchObject({ ok: true, ran: true });
        expect(f.finished()[0]?.error).toBeUndefined();
        expect(f.finished()[0]).toMatchObject({ status: "ok" });
        expect(f.reply).toHaveBeenCalledOnce();
      },
      { isolated: true },
    ),
  );

  it(
    "still times out executing work and never overwrites the parent error on late completion",
    withPollFixture(async (f) => {
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
        await f.waitForRequest(1);
        await vi.advanceTimersByTimeAsync(250);
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
    }),
  );
});
