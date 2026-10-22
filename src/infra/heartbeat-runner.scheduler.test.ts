import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getRuntimeConfig,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { heartbeatLog } from "./heartbeat-log.js";
import { startHeartbeatRunner } from "./heartbeat-runner-scheduler.js";
import * as heartbeatWake from "./heartbeat-wake.js";
import {
  getHeartbeatWakeAbortSignal,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeat,
  setHeartbeatsEnabled,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

type RunnerOptions = Parameters<typeof startHeartbeatRunner>[0];
type RunOnce = NonNullable<RunnerOptions["runOnce"]>;
type RunResult = Awaited<ReturnType<RunOnce>>;
type Wake = Parameters<typeof requestHeartbeat>[0];
const runSpy = vi.fn<RunOnce>();
const runners: ReturnType<typeof startHeartbeatRunner>[] = [];
const sessionKey = "agent:main:main";
const ran = { status: "ran", durationMs: 1 } as const;
const instant = { ...ran, durationMs: 0 };
const disabled = { status: "skipped", reason: "disabled" } as const;
const completionText = "Exec completed (abcd1234, code 0) :: done";
function makeWake(
  source: NonNullable<Wake["source"]>,
  intent: NonNullable<Wake["intent"]>,
  overrides: Omit<Wake, "source" | "intent"> = {},
): Wake {
  return { source, intent, reason: source, ...overrides };
}
const manualWake = makeWake("manual", "manual");
const execWake = makeWake("exec-event", "event", { sessionKey });
const cronWake = makeWake("cron", "immediate", { reason: "cron:one-shot", agentId: "main" });
const backgroundWake = makeWake("background-task", "immediate", { sessionKey });
const taskWake = makeWake("interval", "task", {
  reason: "heartbeat-task:job-inbox",
  agentId: "main",
  tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
});

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

async function advance(ms: number, runs?: number) {
  await vi.advanceTimersByTimeAsync(ms);
  if (runs !== undefined) {
    expect(runSpy).toHaveBeenCalledTimes(runs);
  }
}
async function wake(request: Wake, runs?: number) {
  requestHeartbeat({ ...request, coalesceMs: 0 });
  await advance(1, runs);
}

function interval(agentId = "main", scheduledEveryMs = 30 * 60_000) {
  return wake(makeWake("interval", "scheduled", { agentId, scheduledEveryMs }));
}

function expectRun(index: number, expected: Partial<Parameters<RunOnce>[0]>) {
  expect(runSpy).toHaveBeenCalledTimes(index + 1);
  expect(runSpy).toHaveBeenNthCalledWith(index + 1, expect.objectContaining(expected));
}

function recordTimes(effect: (count: number) => ReturnType<RunOnce> = async () => instant) {
  const times: number[] = [];
  runSpy.mockImplementation(() => {
    times.push(Date.now());
    return effect(times.length);
  });
  return times;
}

function runtimeConfig(visibleReplies: "automatic" | "message_tool"): OpenClawConfig {
  return { ...config(), messages: { visibleReplies } };
}

async function tick(runs: number, ms = 30 * 60_000) {
  await advance(ms);
  await interval("main", ms);
  expect(runSpy).toHaveBeenCalledTimes(runs);
}

async function expectDrained(calls: number) {
  const drain = vi.fn().mockResolvedValue(disabled);
  const dispose = setHeartbeatWakeHandler(drain);
  await advance(250);
  expect(drain).toHaveBeenCalledTimes(calls);
  dispose();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  resetHeartbeatEventsForTest();
  runSpy.mockReset().mockResolvedValue(ran);
});

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    runner.stop();
  }
  // Disposed runners retain queued work for their successor; drain it between tests.
  const dispose = setHeartbeatWakeHandler(async () => disabled);
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
    await wake(manualWake);
    expect(runSpy).not.toHaveBeenCalled();
    await expectDrained(1);
  });

  it("aborts an active wake when the runner stops", async () => {
    const pending = createDeferred();
    let signal: AbortSignal | undefined;
    try {
      runSpy.mockImplementation(async () => {
        signal = getHeartbeatWakeAbortSignal();
        await pending.promise;
        return ran;
      });
      const runner = start();
      await wake({ ...manualWake, sessionKey });
      expect(signal?.aborted).toBe(false);
      runner.stop();
      await advance(0);
      expect(signal?.aborted).toBe(true);
      pending.resolve();
      await advance(0);
      await expectDrained(0);
      expect(runSpy).toHaveBeenCalledOnce();
    } finally {
      pending.resolve();
      await advance(0);
    }
  });

  it("keeps persisted monitor cadence authoritative when its tick joins a task turn", async () => {
    start();
    requestHeartbeat(
      makeWake("interval", "scheduled", {
        agentId: "main",
        scheduledEveryMs: 5 * 60_000,
        coalesceMs: 100,
      }),
    );
    requestHeartbeat({ ...taskWake, coalesceMs: 100 });
    await advance(100, 1);
    expectRun(0, { intent: "task", tasks: taskWake.tasks, heartbeat: { every: "300000ms" } });
    await advance(4 * 60_000);
    await wake({ ...execWake, agentId: "main", sessionKey: undefined }, 1);
    await advance(60_000, 2);
  });

  it("reads the latest runtime config for heartbeat wakes after no-op reload commits", async () => {
    const initialConfig = runtimeConfig("automatic");
    const nextConfig = runtimeConfig("message_tool");
    setRuntimeConfigSnapshot(initialConfig, initialConfig);
    start(initialConfig, { readCurrentConfig: getRuntimeConfig });
    setRuntimeConfigSnapshot(nextConfig, nextConfig);
    await wake(manualWake, 1);
    expectRun(0, { cfg: nextConfig, heartbeat: { every: "30m" } });
  });

  it("does not let a slow agent block another agent's broadcast wake", async () => {
    const pending = createDeferred();
    runSpy.mockImplementation(async ({ agentId }) => {
      if (agentId === "main") {
        await pending.promise;
      }
      return ran;
    });
    start(config("30m", { main: {}, ops: {} }));
    await wake(manualWake);
    expect(runSpy.mock.calls.map(([options]) => options.agentId)).toEqual(["main", "ops"]);
    pending.resolve();
    await advance(0);
  });

  it("keeps serving interval wakes after runOnce throws an unhandled error", async () => {
    runSpy.mockRejectedValueOnce(new Error("session compaction error"));
    start();
    await tick(1);
    await tick(2);
  });

  it("cleanup is idempotent and does not clear a newer runner's handler", async () => {
    const oldRun = vi.fn<RunOnce>().mockResolvedValue(ran);
    const oldRunner = start(config(), { runOnce: oldRun });
    start();
    oldRunner.stop();
    await tick(1);
    expect(oldRun).not.toHaveBeenCalled();
    oldRunner.stop();
  });

  it("retains event follow-ups after a disabled heartbeat until the spacing floor", async () => {
    runSpy.mockResolvedValue(disabled);
    start(config("10m", { main: { heartbeat: { every: "10m" } } }));
    await tick(1, 10 * 60_000);
    await wake({ ...execWake, agentId: "main", sessionKey: undefined }, 1);
    await advance(30_000, 2);
  });

  it("does not delay the next cron tick after repeated requests-in-flight skips", async () => {
    const callTimes = recordTimes(async (count) =>
      count <= 5 ? { status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT } : ran,
    );
    start();
    const intervalMs = 30 * 60_000;
    await tick(1);
    await advance(5 * 60_000, 6);
    expect(callTimes.filter((time) => time >= 2 * intervalMs)).toEqual([]);
    await advance(2 * intervalMs - Date.now() + 1);
    await interval();
    expect(callTimes.filter((time) => time >= 2 * intervalMs).length).toBeGreaterThan(0);
  });

  it("merges cron overrides with source-specific destination ownership", async () => {
    const heartbeat = { every: "15m", prompt: "Ops prompt", directPolicy: "block" } as const;
    start(
      config("30m", {
        main: {},
        ops: {
          heartbeat: {
            ...heartbeat,
            target: "discord:channel:ops",
            to: "discord:dm:ops",
            accountId: "ops-account",
          },
        },
      }),
    );
    const request = {
      source: "cron",
      intent: "event",
      reason: "cron:job-123",
      agentId: "ops",
      sessionKey: "agent:ops:discord:channel:alerts",
      heartbeat: { target: "last" },
    } as const;
    await wake(request);
    expectRun(0, { ...request, heartbeat: { ...heartbeat, target: "last" } });
  });

  it("does not bypass interval cooldown for repeated exec-event wakes", async () => {
    start();
    await wake(execWake, 1);
    for (let i = 0; i < 4; i++) {
      await advance(10_000);
      await wake(execWake);
    }
    expect(runSpy).toHaveBeenCalledTimes(2);
    await advance(20_000, 3);
  });

  it.each<[string, boolean, number, { text: string; contextKey?: string }?]>([
    ["heartbeat", false, 1, undefined],
    ["conversation beside a reminder", true, 1, { text: "Reminder: water the plants" }],
    [
      "conversation after a heartbeat delivery",
      true,
      14,
      {
        text: "A heartbeat delivered this message to this channel:\nAll clear",
        contextKey: "heartbeat-delivery:0:agent:main:main:heartbeat",
      },
    ],
  ])(
    "spaces a %s command started in every completion turn",
    async (_owner, fromConversationTurn, runs, beside) => {
      const commandMs = 40_000;
      if (beside) {
        enqueueSystemEvent(beside.text, { sessionKey, contextKey: beside.contextKey });
      }
      const startCommand = () =>
        setTimeout(() => {
          enqueueSystemEvent(completionText, {
            sessionKey,
            fromConversationTurn,
          });
          requestHeartbeat({ ...execWake, coalesceMs: 0 });
        }, commandMs);
      const callTimes = recordTimes(async () => {
        startCommand();
        return instant;
      });
      start();
      startCommand();
      await advance(10 * 60_000);

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
      await wake({ ...manualWake, sessionKey });
    }
    await advance(40_000);
    enqueueSystemEvent(completionText, {
      sessionKey,
      fromConversationTurn: true,
    });
    await wake(execWake);
    await advance(19_900, 5);
    await advance(200, 6);
  });

  it("retains an event that collides with a task until the spacing floor", async () => {
    start();
    requestHeartbeat({ ...taskWake, coalesceMs: 0 });
    await wake({ ...execWake, agentId: "main", sessionKey: undefined }, 1);
    expectRun(0, { intent: "task", tasks: taskWake.tasks });
    await advance(29_998, 1);
    await advance(1, 2);
    expectRun(1, { intent: "event", reason: "exec-event", tasks: [] });
  });

  it("retryable preemption does not poison the next retry", async () => {
    runSpy.mockResolvedValueOnce({ status: "skipped", reason: "preempted" });
    start();
    await wake(execWake, 1);
    await advance(60_500, 2);
    expectRun(1, { reason: "exec-event", sessionKey });
  });
  it("starts explicit multi-agent heartbeats under the configured system owner", async () => {
    start({
      agents: {
        ownership: "explicit",
        entries: { ops: {}, main: {} },
        defaults: { systemAgent: { agentId: "ops" } },
      },
    });
    await wake(manualWake, 1);
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

  it.each([
    cronWake,
    makeWake("hook", "immediate", { reason: "hook:job-123", agentId: "main" }),
    makeWake("notifications-event", "event", { agentId: "main", sessionKey }),
  ] satisfies Wake[])("runs one targeted $source wake with disabled cadence", async (request) => {
    start(config("0m", { main: {} }));
    await wake(request, 1);
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
    const callTimes = recordTimes();
    const runner = start(cfg);
    for (let i = 0; i < 5; i++) {
      await wake(backgroundWake);
    }
    expect(callTimes).toEqual([0, 1, 2, 3, 4]);
    runner.updateConfig(cfg);
    requestHeartbeat({ ...execWake, coalesceMs: 0 });
    await advance(60_000 - Date.now());
    expect(callTimes).toHaveLength(5);
    await advance(1);
    expect(callTimes).toEqual([0, 1, 2, 3, 4, 60_001]);
  });

  it("preserves an in-flight start across a reload with disabled cadence", async () => {
    const cfg = config("0m", { main: {} });
    const pending = createDeferred();
    const callTimes = recordTimes(async () => {
      await pending.promise;
      return instant;
    });
    const runner = start(cfg);
    try {
      await wake(execWake);
      expect(callTimes).toEqual([0]);
      runner.updateConfig(cfg);
      pending.resolve();
      await advance(0);
      requestHeartbeat({ ...execWake, coalesceMs: 0 });
      await advance(29_999 - Date.now());
      expect(callTimes).toEqual([0]);
      await advance(1);
      expect(callTimes).toEqual([0, 30_000]);
    } finally {
      pending.resolve();
    }
  });

  it("keeps event spacing through enrollment changes without adding broadcast wakes", async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, ops: { heartbeat: { every: "1m" } } } },
    };
    const calls: [string | undefined, number][] = [];
    runSpy.mockImplementation(async ({ agentId }) => {
      calls.push([agentId, Date.now()]);
      return instant;
    });
    const expectCalls = (...expected: [string, number][]) => expect(calls).toEqual(expected);
    const runner = start(cfg);
    await wake(execWake);
    runner.updateConfig({
      agents: {
        entries: {
          ...cfg.agents?.entries,
          main: { heartbeat: { every: "1m" } },
        },
      },
    });
    runner.updateConfig(cfg);
    requestHeartbeat({ ...execWake, coalesceMs: 0 });
    await advance(29_999 - Date.now());
    expectCalls(["main", 0]);
    await advance(1);
    expectCalls(["main", 0], ["main", 30_000]);
    await wake(manualWake);
    expectCalls(["main", 0], ["main", 30_000], ["ops", 30_000]);
    await advance(120_000);
    expect(calls).toHaveLength(3);
  });
  function startRunner() {
    const register = vi.spyOn(heartbeatWake, "setHeartbeatWakeHandler");
    start(config("30m", { main: {}, ops: {} }));
    const run = register.mock.calls[0]?.[0];
    if (!run) {
      throw new Error("Expected the runner to register a wake handler");
    }
    return { run, runOnce: runSpy };
  }

  it.each([
    { intent: "manual", now: 1, result: instant },
    { intent: "immediate", now: 1, result: instant },
    {
      intent: "scheduled",
      now: 1_799_999,
      result: { status: "skipped", reason: "not-due", retryAtMs: 1_800_000 },
    },
    { intent: "scheduled", now: 1_800_000, result: instant },
    {
      intent: "event",
      now: 1,
      result: { status: "skipped", reason: "not-due", retryAtMs: 30_000 },
    },
    { intent: "event", now: 1_800_000, result: instant },
    {
      intent: "task",
      now: 29_999,
      result: { status: "skipped", reason: "min-spacing", retryAtMs: 30_000 },
    },
    { intent: "task", now: 30_000, result: instant },
  ] as const)("keeps the $intent admission deadline at $now", async ({ intent, now, result }) => {
    const { run, runOnce } = startRunner();
    await run({ source: "manual", intent: "manual", agentId: "main" });
    runOnce.mockClear();
    vi.setSystemTime(now);
    expect(await run({ source: "manual", intent, agentId: "main" })).toEqual(result);
    expect(runOnce).toHaveBeenCalledTimes(result.status === "ran" ? 1 : 0);
  });

  it("keeps the immediate flood deadline after repeated manual runs", async () => {
    const { run, runOnce } = startRunner();
    for (let now = 0; now < 10; now++) {
      vi.setSystemTime(now);
      await run({ source: "manual", intent: "manual", agentId: "main" });
    }
    runOnce.mockClear();
    vi.setSystemTime(60_005);
    const request = { source: "manual", intent: "immediate", agentId: "main" } as const;
    expect(await run(request)).toEqual({ status: "skipped", reason: "flood", retryAtMs: 60_006 });
    expect(runOnce).not.toHaveBeenCalled();
    vi.setSystemTime(60_006);
    expect(await run(request)).toEqual(instant);
    expect(runOnce).toHaveBeenCalledOnce();
  });

  it("retains an untargeted task through min-spacing and dispatches its payload at the deadline", async () => {
    const { run, runOnce } = startRunner();
    await run({ source: "manual", intent: "manual" });
    runOnce.mockClear();
    vi.setSystemTime(1);
    const request = { ...taskWake, source: "cron", agentId: undefined } as const;

    expect.soft(await run(request)).toEqual({
      status: "skipped",
      reason: "min-spacing",
      retryAtMs: 30_000,
    });
    expect(getLastHeartbeatEvent()).toBeNull();
    heartbeatWake.requestHeartbeat({ ...request, coalesceMs: 0 });
    await advance(29_998);
    expect(runOnce).not.toHaveBeenCalled();
    await advance(1, 2);
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

  it.each([
    [{ status: "skipped", reason: "quiet-hours" }, disabled],
    [
      { status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT },
      { status: "failed", reason: "agent-tool-failure" },
    ],
  ] satisfies [RunResult, RunResult][])("preserves first %j beside %j", async (first, second) => {
    const { run, runOnce } = startRunner();
    runOnce.mockResolvedValueOnce(first).mockResolvedValue(second);
    expect(await run({ source: "cron", intent: "task" })).toEqual(first);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("reports failure even after a sibling successfully ran", async () => {
    const { runOnce } = startRunner();
    const failure = { status: "failed", reason: "agent-tool-failure" } as const;
    runOnce.mockImplementation(async ({ agentId }) => (agentId === "ops" ? failure : ran));
    const completion = heartbeatWake.requestHeartbeatAndWait({
      source: "manual",
      intent: "manual",
      coalesceMs: 0,
    });
    await advance(0);
    await expect(completion).resolves.toEqual(failure);
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
    await advance(59_999, 1);
    await advance(1, 2);
    expect(await run(request)).toMatchObject({ status: "skipped", reason: "not-due" });
  });
});
