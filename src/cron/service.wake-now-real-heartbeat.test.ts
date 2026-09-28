// Exercise the scheduler's active marker against the real heartbeat busy guard.
// Stubbing runHeartbeatOnce hides this cross-owner interaction.
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { runHeartbeatOnce, startHeartbeatRunner } from "../infra/heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "../infra/heartbeat-runner.test-harness.js";
import { seedMainSessionStore } from "../infra/heartbeat-runner.test-utils.js";
import {
  getHeartbeatWakeAbortSignal,
  requestHeartbeat as queueHeartbeat,
  requestHeartbeatAndWait,
  setHeartbeatsEnabled,
} from "../infra/heartbeat-wake.js";
import {
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { enqueueCommandInLane, getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  getActiveCronJobCount,
  resetCronActiveJobs,
  waitForActiveCronJobs,
} from "./active-jobs.js";
import { CronService, type CronEvent } from "./service.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronJobsStore } from "./store.js";

installHeartbeatRunnerTestRuntime();
beforeAll(async () => {
  // Dispatch lazily loads fast-abort handling even with an injected reply resolver.
  // Load both graphs before this real-time scheduler fixture starts its watchdog.
  await Promise.all([
    import("../auto-reply/dispatch.js"),
    import("../auto-reply/reply/abort.runtime.js"),
  ]);
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  setHeartbeatsEnabled(true);
  resetSystemEventsForTest();
  resetCronActiveJobs();
  closeOpenClawAgentDatabasesForTest();
  vi.restoreAllMocks();
});

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeSandbox() {
  const dir = tempDirs.make("openclaw-cron-real-heartbeat-");
  return {
    dir,
    cronStorePath: path.join(dir, "cron", "jobs.json"),
    sessionStorePath: path.join(dir, "sessions.json"),
  };
}

type WakeNowRunMode = "direct" | "queued" | "scheduled";
type MainCronReply = ReturnType<typeof createHeartbeatToolResponsePayload> | { text: string };
type MainCronFixture = {
  cron: CronService;
  heartbeatRunner: ReturnType<typeof startHeartbeatRunner>;
  getReplySpy: Mock<(ctx: MsgContext) => Promise<MainCronReply>>;
};

async function runMainCronCase(
  mode: WakeNowRunMode,
  wakeMode: "now" | "next-heartbeat" = "now",
  options: {
    deleteAfterRun?: boolean;
    heartbeatPaused?: boolean;
    disableBeforeRun?: boolean;
    transientSession?: boolean;
    mixedExec?: boolean;
  } = {},
  exercise?: (fixture: MainCronFixture) => Promise<void>,
) {
  const sandbox = makeSandbox();
  const followUpCompleted = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
  const wakeSignals: Array<AbortSignal | undefined> = [];
  const getReplySpy = vi.fn<(ctx: MsgContext) => Promise<MainCronReply>>(async (ctx) => {
    wakeSignals.push(getHeartbeatWakeAbortSignal());
    if (options.mixedExec && ctx.InternalTurnSource === "cron") {
      enqueueSystemEventWithReceipt("Reminder: Late arrival", {
        sessionKey: expectedMainSessionKey,
        contextKey: "cron:late-arrival",
      });
    }
    return options.transientSession
      ? createHeartbeatToolResponsePayload({
          outcome: "progress",
          notify: false,
          summary: "Transient heartbeat completed",
        })
      : { text: ctx.InternalTurnSource === "exec" ? "Command completed" : "Handled the reminder" };
  });
  const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });
  const requestHeartbeat = vi.fn();
  const finished = createDeferred<CronEvent>();

  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: sandbox.dir,
        heartbeat: {
          every: options.mixedExec ? "0m" : "5m",
          target: "telegram",
          ...(options.transientSession ? { isolatedSession: true } : {}),
          ...(options.mixedExec ? { to: "999999" } : {}),
        },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    session: {
      store: sandbox.sessionStorePath,
      ...(options.transientSession ? { mainKey: "cron:job:run:transient" } : {}),
    },
  };
  const expectedMainSessionKey = resolveAgentMainSessionKey({ cfg, agentId: "main" });
  if (!options.transientSession) {
    await seedMainSessionStore(sandbox.sessionStorePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "-100155462274",
    });
  }

  const runHeartbeatOnceReal: typeof runHeartbeatOnce = async (opts) => {
    const outcome = await runHeartbeatOnce({
      ...opts,
      cfg,
      deps: { getReplyFromConfig: getReplySpy, telegram: sendTelegram },
    });
    if (options.mixedExec && getReplySpy.mock.calls.length >= 2) {
      followUpCompleted.resolve(outcome);
    }
    return outcome;
  };

  const heartbeatRunner = startHeartbeatRunner({ cfg, runOnce: runHeartbeatOnceReal });
  const clock = createGatewaySchedulerClock(Date.now());
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath: sandbox.cronStorePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: (text, opts) => {
      const agentId = opts?.agentId ?? "main";
      const sessionKey = opts?.sessionKey ?? resolveAgentMainSessionKey({ cfg, agentId });
      const remove = enqueueSystemEventWithReceipt(text, {
        sessionKey,
        contextKey: opts?.contextKey,
        deliveryContext: opts?.deliveryContext,
      });
      return remove ? { accepted: true, remove } : { accepted: false };
    },
    requestHeartbeat,
    requestHeartbeatAndWait: (opts, lifecycle) => {
      const sessionKey = opts.sessionKey ?? expectedMainSessionKey;
      if (options.mixedExec) {
        enqueueSystemEventWithReceipt("Exec completed (report, code 0) :: ready", { sessionKey });
        queueHeartbeat({
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          agentId: "main",
          sessionKey,
          coalesceMs: 0,
        });
      }
      return requestHeartbeatAndWait({ ...opts, sessionKey, coalesceMs: 0 }, lifecycle);
    },
    runIsolatedAgentJob: vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
      status: "ok",
    })),
    onEvent: (event) => {
      if (event.action === "finished") {
        finished.resolve(event);
      }
    },
  });
  await cron.start();
  let scheduledTick: Promise<void> | undefined;

  const runBody = async () => {
    // Fault cases must unwind the same fixture owner as the normal scheduler cases.
    if (exercise) {
      await exercise({ cron, heartbeatRunner, getReplySpy });
      return undefined;
    }
    if (options.heartbeatPaused) {
      setHeartbeatsEnabled(false);
    }
    const job = await cron.add({
      enabled: true,
      name: "nightly report",
      schedule: {
        kind: "at",
        at: new Date(clock.clock.now() + (mode === "scheduled" ? 250 : 60 * 60_000)).toISOString(),
      },
      sessionTarget: "main",
      wakeMode,
      payload: { kind: "systemEvent", text: "Reminder: Send the nightly report" },
      ...(options.deleteAfterRun === undefined ? {} : { deleteAfterRun: options.deleteAfterRun }),
    });
    const scheduledNextRunAtMs = job.state.nextRunAtMs;
    if (options.disableBeforeRun) {
      const disabled = await cron.update(job.id, { enabled: false });
      expect(disabled.enabled).toBe(false);
      expect(disabled.state.nextRunAtMs).toBeUndefined();
    }

    if (mode === "direct") {
      await cron.run(job.id, "force");
    } else if (mode === "queued") {
      await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
        ok: true,
        enqueued: true,
      });
    } else {
      scheduledTick = Promise.resolve(clock.advanceTo(job.state.nextRunAtMs!));
    }

    const [terminal, followUp] = await withTestTimeout(
      // Cron emits finished before asynchronous finalization releases its busy guard.
      Promise.all([finished.promise, options.mixedExec ? followUpCompleted.promise : undefined]),
      10_000,
      `${mode} cron run did not finish`,
    );
    if (options.heartbeatPaused) {
      expect(terminal).toMatchObject({ status: "skipped", error: "disabled" });
      expect(getReplySpy).not.toHaveBeenCalled();
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(expectedMainSessionKey)).toHaveLength(0);

      const expectedNextRunAtMs = options.disableBeforeRun
        ? undefined
        : mode === "scheduled"
          ? terminal.runAtMs! + terminal.durationMs! + 30_000
          : scheduledNextRunAtMs;
      const persisted = (await loadCronJobsStore(sandbox.cronStorePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      for (const completed of [cron.getJob(job.id), persisted, terminal.job]) {
        expect(completed).toMatchObject({
          enabled: !options.disableBeforeRun,
          state: { lastRunStatus: "skipped", lastError: "disabled", consecutiveSkipped: 1 },
        });
        expect(completed?.state.nextRunAtMs).toBe(expectedNextRunAtMs);
      }
      expect(terminal.nextRunAtMs).toBe(expectedNextRunAtMs);
      return { expectedMainSessionKey, sandbox, terminal };
    }
    expect(terminal.status).toBe("ok");
    if (wakeMode === "next-heartbeat") {
      expect(getReplySpy).not.toHaveBeenCalled();
      expect(requestHeartbeat).toHaveBeenCalledTimes(1);
      await expect(
        runHeartbeatOnce({
          cfg,
          source: "interval",
          intent: "scheduled",
          reason: "interval",
          agentId: "main",
          scheduledEveryMs: 5 * 60_000,
          deps: { getReplyFromConfig: getReplySpy, telegram: sendTelegram },
        }),
      ).resolves.toMatchObject({ status: "ran" });
    } else {
      expect(requestHeartbeat).not.toHaveBeenCalled();
      expect(wakeSignals[0]).toBeInstanceOf(AbortSignal);
    }
    if (options.mixedExec) {
      expect(followUp).toMatchObject({ status: "ran" });
      expect(getReplySpy).toHaveBeenCalledTimes(2);
      expect(getReplySpy.mock.calls[0]?.[0].InternalTurnSource).toBe("exec");
      expect(getReplySpy.mock.calls[0]?.[0].Body).not.toContain(
        "Reminder: Send the nightly report",
      );
      expect(getReplySpy.mock.calls[1]?.[0]).toMatchObject({
        InternalTurnSource: "cron",
        SessionKey: expectedMainSessionKey,
      });
      expect(getReplySpy.mock.calls[1]?.[0].Body).toContain("Reminder: Send the nightly report");
      expect(getReplySpy.mock.calls[1]?.[0].Body).not.toContain("Exec completed");
      expect(sendTelegram).toHaveBeenCalledTimes(2);
      expect(sendTelegram.mock.calls.map(([to]) => to)).toEqual(["-100155462274", "-100155462274"]);
      expect(peekSystemEventEntries(expectedMainSessionKey).map((event) => event.text)).toEqual([
        "Reminder: Late arrival",
      ]);
      expect(cron.getJob(job.id)).toBeUndefined();
      return undefined;
    }
    expect(getReplySpy).toHaveBeenCalledTimes(1);

    const replyCtx = getReplySpy.mock.calls[0]?.[0];
    expect(replyCtx?.InternalTurnSource).toBe("cron");
    expect(replyCtx?.Provider).toBeUndefined();
    expect(replyCtx?.SessionKey).toBe(
      options.transientSession ? `${expectedMainSessionKey}:heartbeat` : expectedMainSessionKey,
    );
    expect(replyCtx?.Body).toContain("Reminder: Send the nightly report");
    expect(peekSystemEventEntries(expectedMainSessionKey)).toHaveLength(0);
    if (options.deleteAfterRun) {
      expect(cron.getJob(job.id)).toBeUndefined();
    }
    return { expectedMainSessionKey, sandbox, terminal };
  };
  return runQaGatewayFixture(
    runBody,
    async () => {
      cron.stop();
      // Keep the heartbeat alive until its Cron waiter and owning lane settle.
      await expect(waitForActiveCronJobs(5_000)).resolves.toEqual({ drained: true, active: 0 });
      await scheduledTick;
      await vi.waitFor(() => expect(getQueueSize(CommandLane.Cron)).toBe(0), { timeout: 5_000 });
    },
    () => heartbeatRunner.stop(),
  );
}

describe("main cron with the real heartbeat runner", () => {
  it("settles a busy routeless monitor without delaying restart", async () => {
    vi.useFakeTimers();
    const sandbox = makeSandbox();
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: sandbox.dir } },
      session: { store: sandbox.sessionStorePath },
    };
    const getReply = vi.fn().mockResolvedValue({ text: "unexpected heartbeat" });
    const sendTelegram = vi.fn();
    const attempts: Awaited<ReturnType<typeof runHeartbeatOnce>>[] = [];
    const heartbeatRunner = startHeartbeatRunner({
      cfg,
      runOnce: async (opts) => {
        const result = await runHeartbeatOnce({
          ...opts,
          cfg,
          deps: { getReplyFromConfig: getReply, telegram: sendTelegram },
        });
        attempts.push(result);
        return result;
      },
    });
    const events: CronEvent[] = [];
    const requested = createDeferred();
    const finished = createDeferred<CronEvent>();
    const deps: CronServiceDeps = {
      scheduler: createTestGatewayScheduler("fake-timers"),
      storePath: sandbox.cronStorePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: queueHeartbeat,
      requestHeartbeatAndWait: (wake, lifecycle) => {
        const pending = requestHeartbeatAndWait({ ...wake, coalesceMs: 0 }, lifecycle);
        requested.resolve();
        return pending;
      },
      resolveHeartbeatTimeoutMs: () => 100,
      runIsolatedAgentJob: vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
        status: "ok",
      })),
      onEvent: (event) => {
        events.push(structuredClone(event));
        if (event.action === "finished") {
          finished.resolve(event);
        }
      },
    };
    const foreground = createDeferred();
    const foregroundRun = enqueueCommandInLane(CommandLane.Main, () => foreground.promise);
    let cron = new CronService(deps);
    try {
      await cron.start();
      const everyMs = 30 * 60_000;
      const job = await cron.add(
        {
          declarationKey: "heartbeat:main",
          name: "heartbeat-main",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs, anchorMs: Date.now() + 250 },
          payload: { kind: "heartbeat" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        },
        { enabledExplicit: true, systemOwned: true },
      );
      // Finish this tick before admission registers its zero-delay wake timer.
      vi.advanceTimersByTime(job.state.nextRunAtMs! - Date.now());
      await requested.promise;
      await vi.advanceTimersByTimeAsync(0);
      await expect(finished.promise).resolves.toMatchObject({
        jobId: job.id,
        status: "skipped",
        error: "heartbeat skipped: requests-in-flight",
      });
      expect(attempts).toEqual([{ status: "skipped", reason: "requests-in-flight" }]);
      const completed = cron.getJob(job.id)!;
      expect(completed.state.runningAtMs).toBeUndefined();
      expect(completed.state.consecutiveErrors).toBe(0);
      expect(completed.state.nextRunAtMs).toBe(job.state.nextRunAtMs! + everyMs);
      await expect(waitForActiveCronJobs(0)).resolves.toEqual({ drained: true, active: 0 });

      cron.stop();
      cron = new CronService(deps);
      await cron.start();
      const restored = cron.getJob(job.id)!;
      expect(restored.state).toEqual(completed.state);
      expect(events.filter((event) => event.action === "finished")).toHaveLength(1);

      // A finished ambient poll leaves no retry or cron run to delay shutdown.
      foreground.resolve();
      await foregroundRun;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toHaveLength(1);
      expect(events.filter((event) => event.action === "finished")).toHaveLength(1);
      expect(getReply).not.toHaveBeenCalled();
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      foreground.resolve();
      await foregroundRun;
      cron.stop();
      heartbeatRunner.stop();
      await vi.waitFor(() => expect(getActiveCronJobCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("keeps an operator-disabled one-shot disabled after a queued force run while heartbeats are paused", async () => {
    await runMainCronCase("queued", "now", {
      heartbeatPaused: true,
      disableBeforeRun: true,
      deleteAfterRun: false,
    });
  });

  it.each(["direct", "scheduled"] as const)(
    "preserves an enabled one-shot's schedule policy after a %s run while heartbeats are globally paused",
    async (mode) => {
      await runMainCronCase(mode, "now", { heartbeatPaused: true, deleteAfterRun: false });
    },
  );

  it("drains coalesced cron and exec work without recurrence while retaining late arrivals", async () => {
    await runMainCronCase("scheduled", "now", {
      deleteAfterRun: true,
      mixedExec: true,
    });
  });
  it("delivers before a command-lane queued run finishes", async () => {
    await runMainCronCase("queued");
  });

  it("delivers a next-heartbeat event through a later scheduled main-session heartbeat", async () => {
    await runMainCronCase("direct", "next-heartbeat");
  });

  it("keeps a transient isolated heartbeat successful without creating an orphan outcome", async () => {
    const result = await runMainCronCase("direct", "now", {
      transientSession: true,
    });
    if (!result) {
      throw new Error("expected completed cron run");
    }
    const sessionKey = result.expectedMainSessionKey;
    const db = openOpenClawAgentDatabase(
      toDatabaseOptions(
        resolveSqliteScope({
          agentId: "main",
          sessionKey,
          storePath: result.sandbox.sessionStorePath,
        }),
      ),
    ).db;

    expect(result.terminal.status).toBe("ok");
    const session = db.prepare("SELECT session_key FROM session_nodes WHERE session_key = ?");
    expect(session.get(sessionKey)).toBeUndefined();
    expect(session.get(`${sessionKey}:heartbeat`)).toEqual({
      session_key: `${sessionKey}:heartbeat`,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM heartbeat_outcomes").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("drains an in-flight heartbeat before disposing it after a fixture failure", async () => {
    const replyStarted = createDeferred<AbortSignal>();
    const releaseReply = createDeferred();
    const cleanupStarted = createDeferred();
    const bodyError = new Error("fixture body failed");
    let stopHeartbeat: (() => void) | undefined;
    const outcome = runMainCronCase("queued", "now", {}, async (fixture) => {
      const { cron, heartbeatRunner, getReplySpy } = fixture;
      vi.spyOn(heartbeatRunner, "stop");
      stopHeartbeat = heartbeatRunner.stop;
      const stopCron = cron.stop.bind(cron);
      vi.spyOn(cron, "stop").mockImplementation(() => {
        stopCron();
        cleanupStarted.resolve();
      });
      getReplySpy.mockImplementationOnce(async () => {
        const signal = getHeartbeatWakeAbortSignal();
        if (!signal) {
          throw new Error("expected the real heartbeat wake signal");
        }
        replyStarted.resolve(signal);
        await releaseReply.promise;
        return { text: "Handled the reminder" };
      });
      const job = await cron.add({
        enabled: true,
        name: "fixture cleanup",
        schedule: { kind: "at", at: new Date(Date.now() + 60 * 60_000).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Reminder: Finish before fixture cleanup" },
      });
      await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
        ok: true,
        enqueued: true,
      });
      await withTestTimeout(
        replyStarted.promise,
        10_000,
        "real heartbeat did not reach the reply gate",
      );
      expect(getActiveCronJobCount()).toBe(1);
      expect(getQueueSize(CommandLane.Cron)).toBe(1);
      throw bodyError;
    }).catch((error: unknown) => error);
    const fixtureFailure = outcome.then((error) => {
      throw error;
    });
    try {
      await Promise.race([cleanupStarted.promise, fixtureFailure]);
      const signal = await Promise.race([replyStarted.promise, fixtureFailure]);
      const abortedDuringDrain = signal.aborted;
      releaseReply.resolve();
      const error = await outcome;
      expect(abortedDuringDrain).toBe(false);
      expect(error).toBe(bodyError);
      expect(getActiveCronJobCount()).toBe(0);
      expect(getQueueSize(CommandLane.Cron)).toBe(0);
      expect(stopHeartbeat).toHaveBeenCalledOnce();
    } finally {
      releaseReply.resolve();
      await outcome;
    }
  });
});
