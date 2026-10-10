import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getRuntimeConfig,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { createCronServiceState } from "../cron/service/state.js";
import { wake as wakeCronService } from "../cron/service/wake.js";
import { GatewayScheduler } from "./gateway-scheduler.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { heartbeatLog } from "./heartbeat-log.js";
import { startHeartbeatRunner } from "./heartbeat-runner-scheduler.js";
import * as heartbeatWake from "./heartbeat-wake.js";
import {
  getHeartbeatWakeAbortSignal,
  HEARTBEAT_SKIP_PREEMPTED,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeat,
  setHeartbeatsEnabled,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

type RunnerOptions = Parameters<typeof startHeartbeatRunner>[0];
type RunOnce = NonNullable<RunnerOptions["runOnce"]>;
type Wake = Parameters<typeof requestHeartbeat>[0];
const runSpy = vi.fn<RunOnce>();
const runners: ReturnType<typeof startHeartbeatRunner>[] = [];
const sessionKey = "agent:main:main";
const execWake: Wake = { source: "exec-event", intent: "event", reason: "exec-event", sessionKey };
const cronWake: Wake = {
  source: "cron",
  intent: "immediate",
  reason: "cron:one-shot",
  agentId: "main",
};
const backgroundWake: Wake = {
  source: "background-task",
  intent: "immediate",
  reason: "background-task",
  sessionKey,
};
const taskWake: Wake = {
  source: "interval",
  intent: "task",
  reason: "heartbeat-task:job-inbox",
  agentId: "main",
  tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
};

function config(
  every = "30m",
  entries?: NonNullable<OpenClawConfig["agents"]>["entries"],
): OpenClawConfig {
  return { agents: { defaults: { heartbeat: { every } }, ...(entries ? { entries } : {}) } };
}

function start(cfg = config(), options: Omit<RunnerOptions, "cfg"> = {}) {
  const runner = startHeartbeatRunner({ cfg, runOnce: runSpy, ...options });
  runners.push(runner);
  return runner;
}

async function wake(request: Wake) {
  requestHeartbeat({ ...request, coalesceMs: 0 });
  await vi.advanceTimersByTimeAsync(1);
}

function interval(agentId = "main", scheduledEveryMs = 30 * 60_000) {
  return wake({
    source: "interval",
    intent: "scheduled",
    reason: "interval",
    agentId,
    scheduledEveryMs,
  });
}

function expectRun(index: number, expected: Partial<Parameters<RunOnce>[0]>) {
  expect(runSpy).toHaveBeenNthCalledWith(index + 1, expect.objectContaining(expected));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  resetHeartbeatEventsForTest();
  runSpy.mockReset().mockResolvedValue({ status: "ran", durationMs: 1 });
});

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    runner.stop();
  }
  // Disposed runners retain queued work for their successor; drain it between tests.
  const dispose = setHeartbeatWakeHandler(async () => ({ status: "skipped", reason: "disabled" }));
  await vi.runAllTimersAsync();
  dispose();
  setHeartbeatsEnabled(true);
  resetSystemEventsForTest();
  resetHeartbeatEventsForTest();
  resetConfigRuntimeState();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startHeartbeatRunner", () => {
  it("starts stopped when its owner signal is already aborted", async () => {
    const owner = new AbortController();
    owner.abort();
    start(config(), { abortSignal: owner.signal });
    await wake({ source: "manual", intent: "manual", reason: "manual" });
    expect(runSpy).not.toHaveBeenCalled();
    const drain = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" });
    const dispose = setHeartbeatWakeHandler(drain);
    await vi.advanceTimersByTimeAsync(250);
    expect(drain).toHaveBeenCalledOnce();
    dispose();
  });

  it("aborts an active wake when the runner stops", async () => {
    const pending = createDeferred();
    let signal: AbortSignal | undefined;
    runSpy.mockImplementation(async () => {
      signal = getHeartbeatWakeAbortSignal();
      await pending.promise;
      return { status: "ran", durationMs: 1 };
    });
    const runner = start();
    await wake({ source: "manual", intent: "manual", reason: "manual", sessionKey });
    expect(signal?.aborted).toBe(false);
    runner.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(true);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const drain = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" });
    const dispose = setHeartbeatWakeHandler(drain);
    await vi.advanceTimersByTimeAsync(250);
    expect(drain).toHaveBeenCalledOnce();
    dispose();
  });

  it("keeps persisted monitor cadence authoritative when its tick joins a task turn", async () => {
    start();
    requestHeartbeat({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: "main",
      scheduledEveryMs: 5 * 60_000,
      coalesceMs: 100,
    });
    requestHeartbeat({ ...taskWake, coalesceMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(runSpy).toHaveBeenCalledOnce();
    expectRun(0, { intent: "task", tasks: taskWake.tasks, heartbeat: { every: "300000ms" } });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await wake({ ...execWake, agentId: "main", sessionKey: undefined });
    expect(runSpy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it("notifies the normal-cycle observer only after a scheduled interval run", async () => {
    const observer = vi.fn();
    start(config(), { onNormalCycle: observer });
    await wake({ source: "manual", intent: "manual", reason: "manual" });
    expect(observer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await wake({ source: "interval", intent: "scheduled", reason: "interval" });
    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith({ agentIds: ["main"], durationMs: expect.any(Number) });
  });

  it("notifies the normal-cycle observer for a targeted scheduled interval run", async () => {
    const observer = vi.fn();
    start(config(), { onNormalCycle: observer });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await interval("main");
    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith({ agentIds: ["main"], durationMs: expect.any(Number) });
  });

  it("reads the latest runtime config for heartbeat wakes after no-op reload commits", async () => {
    const initialConfig: OpenClawConfig = {
      ...config(),
      messages: { visibleReplies: "automatic" },
    };
    const nextConfig: OpenClawConfig = {
      ...config(),
      messages: { visibleReplies: "message_tool" },
    };
    setRuntimeConfigSnapshot(initialConfig, initialConfig);
    start(initialConfig, { readCurrentConfig: getRuntimeConfig });
    setRuntimeConfigSnapshot(nextConfig, nextConfig);
    await wake({ source: "manual", intent: "manual", reason: "manual" });
    expect(runSpy).toHaveBeenCalledOnce();
    expectRun(0, { cfg: nextConfig, heartbeat: { every: "30m" } });
  });

  it("does not let a slow agent block another agent's broadcast wake", async () => {
    const pending = createDeferred();
    runSpy.mockImplementation(async ({ agentId }) => {
      if (agentId === "main") {
        await pending.promise;
      }
      return { status: "ran", durationMs: 1 };
    });
    start(config("30m", { main: {}, ops: {} }));
    await wake({ source: "manual", intent: "manual", reason: "manual" });
    expect(runSpy.mock.calls.map(([options]) => options.agentId)).toEqual(["main", "ops"]);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("keeps serving interval wakes after runOnce throws an unhandled error", async () => {
    runSpy.mockRejectedValueOnce(new Error("session compaction error"));
    start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await interval();
    expect(runSpy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await interval();
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it("cleanup is idempotent and does not clear a newer runner's handler", async () => {
    const oldRun = vi.fn<RunOnce>().mockResolvedValue({ status: "ran", durationMs: 1 });
    const oldRunner = start(config(), { runOnce: oldRun });
    start();
    oldRunner.stop();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await interval();
    expect(runSpy).toHaveBeenCalledOnce();
    expect(oldRun).not.toHaveBeenCalled();
    oldRunner.stop();
  });

  it("retains event follow-ups after a disabled heartbeat until the spacing floor", async () => {
    runSpy.mockResolvedValue({ status: "skipped", reason: "disabled" });
    start(config("10m", { main: { heartbeat: { every: "10m" } } }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await interval("main", 10 * 60_000);
    expect(runSpy).toHaveBeenCalledOnce();
    await wake({ ...execWake, agentId: "main", sessionKey: undefined });
    expect(runSpy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it("does not delay the next cron tick after repeated requests-in-flight skips", async () => {
    const callTimes: number[] = [];
    runSpy.mockImplementation(async () => {
      callTimes.push(Date.now());
      return callTimes.length <= 5
        ? { status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT }
        : { status: "ran", durationMs: 1 };
    });
    start();
    const intervalMs = 30 * 60_000;
    await vi.advanceTimersByTimeAsync(intervalMs);
    await interval();
    expect(runSpy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runSpy).toHaveBeenCalledTimes(6);
    expect(callTimes.filter((time) => time >= 2 * intervalMs)).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * intervalMs - Date.now() + 1);
    await interval();
    expect(callTimes.filter((time) => time >= 2 * intervalMs).length).toBeGreaterThan(0);
  });

  it.each(["cron"] as const)(
    "merges %s overrides with source-specific destination ownership",
    async (source) => {
      start(
        config("30m", {
          main: {},
          ops: {
            heartbeat: {
              every: "15m",
              prompt: "Ops prompt",
              directPolicy: "block",
              target: "discord:channel:ops",
              to: "discord:dm:ops",
              accountId: "ops-account",
            },
          },
        }),
      );
      await wake({
        source,
        intent: "event",
        reason: `${source}:job-123`,
        agentId: "ops",
        sessionKey: "agent:ops:discord:channel:alerts",
        heartbeat: { target: "last" },
      });
      expect(runSpy).toHaveBeenCalledOnce();
      expectRun(0, {
        agentId: "ops",
        reason: `${source}:job-123`,
        sessionKey: "agent:ops:discord:channel:alerts",
        heartbeat: {
          every: "15m",
          prompt: "Ops prompt",
          directPolicy: "block",
          target: "last",
        },
      });
    },
  );

  it("does not bypass interval cooldown for repeated exec-event wakes", async () => {
    start();
    await wake(execWake);
    expect(runSpy).toHaveBeenCalledOnce();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await wake(execWake);
    }
    expect(runSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runSpy).toHaveBeenCalledTimes(3);
  });

  it.each<{
    owner: string;
    fromConversationTurn: boolean;
    commandMs: number;
    runs: number;
    beside?: { text: string; contextKey?: string };
  }>([
    { owner: "heartbeat", fromConversationTurn: false, commandMs: 40_000, runs: 1 },
    {
      owner: "conversation beside a reminder",
      fromConversationTurn: true,
      commandMs: 40_000,
      runs: 1,
      beside: { text: "Reminder: water the plants" },
    },
    {
      owner: "conversation after a heartbeat delivery",
      fromConversationTurn: true,
      commandMs: 40_000,
      runs: 14,
      beside: {
        text: "A heartbeat delivered this message to this channel:\nAll clear",
        contextKey: "heartbeat-delivery:0:agent:main:main:heartbeat",
      },
    },
  ])(
    "spaces a $owner command taking $commandMs ms started in every completion turn",
    async ({ fromConversationTurn, commandMs, runs, beside }) => {
      if (beside) {
        enqueueSystemEvent(beside.text, { sessionKey, contextKey: beside.contextKey });
      }
      const startCommand = () =>
        setTimeout(() => {
          enqueueSystemEvent("Exec completed (abcd1234, code 0) :: done", {
            sessionKey,
            fromConversationTurn,
          });
          requestHeartbeat({ ...execWake, coalesceMs: 0 });
        }, commandMs);
      const callTimes: number[] = [];
      runSpy.mockImplementation(async () => {
        callTimes.push(Date.now());
        startCommand();
        return { status: "ran", durationMs: 0 };
      });
      start();
      startCommand();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      // Event turns keep the 30s spacing; only conversation completions skip the interval wait.
      expect(callTimes).toHaveLength(runs);
      for (const [index, time] of callTimes.slice(1).entries()) {
        expect(time - callTimes[index]!).toBeGreaterThanOrEqual(Math.max(30_000, commandMs));
      }
    },
  );

  it("holds a conversation's completion turn behind the flood guard", async () => {
    start();
    for (let i = 0; i < 5; i++) {
      await wake({ source: "manual", intent: "manual", reason: "manual", sessionKey });
    }
    await vi.advanceTimersByTimeAsync(40_000);
    enqueueSystemEvent("Exec completed (abcd1234, code 0) :: done", {
      sessionKey,
      fromConversationTurn: true,
    });
    await wake(execWake);
    await vi.advanceTimersByTimeAsync(19_900);
    expect(runSpy).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(200);
    expect(runSpy).toHaveBeenCalledTimes(6);
  });

  it("retains an event that collides with a task until the spacing floor", async () => {
    start();
    requestHeartbeat({ ...taskWake, coalesceMs: 0 });
    await wake({ ...execWake, agentId: "main", sessionKey: undefined });
    expect(runSpy).toHaveBeenCalledOnce();
    expectRun(0, { intent: "task", tasks: taskWake.tasks });
    await vi.advanceTimersByTimeAsync(29_998);
    expect(runSpy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy).toHaveBeenCalledTimes(2);
    expectRun(1, { intent: "event", reason: "exec-event", tasks: [] });
  });

  it("retryable preemption does not poison the next retry", async () => {
    runSpy.mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_PREEMPTED });
    start();
    await wake(execWake);
    expect(runSpy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_500);
    expect(runSpy).toHaveBeenCalledTimes(2);
    expectRun(1, { reason: "exec-event", sessionKey });
  });
});

describe("ambient owner resolution", () => {
  it("starts explicit multi-agent heartbeats under the configured system owner", async () => {
    start({
      agents: {
        ownership: "explicit",
        entries: { ops: {}, main: {} },
        defaults: { systemAgent: { agentId: "ops" } },
      },
    });
    await wake({ source: "manual", intent: "manual", reason: "manual" });
    expect(runSpy).toHaveBeenCalledOnce();
    expectRun(0, { agentId: "ops" });
  });

  it("starts disabled and warns once when an explicit multi-agent roster has no owner", () => {
    const info = vi.spyOn(heartbeatLog, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(heartbeatLog, "warn").mockImplementation(() => undefined);
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, main: {} } },
    };
    start(cfg).updateConfig(cfg);
    expect(info).toHaveBeenCalledWith("heartbeat: disabled", { enabled: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("agents.defaults.heartbeat.agentId");
    expect(warn.mock.calls[0]?.[0]).toContain("agents.defaults.systemAgent.agentId");
  });
});

describe("targeted unscheduled wake dispatch", () => {
  it("runs a targeted manual next-heartbeat wake when recurring heartbeats are disabled", async () => {
    start(config("0m", { main: {} }));
    const enqueueEvent = vi.fn();
    const scheduler = new GatewayScheduler();
    const state = createCronServiceState({
      scheduler,
      storePath: "/unused/cron.json",
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: enqueueEvent,
      requestHeartbeat: (request) => requestHeartbeat({ ...request, coalesceMs: 0 }),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok" }),
    });
    expect(
      wakeCronService(state, {
        mode: "next-heartbeat",
        text: "Operator requested a session update.",
        agentId: "main",
        sessionKey,
      }),
    ).toEqual({ ok: true });
    expect(enqueueEvent).toHaveBeenCalledWith("Operator requested a session update.", {
      agentId: "main",
      sessionKey,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy).toHaveBeenCalledOnce();
    expectRun(0, {
      agentId: "main",
      source: "manual",
      intent: "immediate",
      reason: "wake",
      sessionKey,
    });
    await scheduler.stop();
  });

  it.each([
    cronWake,
    { source: "hook", intent: "immediate", reason: "hook:job-123", agentId: "main" },
    {
      source: "notifications-event",
      intent: "event",
      reason: "notifications-event",
      agentId: "main",
      sessionKey,
    },
  ] satisfies Wake[])("runs one targeted $source wake with disabled cadence", async (request) => {
    start(config("0m", { main: {} }));
    await wake(request);
    expect(runSpy).toHaveBeenCalledOnce();
    expectRun(0, request);
  });

  it("keeps targeted cron wakes globally disabled", async () => {
    setHeartbeatsEnabled(false);
    start(config("0m", { main: {} }));
    await wake(cronWake);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("rejects targeted cron wakes for unconfigured agents", async () => {
    start({ agents: { entries: { main: {} } } });
    await wake({ ...cronWake, agentId: "unknown", sessionKey: "agent:unknown:main" });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("retains the shared flood limit through reload with disabled cadence", async () => {
    const cfg = config("0m", { main: {} });
    const callTimes: number[] = [];
    runSpy.mockImplementation(async () => {
      callTimes.push(Date.now());
      return { status: "ran", durationMs: 0 };
    });
    const runner = start(cfg);
    for (let i = 0; i < 5; i++) {
      await wake(backgroundWake);
    }
    expect(callTimes).toEqual([0, 1, 2, 3, 4]);
    runner.updateConfig(cfg);
    requestHeartbeat({ ...execWake, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(60_000 - Date.now());
    expect(callTimes).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(callTimes).toEqual([0, 1, 2, 3, 4, 60_001]);
  });

  it("preserves an in-flight start across a reload with disabled cadence", async () => {
    const cfg = config("0m", { main: {} });
    const pending = createDeferred();
    const callTimes: number[] = [];
    runSpy.mockImplementation(async () => {
      callTimes.push(Date.now());
      await pending.promise;
      return { status: "ran", durationMs: 0 };
    });
    const runner = start(cfg);
    try {
      await wake(execWake);
      expect(callTimes).toEqual([0]);
      runner.updateConfig(cfg);
      pending.resolve();
      await vi.advanceTimersByTimeAsync(0);
      requestHeartbeat({ ...execWake, coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(29_999 - Date.now());
      expect(callTimes).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(callTimes).toEqual([0, 30_000]);
    } finally {
      pending.resolve();
    }
  });

  it("keeps event spacing through enrollment changes without adding broadcast wakes", async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, ops: { heartbeat: { every: "1m" } } } },
    };
    const calls: { agentId: string | undefined; at: number }[] = [];
    runSpy.mockImplementation(async ({ agentId }) => {
      calls.push({ agentId, at: Date.now() });
      return { status: "ran", durationMs: 0 };
    });
    const runner = start(cfg);
    await wake(execWake);
    runner.updateConfig({
      agents: {
        entries: {
          main: { heartbeat: { every: "1m" } },
          ops: { heartbeat: { every: "1m" } },
        },
      },
    });
    runner.updateConfig(cfg);
    requestHeartbeat({ ...execWake, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(29_999 - Date.now());
    expect(calls).toEqual([{ agentId: "main", at: 0 }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([
      { agentId: "main", at: 0 },
      { agentId: "main", at: 30_000 },
    ]);
    await wake({ source: "manual", intent: "manual", reason: "manual" });
    expect(calls).toEqual([
      { agentId: "main", at: 0 },
      { agentId: "main", at: 30_000 },
      { agentId: "ops", at: 30_000 },
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(3);
  });
});

describe("heartbeat broadcast outcomes", () => {
  function startRunner() {
    const register = vi.spyOn(heartbeatWake, "setHeartbeatWakeHandler");
    start(config("30m", { main: {}, ops: {} }));
    const run = register.mock.calls[0]?.[0];
    if (!run) {
      throw new Error("Expected the runner to register a wake handler");
    }
    return { run, runOnce: runSpy };
  }

  it("retains an untargeted task through min-spacing and dispatches its payload at the deadline", async () => {
    const { run, runOnce } = startRunner();
    await run({ source: "manual", intent: "manual" });
    runOnce.mockClear();
    vi.setSystemTime(1);
    const request = {
      source: "cron",
      intent: "task",
      reason: "heartbeat-task:inbox",
      tasks: [{ jobId: "inbox", name: "Inbox", prompt: "Check inbox" }],
    } as const;

    expect.soft(await run(request)).toEqual({
      status: "skipped",
      reason: "min-spacing",
      retryAtMs: 30_000,
    });
    expect(getLastHeartbeatEvent()).toBeNull();
    heartbeatWake.requestHeartbeat({ ...request, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(29_998);
    expect(runOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(
      runOnce.mock.calls.map(([opts]) => ({ agentId: opts.agentId, tasks: opts.tasks })),
    ).toEqual(["main", "ops"].map((agentId) => ({ agentId, tasks: request.tasks })));
  });

  it.each([{ intent: "scheduled", reason: "not-due", runs: 1, retryAtMs: 30 * 60_000 }] as const)(
    "preserves the earliest $reason deadline across agents",
    async (testCase) => {
      const { run } = startRunner();
      for (let i = 0; i < testCase.runs; i++) {
        await run({ source: "manual", intent: "manual", agentId: "ops" });
      }
      vi.setSystemTime(5_000);
      for (let i = 0; i < testCase.runs; i++) {
        await run({ source: "manual", intent: "manual", agentId: "main" });
      }
      vi.setSystemTime(10_000);

      expect(
        await run({ source: "interval", intent: testCase.intent, reason: "interval" }),
      ).toEqual({
        status: "skipped",
        reason: testCase.reason,
        retryAtMs: testCase.retryAtMs,
      });
    },
  );

  it("prefers a guard deferral over a sibling failure", async () => {
    const { run, runOnce } = startRunner();
    await run({ source: "manual", intent: "manual", agentId: "ops" });
    vi.setSystemTime(1);
    runOnce.mockResolvedValue({ status: "failed", reason: "agent-tool-failure" });
    expect(await run({ source: "cron", intent: "task" })).toEqual({
      status: "skipped",
      reason: "min-spacing",
      retryAtMs: 30_000,
    });
  });

  it("preserves the first terminal skip when no agent can retry", async () => {
    const { run, runOnce } = startRunner();
    const result = { status: "skipped", reason: "quiet-hours" } as const;
    runOnce
      .mockResolvedValueOnce(result)
      .mockResolvedValue({ status: "skipped", reason: "disabled" });
    expect(await run({ source: "cron", intent: "task" })).toEqual(result);
  });

  it("reports failure even after a sibling successfully ran", async () => {
    const { runOnce } = startRunner();
    const failure = { status: "failed", reason: "agent-tool-failure" } as const;
    runOnce.mockImplementation(async ({ agentId }) =>
      agentId === "ops" ? failure : { status: "ran", durationMs: 1 },
    );
    const completion = heartbeatWake.requestHeartbeatAndWait({
      source: "manual",
      intent: "manual",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(completion).resolves.toEqual(failure);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("preserves a busy retry beside a sibling failure", async () => {
    const { run, runOnce } = startRunner();
    const busy = {
      status: "skipped",
      reason: heartbeatWake.HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
    } as const;
    runOnce
      .mockResolvedValueOnce(busy)
      .mockResolvedValue({ status: "failed", reason: "agent-tool-failure" });
    expect(await run({ source: "cron", intent: "task" })).toEqual(busy);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("retries a channel-not-ready alert without consuming its scheduled cadence", async () => {
    const { run, runOnce } = startRunner();
    runOnce.mockResolvedValueOnce({
      status: "skipped",
      reason: "channel-not-ready",
      retryAtMs: 60_000,
    });
    const request = {
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: "main",
    } as const;
    heartbeatWake.requestHeartbeat({ ...request, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(await run(request)).toMatchObject({ status: "skipped", reason: "not-due" });
  });
});
