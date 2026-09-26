import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
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
  type WakeHandler = Parameters<typeof setRuntimeHeartbeatWakeHandler>[0];
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let currentHandlerDisposer: (() => void) | undefined;

  function setHeartbeatWakeHandler(handler: WakeHandler): void {
    currentHandlerDisposer?.();
    currentHandlerDisposer = setRuntimeHeartbeatWakeHandler(handler);
  }

  function heartbeatConfig(every = "30m"): OpenClawConfig {
    return {
      agents: {
        defaults: { heartbeat: { every } },
      },
    } as OpenClawConfig;
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
      request.intent === "event"
        ? ({ status: "skipped", reason: HEARTBEAT_SKIP_NO_PENDING_EVENT } as const)
        : ({ status: "ran", durationMs: 1 } as const),
    );
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 0,
    });
    requestHeartbeat({
      source: "interval",
      intent: "task",
      reason: "heartbeat-task:job-inbox",
      agentId: "main",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(handler.mock.calls.map(([request]) => request.intent)).toEqual(["task", "event"]);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      intent: "task",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("preserves scheduled cadence when an exec wake joins the scheduled turn", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: "main",
      scheduledEveryMs: 5 * 60_000,
      coalesceMs: 100,
    });
    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      scheduledEveryMs: 5 * 60_000,
    });
  });

  it("passes persisted cadence through a coalesced exec wake", async () => {
    vi.useFakeTimers();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
    });

    requestHeartbeat({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: "main",
      scheduledEveryMs: 5 * 60_000,
      coalesceMs: 100,
    });
    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "exec-event",
        scheduledEveryMs: 5 * 60_000,
      }),
    );
    runner.stop();
  });

  it("keeps a scheduled turn alive when an acknowledged exec wake coalesces with it", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });
      enqueueSystemEvent("Unrelated queued event", { sessionKey });

      const getReplyFromConfig = vi.fn().mockResolvedValue({ text: "HEARTBEAT_OK" });
      const telegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        scheduledEveryMs: 5 * 60_000,
        deps: {
          getReplyFromConfig,
          telegram,
        },
      });
      expect(result.status).toBe("ran");
      expect(getReplyFromConfig).toHaveBeenCalledOnce();
      expect(peekSystemEvents(sessionKey)).toEqual(["Unrelated queued event"]);
    });
  });

  it("keeps tagged cron work alive when an exec wake is coalesced", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });
      enqueueSystemEvent("Reminder: Check the overnight report", {
        sessionKey,
        contextKey: "cron:overnight-report",
      });

      const getReplyFromConfig = vi.fn().mockResolvedValue({ text: "HEARTBEAT_OK" });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig },
      });

      expect(result.status).toBe("ran");
      expect(getReplyFromConfig).toHaveBeenCalledOnce();
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    });
  });

  it("retires a stale exec wake before retryable busy gates", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getQueueSize: () => 1 },
      });

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_NO_PENDING_EVENT });
    });
  });

  it("passes persisted cadence through an unscoped coalesced exec wake", async () => {
    vi.useFakeTimers();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
    });

    requestHeartbeat({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      scheduledEveryMs: 5 * 60_000,
      coalesceMs: 100,
    });
    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      coalesceMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);

    const [options] = runSpy.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      source: "exec-event",
      scheduledEveryMs: 5 * 60_000,
      heartbeat: { every: "300000ms" },
    });
    runner.stop();
  });

  it("does not move cadence when a stale exec wake defers for min-spacing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 })
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_NO_PENDING_EVENT })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
    });

    requestHeartbeat({
      source: "manual",
      intent: "manual",
      reason: "manual",
      agentId: "main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(99);
    runner.updateConfig(heartbeatConfig("5m"));
    await vi.advanceTimersByTimeAsync(1);

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(runSpy).toHaveBeenCalledTimes(2);
    runner.stop();
  });

  it("does not move cadence when a stale exec wake defers for flood", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 })
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_NO_PENDING_EVENT })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
    });

    for (let index = 0; index < 5; index += 1) {
      requestHeartbeat({
        source: "manual",
        intent: "manual",
        reason: "manual",
        agentId: "main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(95);
    runner.updateConfig(heartbeatConfig("5m"));
    await vi.advanceTimersByTimeAsync(1);

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(runSpy).toHaveBeenCalledTimes(6);
    runner.stop();
  });

  it("does not record cooldown bookkeeping for an acknowledged exec wake", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_NO_PENDING_EVENT })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
    });

    const requestExecWake = () =>
      requestHeartbeat({
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      });
    requestExecWake();
    await vi.advanceTimersByTimeAsync(1);
    requestExecWake();
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(2);
    runner.stop();
  });
  it.each([
    { remaining: "none", expectedSource: undefined, failure: "none" },
    { remaining: "exec", expectedSource: "exec", failure: "none" },
    { remaining: "exec", expectedSource: "exec", failure: "dispatch" },
    { remaining: "exec", expectedSource: "exec", failure: "delivery" },
    { remaining: "cron", expectedSource: "cron", failure: "none" },
    { remaining: "cadence", expectedSource: "heartbeat", failure: "none" },
    { remaining: "task", expectedSource: "heartbeat", failure: "none" },
  ] as const)(
    "revalidates acknowledged completions with $remaining work and $failure failure",
    async ({ remaining, expectedSource, failure }) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "telegram" } },
          },
          channels: { telegram: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "-100155462274",
        });
        const completed = "Exec completed (first-job, code 0) :: already observed";
        const acknowledge = enqueueSystemEventWithReceipt(completed, { sessionKey });
        const survivingEvent =
          remaining === "exec"
            ? "Exec completed (second-job, code 0) :: unobserved result"
            : remaining === "cron"
              ? "Reminder: Check the overnight report"
              : undefined;
        if (survivingEvent) {
          enqueueSystemEvent(survivingEvent, {
            sessionKey,
            ...(remaining === "cron" ? { contextKey: "cron:overnight" } : {}),
          });
        }
        enqueueSystemEvent("Unrelated queued event", { sessionKey });
        const original = peekSystemEventEntries(sessionKey);
        const resolveTarget = heartbeatTargets.resolveHeartbeatDeliveryTargetWithSessionRoute;
        vi.spyOn(
          heartbeatTargets,
          "resolveHeartbeatDeliveryTargetWithSessionRoute",
        ).mockImplementationOnce(async (...args) => {
          const route = await resolveTarget(...args);
          expect(acknowledge?.()).toBe(true);
          // Same-text successor must not inherit the acknowledged occurrence's selection.
          enqueueSystemEvent(completed, { sessionKey });
          expect(peekSystemEventEntries(sessionKey).at(-1)?.id).not.toBe(original[0]?.id);
          return route;
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
          if (failure === "dispatch") {
            throw new Error("Synthetic dispatch failure");
          }
          return { text: failure === "delivery" ? "Remaining command completed" : "HEARTBEAT_OK" };
        });
        const result = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          ...(remaining === "cadence" ? { scheduledEveryMs: 5 * 60_000 } : {}),
          ...(remaining === "task"
            ? { tasks: [{ jobId: "inbox", name: "Inbox", prompt: "Check the task inbox" }] }
            : {}),
          deps: { getReplyFromConfig: replySpy, telegram },
        });
        if (remaining === "none") {
          expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_NO_PENDING_EVENT });
          expect(replySpy).not.toHaveBeenCalled();
        } else if (failure !== "none") {
          expect(result).toMatchObject({
            status: "failed",
            reason:
              failure === "dispatch" ? "Synthetic dispatch failure" : "Synthetic delivery failure",
          });
          expect(replySpy).toHaveBeenCalledOnce();
          if (failure === "delivery") {
            expect(telegram).toHaveBeenCalledOnce();
          }
        } else {
          expect(result.status).toBe("ran");
          expect(replySpy).toHaveBeenCalledOnce();
        }
        expect(peekSystemEvents(sessionKey)).toEqual([
          ...(failure !== "none" ? [survivingEvent] : []),
          "Unrelated queued event",
          completed,
        ]);
      });
    },
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
        const resolveTarget = heartbeatTargets.resolveHeartbeatDeliveryTargetWithSessionRoute;
        vi.spyOn(
          heartbeatTargets,
          "resolveHeartbeatDeliveryTargetWithSessionRoute",
        ).mockImplementationOnce(async (...args) => {
          const target = await resolveTarget(...args);
          expect(acknowledge?.()).toBe(true);
          return target;
        });
        replySpy.mockResolvedValue({ text: "Reminder handled" });
        const telegram = vi.fn().mockResolvedValue({ messageId: "1", chatId: "-100222" });
        const run = () =>
          runHeartbeatOnce({
            cfg,
            agentId: "main",
            source: "exec-event",
            intent: "event",
            reason: "exec-event",
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
});
