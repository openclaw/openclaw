// Keep the real scheduler, wake owner, preflight, busy guards, and SQLite stores.
// Busy polls hold actual command-lane work; a fabricated skipped result misses this bug.
// Model/channel I/O and late-admission activity are injected at their owned boundaries.
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
import {
  getActiveCronJobCount,
  resetCronActiveJobs,
  waitForActiveCronJobs,
} from "./active-jobs.js";
import { heartbeatTaskDeclarationKey } from "./heartbeat-task.js";
import { writeCronJobScratch } from "./scratch-store.js";
import { CronService, type CronEvent } from "./service.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronJobsStoreSync, resolveCronJobsStorePath } from "./store.js";

installHeartbeatRunnerTestRuntime();
beforeAll(async () => {
  await import("../auto-reply/dispatch.js");
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const EVERY_MS = 15 * 60_000;
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

type PollFixture = Awaited<ReturnType<typeof createPollFixture>>;

async function createPollFixture(options: { scratch?: string; isolated?: boolean } = {}) {
  let runner: ReturnType<typeof startHeartbeatRunner> | undefined;
  let cron: CronService | undefined;
  const releases: Array<() => void> = [];
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
      await vi.waitFor(() => expect(getActiveCronJobCount()).toBe(0));
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
    cron = new CronService({
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
        writeCronJobScratch({ storePath, jobId: monitor.id, content: options.scratch }).ok,
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
      runner,
      cfg,
      monitor,
      storePath,
      sessionKey,
      reply,
      deps,
      runOnce,
      request,
      waitForRequest,
      finished,
      waitForFinished,
      holdLane,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function withPollFixture(
  exercise: (fixture: PollFixture) => Promise<void>,
  options?: Parameters<typeof createPollFixture>[0],
) {
  const fixture = await createPollFixture(options);
  try {
    await exercise(fixture);
  } finally {
    await fixture.close();
  }
}

describe("native heartbeat busy poll settlement", () => {
  it.each([
    { label: "actionable scratch", scratch: "- Check the service status\n" },
    { label: "missing scratch", scratch: undefined },
  ])(
    "ends a busy $label poll before its deadline and executes only the next persisted tick",
    async ({ scratch }) => {
      await withPollFixture(
        async ({
          cron,
          monitor,
          storePath,
          reply,
          runOnce,
          request,
          waitForRequest,
          finished,
          waitForFinished,
          holdLane,
        }) => {
          const releaseMain = await holdLane(CommandLane.Main);
          const firstTick = monitor.state.nextRunAtMs!;
          await vi.advanceTimersByTimeAsync(firstTick - Date.now());
          await waitForRequest(1);
          expect(request).toHaveBeenCalledOnce();
          // Observe the full original watchdog window on both versions. The
          // unfixed scheduler records a timeout; the fixed poll settled promptly.
          await vi.advanceTimersByTimeAsync(600_001);
          await waitForFinished(1);
          expect(finished()).toHaveLength(1);
          // Finished precedes schedule maintenance and release of the active marker.
          await expect(waitForActiveCronJobs(0)).resolves.toEqual({ drained: true, active: 0 });
          const skipped = finished()[0];
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
          expect(request).toHaveBeenCalledOnce();
          expect(reply).not.toHaveBeenCalled();
          const nextTick = skipped!.runAtMs! + EVERY_MS;
          for (const job of [
            cron.getJob(monitor.id),
            loadCronJobsStoreSync(storePath).jobs.find((entry) => entry.id === monitor.id),
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
          expect(finished()).toHaveLength(1);
          expect(runOnce).toHaveBeenCalledOnce();
          expect(reply).not.toHaveBeenCalled();
          await releaseMain();
          await vi.advanceTimersByTimeAsync(nextTick - Date.now() - 1);
          expect(runOnce).toHaveBeenCalledOnce();
          await vi.advanceTimersByTimeAsync(1);
          await waitForRequest(2);
          await vi.advanceTimersByTimeAsync(250);
          expect(runOnce).toHaveBeenCalledTimes(2);
          // Wait for the admitted turn itself, not a short polling deadline while
          // its first lazy-loaded reply path is preparing under fake timers.
          await runOnce.mock.results[1]?.value;
          await waitForFinished(2);
          expect(finished()).toHaveLength(2);
          expect(finished()[1]).toMatchObject({ status: "ok", completionStatus: "succeeded" });
          expect(reply).toHaveBeenCalledOnce();
          expect(runOnce).toHaveBeenCalledTimes(2);
          expect(cron.getJob(monitor.id)?.state.consecutiveErrors).toBe(0);
        },
        { scratch },
      );
    },
  );

  it("keeps cron-in-progress and native force semantics while a direct manual wake still retries", async () => {
    await withPollFixture(
      async ({
        cron,
        monitor,
        sessionKey,
        reply,
        runOnce,
        request,
        waitForRequest,
        finished,
        holdLane,
      }) => {
        const releaseCron = await holdLane(CommandLane.CronNested);
        const forced = cron.run(monitor.id, "force");
        await waitForRequest(1);
        await vi.advanceTimersByTimeAsync(250);
        await expect(forced).resolves.toMatchObject({ ok: true, ran: true });
        expect(finished()).toHaveLength(1);
        expect(request).toHaveBeenCalledWith(
          expect.objectContaining({
            source: "interval",
            intent: "scheduled",
            scheduledEveryMs: EVERY_MS,
          }),
          expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
        );
        expect(finished()[0]).toMatchObject({
          status: "skipped",
          error: "heartbeat skipped: cron-in-progress",
        });
        const settled = vi.fn();
        const manual = requestHeartbeatAndWait({
          source: "manual",
          intent: "manual",
          agentId: "main",
          sessionKey,
          coalesceMs: 0,
        });
        void manual.then(settled);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).not.toHaveBeenCalled();
        expect(reply).not.toHaveBeenCalled();
        expect(runOnce).toHaveBeenCalledTimes(2);
        await releaseCron();
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(manual).resolves.toMatchObject({ status: "ran" });
        expect(reply).toHaveBeenCalledOnce();
        expect(finished()).toHaveLength(1);
      },
    );
  });

  it.each(["generic", "cron"] as const)(
    "retains a poll carrying a queued %s event and reports its eventual failure to the original parent",
    async (kind) => {
      await withPollFixture(
        async ({
          cron,
          monitor,
          sessionKey,
          reply,
          request,
          waitForRequest,
          finished,
          holdLane,
        }) => {
          const releaseMain = await holdLane(CommandLane.Main);
          const text =
            kind === "cron" ? "Reminder: Check the retained reminder" : "Retained generic event";
          enqueueSystemEventWithReceipt(text, {
            sessionKey,
            ...(kind === "cron" ? { contextKey: "cron:retained" } : {}),
          });
          reply.mockImplementationOnce(async (_ctx, options) => {
            setHeartbeatAgentTurnStatus(options, "failed");
            return undefined;
          });
          const parent = cron.run(monitor.id, "force");
          await waitForRequest(1);
          expect(request).toHaveBeenCalledOnce();
          await vi.advanceTimersByTimeAsync(250);
          expect(finished()).toHaveLength(0);
          expect(peekSystemEventEntries(sessionKey).map((entry) => entry.text)).toContain(text);
          expect(reply).not.toHaveBeenCalled();
          await releaseMain();
          await vi.advanceTimersByTimeAsync(60_000);
          await expect(parent).resolves.toMatchObject({ ok: true, ran: true });
          expect(finished()).toHaveLength(1);
          expect(finished()[0]).toMatchObject({
            status: "error",
            error: expect.stringContaining("heartbeat failed:"),
          });
          expect(cron.getJob(monitor.id)?.state.consecutiveErrors).toBe(1);
          expect(reply).toHaveBeenCalledOnce();
        },
      );
    },
  );

  it.each(["success", "failure"] as const)(
    "coalesces a native monitor with a task, retains the exact payload, and settles both parents on %s",
    async (outcome) => {
      await withPollFixture(
        async ({ cron, monitor, reply, runOnce, request, waitForRequest, finished, holdLane }) => {
          if (outcome === "failure") {
            reply.mockImplementationOnce(async (_ctx, options) => {
              setHeartbeatAgentTurnStatus(options, "failed");
              return undefined;
            });
          }
          const added = await cron.add(
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
          const releaseMain = await holdLane(CommandLane.Main);
          const parents = [cron.run(monitor.id, "force"), cron.run(task.id, "force")];
          // Polling with vi.waitFor advances the coalescer while SQLite admission is still pending.
          await waitForRequest(2);
          expect(request).toHaveBeenCalledTimes(2);
          await vi.advanceTimersByTimeAsync(250);
          expect(runOnce).toHaveBeenCalledOnce();
          expect(runOnce.mock.calls[0]?.[0]).toMatchObject({
            intent: "task",
            scheduledEveryMs: EVERY_MS,
            tasks: [{ jobId: task.id, name: "inbox", prompt: "Check urgent inbox items" }],
          });
          expect(finished()).toHaveLength(0);
          expect(reply).not.toHaveBeenCalled();
          await releaseMain();
          await vi.advanceTimersByTimeAsync(60_000);
          await expect(Promise.all(parents)).resolves.toEqual([
            expect.objectContaining({ ok: true, ran: true }),
            expect.objectContaining({ ok: true, ran: true }),
          ]);
          expect(reply).toHaveBeenCalledOnce();
          expect(reply.mock.calls[0]?.[0].Body).toContain("- inbox: Check urgent inbox items");
          expect(finished().map(({ jobId, status }) => ({ jobId, status }))).toEqual(
            expect.arrayContaining([
              { jobId: monitor.id, status: outcome === "success" ? "ok" : "error" },
              { jobId: task.id, status: outcome === "success" ? "ok" : "error" },
            ]),
          );
          expect(finished()).toHaveLength(2);
        },
      );
    },
  );

  it("retains late isolated admission and a subsequent pre-execution busy retry", async () => {
    await withPollFixture(
      async ({
        cron,
        monitor,
        deps,
        reply,
        runOnce,
        request,
        waitForRequest,
        finished,
        holdLane,
      }) => {
        // The wake-stage check is clear; the second check is in preparation after
        // delivery resolution. This is the actual late admission boundary.
        deps.isReplyRunActive = vi
          .fn()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true)
          .mockReturnValue(false);
        const parent = cron.run(monitor.id, "force");
        await waitForRequest(1);
        expect(request).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(250);
        expect(deps.isReplyRunActive).toHaveBeenCalledTimes(2);
        expect(finished()).toHaveLength(0);
        expect(reply).not.toHaveBeenCalled();
        const releaseMain = await holdLane(CommandLane.Main);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(runOnce).toHaveBeenCalledTimes(2);
        expect(finished()).toHaveLength(0);
        await releaseMain();
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(parent).resolves.toMatchObject({ ok: true, ran: true });
        expect(finished()[0]?.error).toBeUndefined();
        expect(finished()[0]).toMatchObject({ status: "ok" });
        expect(reply).toHaveBeenCalledOnce();
      },
      { isolated: true },
    );
  });

  it("still times out executing work and never overwrites the parent error on late completion", async () => {
    await withPollFixture(
      async ({ cron, monitor, reply, runOnce, request, waitForRequest, finished }) => {
        const releaseReply = createDeferred();
        const replyStarted = createDeferred();
        reply.mockImplementationOnce(async () => {
          replyStarted.resolve();
          await releaseReply.promise;
          return createHeartbeatToolResponsePayload({
            outcome: "progress",
            notify: false,
            summary: "Late completion",
          });
        });
        const parent = cron.run(monitor.id, "force");
        try {
          await waitForRequest(1);
          await vi.advanceTimersByTimeAsync(250);
          await replyStarted.promise;
          expect(reply).toHaveBeenCalledOnce();
          const waiterSignal = request.mock.calls[0]?.[1].abortSignal;
          expect(waiterSignal?.aborted).toBe(false);
          await vi.advanceTimersByTimeAsync(600_000);
          await expect(parent).resolves.toMatchObject({ ok: true, ran: true });
          expect(waiterSignal?.aborted).toBe(true);
          expect(finished()).toHaveLength(1);
          expect(finished()[0]).toMatchObject({
            status: "error",
            error: expect.stringContaining("job execution timed out"),
          });
          const failedState = structuredClone(cron.getJob(monitor.id)?.state);
          releaseReply.resolve();
          await runOnce.mock.results[0]?.value;
          await vi.advanceTimersByTimeAsync(1_000);
          expect(finished()).toHaveLength(1);
          expect(cron.getJob(monitor.id)?.state).toEqual(failedState);
        } finally {
          releaseReply.resolve();
        }
      },
    );
  });
});
