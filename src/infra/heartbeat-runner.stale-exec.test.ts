import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { resetConfigRuntimeState, type OpenClawConfig } from "../config/config.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { CommandLane } from "../process/lanes.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import {
  runHeartbeatOnce,
  setHeartbeatsEnabled,
  startHeartbeatRunner,
} from "./heartbeat-runner.js";
import {
  getFirstReplyContext,
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
import * as heartbeatTargets from "./outbound/targets.js";
import {
  enqueueSystemEvent,
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

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
  // Routing is the awaited preparation step where a process poll can acknowledge a completion.
  function acknowledgeDuringRouting(acknowledge: () => void) {
    const resolveTarget = heartbeatTargets.resolveHeartbeatDeliveryTargetWithSessionRoute;
    vi.spyOn(
      heartbeatTargets,
      "resolveHeartbeatDeliveryTargetWithSessionRoute",
    ).mockImplementationOnce(async (...args) => {
      const route = await resolveTarget(...args);
      acknowledge();
      return route;
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

  it.each([
    { remaining: "none", expectedSource: undefined, failure: "none" },
    { remaining: "exec", expectedSource: "exec", failure: "none" },
    { remaining: "exec", expectedSource: "exec", failure: "delivery" },
    { remaining: "cadence", expectedSource: "heartbeat", failure: "none" },
    { remaining: "task", expectedSource: "heartbeat", failure: "none" },
  ] as const)(
    "revalidates acknowledged completions with $remaining work and $failure failure",
    ({ remaining, expectedSource, failure }) =>
      heartbeatCase(async ({ sessionKey, replySpy, run }) => {
        const completed = "Exec completed (first-job, code 0) :: already observed";
        const acknowledge = enqueueSystemEventWithReceipt(completed, { sessionKey });
        const survivingEvent =
          remaining === "exec"
            ? "Exec completed (second-job, code 0) :: unobserved result"
            : undefined;
        if (survivingEvent) {
          enqueueSystemEvent(survivingEvent, { sessionKey });
        }
        enqueueSystemEvent("Unrelated queued event", { sessionKey });
        const original = peekSystemEventEntries(sessionKey);
        acknowledgeDuringRouting(() => {
          expect(acknowledge?.()).toBe(true);
          // Same-text successor must not inherit the acknowledged occurrence's selection.
          enqueueSystemEvent(completed, { sessionKey });
          expect(peekSystemEventEntries(sessionKey).at(-1)?.id).not.toBe(original[0]?.id);
        });
        const telegram = vi.fn().mockRejectedValue(new Error("Synthetic delivery failure"));
        replySpy.mockImplementation(async (ctx) => {
          expect(ctx.Body).not.toContain(completed);
          expect(ctx.InternalTurnSource).toBe(expectedSource);
          if (survivingEvent) {
            expect(ctx.Body).toContain(survivingEvent);
          }
          if (remaining === "task") {
            expect(ctx.Body).toContain("Check the task inbox");
          }
          // Selection is read-only until the result is handled successfully.
          expect(peekSystemEvents(sessionKey)).toContain(completed);
          if (survivingEvent) {
            expect(peekSystemEvents(sessionKey)).toContain(survivingEvent);
          }
          return { text: failure === "delivery" ? "Remaining command completed" : "HEARTBEAT_OK" };
        });
        const result = await run({
          ...(remaining === "cadence" ? { scheduledEveryMs: 5 * 60_000 } : {}),
          ...(remaining === "task"
            ? { tasks: [{ jobId: "inbox", name: "Inbox", prompt: "Check the task inbox" }] }
            : {}),
          deps: { getReplyFromConfig: replySpy, telegram },
        });
        if (remaining === "none") {
          expect(result).toEqual(stale);
          expect(replySpy).not.toHaveBeenCalled();
        } else if (failure === "delivery") {
          expect(result).toMatchObject({ status: "failed", reason: "Synthetic delivery failure" });
          expect(replySpy).toHaveBeenCalledOnce();
          expect(telegram).toHaveBeenCalledOnce();
        } else {
          expect(result.status).toBe("ran");
          expect(replySpy).toHaveBeenCalledOnce();
        }
        expect(peekSystemEvents(sessionKey)).toEqual([
          ...(failure === "delivery" ? [survivingEvent] : []),
          "Unrelated queued event",
          completed,
        ]);
      })(),
  );

  it.each(["internal", "event-route", "explicit-target"] as const)(
    "keeps remaining cron delivery independent of consumed exec with %s",
    async (route) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: route === "explicit-target" ? "telegram" : "last",
                ...(route === "explicit-target" ? { to: "-100333" } : {}),
              },
            },
          },
          channels: { telegram: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: route === "internal" ? "webchat" : "telegram",
          lastProvider: route === "internal" ? "" : "telegram",
          lastTo: route === "internal" ? "" : "-100333",
          createdVia: "operator",
        });
        const reminder = "Reminder: Check the overnight report";
        enqueueSystemEvent(reminder, {
          sessionKey,
          contextKey: "cron:overnight",
          ...(route !== "internal"
            ? { deliveryContext: { channel: "telegram", to: "-100222" } }
            : {}),
        });
        const acknowledge = enqueueSystemEventWithReceipt(
          "Exec completed (observed-job, code 0) :: already observed",
          {
            sessionKey,
            ...(route !== "internal"
              ? { deliveryContext: { channel: "telegram", to: "-100111" } }
              : {}),
          },
        );
        acknowledgeDuringRouting(() => expect(acknowledge?.()).toBe(true));
        replySpy.mockResolvedValue({ text: "Reminder handled" });
        const telegram = vi.fn().mockResolvedValue({ messageId: "1", chatId: "-100222" });
        const run = () =>
          runHeartbeatOnce({
            cfg,
            agentId: "main",
            ...execWake,
            deps: { getReplyFromConfig: replySpy, telegram },
          });
        const result = await run();
        if (route === "event-route") {
          expect(result).toMatchObject({ status: "skipped", reason: "preempted" });
          expect(replySpy).not.toHaveBeenCalled();
          expect(telegram).not.toHaveBeenCalled();
          expect(peekSystemEvents(sessionKey)).toEqual([reminder]);
          expect((await run()).status).toBe("ran");
        } else {
          expect(result.status).toBe("ran");
        }
        expect(replySpy).toHaveBeenCalledOnce();
        const context = replySpy.mock.calls[0]?.[0];
        expect(context?.InternalTurnSource).toBe("cron");
        if (route === "internal") {
          const events = await loadTranscriptEvents({
            agentId: "main",
            sessionKey,
            sessionId: "sid",
            storePath,
          });
          expect(
            events
              .map(readTranscriptEventMessage)
              .filter((message) => message?.role === "assistant"),
          ).toEqual([]);
          expect(context?.Body).not.toContain("Please relay this reminder to the user");
          expect(telegram).not.toHaveBeenCalled();
        } else {
          expect(context?.OriginatingTo).toBe(route === "event-route" ? "-100222" : "-100333");
          expect(telegram).toHaveBeenCalledOnce();
          expect(telegram.mock.calls[0]?.[0]).toBe(route === "event-route" ? "-100222" : "-100333");
        }
        expect(peekSystemEvents(sessionKey)).toEqual([]);
      });
    },
  );

  it("rebuilds routing when an acknowledged WebChat completion leaves only cadence", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "telegram", to: "-100333" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
        createdVia: "operator",
      });
      const acknowledge = enqueueSystemEventWithReceipt(
        "Exec completed (observed-job, code 0) :: already observed",
        { sessionKey },
      );
      // The completion chose the session-only route; the joined cadence tick owns the target.
      acknowledgeDuringRouting(() => expect(acknowledge?.()).toBe(true));
      replySpy.mockResolvedValue({ text: "Disk usage alert" });
      const telegram = vi.fn().mockResolvedValue({ messageId: "1", chatId: "-100333" });
      const run = () =>
        runHeartbeatOnce({
          cfg,
          agentId: "main",
          ...execWake,
          scheduledEveryMs: 5 * 60_000,
          deps: { getReplyFromConfig: replySpy, telegram },
        });
      const preempted = await run();
      expect(preempted).toMatchObject({ status: "skipped", reason: "preempted" });
      // Only routing changed, so the wake owner may retry at once.
      expect(preempted.status === "skipped" ? preempted.retryAtMs : undefined).toBeLessThanOrEqual(
        Date.now(),
      );
      expect(replySpy).not.toHaveBeenCalled();
      expect((await run()).status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
      expect(telegram.mock.calls.map(([to]) => to)).toEqual(["-100333"]);
    });
  });

  it(
    "returns surviving cron work to busy guards once the admitting completion is acknowledged",
    heartbeatCase(async ({ sessionKey, replySpy, run }) => {
      const reminder = "Reminder: Check the overnight report";
      enqueueSystemEvent(reminder, { sessionKey, contextKey: "cron:overnight" });
      const acknowledge = enqueueSystemEventWithReceipt(
        "Exec completed (observed-job, code 0) :: already observed",
        { sessionKey },
      );
      // The session's own completion admitted this wake past the busy main lane.
      acknowledgeDuringRouting(() => expect(acknowledge?.()).toBe(true));
      const deps = {
        getReplyFromConfig: replySpy,
        getQueueSize: (lane?: string) => (lane === CommandLane.Main ? 1 : 0),
      };
      expect(await run({ sessionKey, deps })).toMatchObject({
        status: "skipped",
        reason: "preempted",
      });
      expect(await run({ sessionKey, deps })).toEqual({
        status: "skipped",
        reason: "requests-in-flight",
      });
      expect(replySpy).not.toHaveBeenCalled();
      expect(peekSystemEvents(sessionKey)).toEqual([reminder]);
    }),
  );

  it("keeps restart custody in the WebChat session when a joined completion is acknowledged", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "0m", target: "telegram", to: "-100333" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        messages: { visibleReplies: "message_tool" },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
        lifecycleRevision: "restart-generation",
        createdVia: "operator",
      });
      enqueueSystemEvent("Gateway restarted. Continue the interrupted turn.", {
        sessionKey,
        contextKey: "task:restart-sentinel:queue-1",
      });
      const completed = "Exec completed (observed-job, code 0) :: already observed";
      const acknowledge = enqueueSystemEventWithReceipt(completed, { sessionKey });
      acknowledgeDuringRouting(() => expect(acknowledge?.()).toBe(true));
      const marker = "RESTART_CONTINUATION_STAYS_HOME";
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: true,
          summary: "private",
          notificationText: marker,
        }),
      );
      const telegram = vi.fn();
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "restart-sentinel",
        intent: "immediate",
        reason: "wake",
        deps: { getReplyFromConfig: replySpy, telegram },
      });
      expect(result.status).toBe("ran");
      expect(getFirstReplyContext(replySpy).Body).not.toContain(completed);
      expect(telegram).not.toHaveBeenCalled();
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionKey,
        sessionId: "sid",
        storePath,
      });
      expect(
        events
          .map(readTranscriptEventMessage)
          .filter(
            (message) =>
              message?.role === "assistant" && JSON.stringify(message.content).includes(marker),
          ),
      ).toHaveLength(1);
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    });
  });
});
