import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, type OpenClawConfig } from "../config/config.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import {
  runHeartbeatOnce,
  setHeartbeatsEnabled,
  startHeartbeatRunner,
} from "./heartbeat-runner.js";
import {
  heartbeatTestConfig,
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import {
  HEARTBEAT_SKIP_NO_PENDING_EVENT,
  requestHeartbeat,
  setHeartbeatWakeHandler as setRuntimeHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

describe("stale exec heartbeat wakes", () => {
  type WakeRequest = Parameters<typeof requestHeartbeat>[0];
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let currentHandlerDisposer: (() => void) | undefined;
  const ran = { status: "ran", durationMs: 1 } as const;
  const stale = { status: "skipped", reason: HEARTBEAT_SKIP_NO_PENDING_EVENT } as const;
  const execWake = { source: "exec-event", intent: "event", reason: "exec-event" } as const;
  const heartbeatConfig = (every = "30m"): OpenClawConfig => ({
    agents: { defaults: { heartbeat: { every } } },
  });
  const requestExec = (overrides: Partial<WakeRequest> = {}) =>
    requestHeartbeat({ ...execWake, agentId: "main", coalesceMs: 0, ...overrides });
  function startRunner() {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runSpy = vi.fn().mockResolvedValue(ran);
    return { runSpy, runner: startHeartbeatRunner({ cfg: heartbeatConfig(), runOnce: runSpy }) };
  }
  function heartbeatCase(
    test: (fixture: {
      sessionKey: string;
      replySpy: Parameters<Parameters<typeof withTempHeartbeatSandbox>[0]>[0]["replySpy"];
      run: (
        options?: Partial<Parameters<typeof runHeartbeatOnce>[0]>,
      ) => ReturnType<typeof runHeartbeatOnce>;
    }) => Promise<void>,
  ) {
    return () =>
      withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
        const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "-100155462274",
        });
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
        await test({
          sessionKey,
          replySpy,
          run: (options = {}) =>
            runHeartbeatOnce({
              cfg,
              agentId: "main",
              ...execWake,
              deps: { getReplyFromConfig: replySpy },
              ...options,
            }),
        });
      });
  }
  beforeEach(() => {
    setupTelegramHeartbeatPluginRuntimeForTests();
    resetSystemEventsForTest();
    resetGatewayWorkAdmission();
  });
  afterEach(async () => {
    currentHandlerDisposer?.();
    if (vi.isFakeTimers()) {
      currentHandlerDisposer = setRuntimeHeartbeatWakeHandler(async () => ({
        status: "skipped",
        reason: "disabled",
      }));
      await vi.runAllTimersAsync();
    }
    currentHandlerDisposer?.();
    currentHandlerDisposer = undefined;
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    resetGatewayWorkAdmission();
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
    setHeartbeatsEnabled(true);
    envSnapshot.restore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retires a stale exec event without retrying or dropping coalesced task work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi.fn(async (request: WakeRequest) =>
      request.intent === "event" ? stale : ran,
    );
    currentHandlerDisposer = setRuntimeHeartbeatWakeHandler(handler);
    requestExec();
    const tasks = [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }];
    requestHeartbeat({
      source: "interval",
      intent: "task",
      reason: "heartbeat-task:job-inbox",
      agentId: "main",
      tasks,
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(handler.mock.calls.map(([request]) => request.intent)).toEqual(["task", "event"]);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ intent: "task", tasks });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("passes persisted cadence through an unscoped coalesced exec wake", async () => {
    const { runSpy, runner } = startRunner();
    requestHeartbeat({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      scheduledEveryMs: 5 * 60_000,
      coalesceMs: 100,
    });
    requestExec({ agentId: undefined, coalesceMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(runSpy).toHaveBeenCalledOnce();
    expect(runSpy.mock.calls[0]?.[0]).toMatchObject({
      ...execWake,
      scheduledEveryMs: 5 * 60_000,
      heartbeat: { every: "300000ms" },
    });
    runner.stop();
  });

  it(
    "keeps a scheduled turn alive when an acknowledged exec wake coalesces with it",
    heartbeatCase(async ({ sessionKey, replySpy, run }) => {
      enqueueSystemEvent("Unrelated queued event", { sessionKey });
      const telegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });
      expect(
        (
          await run({
            scheduledEveryMs: 5 * 60_000,
            deps: { getReplyFromConfig: replySpy, telegram },
          })
        ).status,
      ).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
      expect(peekSystemEvents(sessionKey)).toEqual(["Unrelated queued event"]);
    }),
  );

  it(
    "keeps tagged cron work alive when an exec wake is coalesced",
    heartbeatCase(async ({ sessionKey, replySpy, run }) => {
      enqueueSystemEvent("Reminder: Check the overnight report", {
        sessionKey,
        contextKey: "cron:overnight-report",
      });
      expect((await run()).status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    }),
  );

  it(
    "retires a stale exec wake before retryable busy gates",
    heartbeatCase(async ({ run }) => {
      expect(await run({ deps: { getQueueSize: () => 1 } })).toEqual(stale);
    }),
  );

  it.each([{ guard: "min-spacing", runs: 1, delay: 30_000 }])(
    "does not move cadence when a stale exec wake defers for $guard",
    async ({ runs, delay }) => {
      const { runSpy, runner } = startRunner();
      for (let index = 0; index < runs; index += 1) {
        requestHeartbeat({
          source: "manual",
          intent: "manual",
          reason: "manual",
          agentId: "main",
          coalesceMs: 0,
        });
        await vi.advanceTimersByTimeAsync(1);
      }
      runSpy.mockResolvedValueOnce(stale);
      await vi.advanceTimersByTimeAsync(100 - runs);
      runner.updateConfig(heartbeatConfig("5m"));
      await vi.advanceTimersByTimeAsync(1);
      requestExec();
      await vi.advanceTimersByTimeAsync(1);
      expect(runSpy).toHaveBeenCalledTimes(runs);
      await vi.advanceTimersByTimeAsync(delay);
      expect(runSpy).toHaveBeenCalledTimes(runs + 1);
      runner.stop();
    },
  );

  it("does not record cooldown bookkeeping for an acknowledged exec wake", async () => {
    const { runSpy, runner } = startRunner();
    runSpy.mockResolvedValueOnce(stale);
    requestExec({ agentId: undefined, sessionKey: "agent:main:main" });
    await vi.advanceTimersByTimeAsync(1);
    requestExec({ agentId: undefined, sessionKey: "agent:main:main" });
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy).toHaveBeenCalledTimes(2);
    runner.stop();
  });
});
