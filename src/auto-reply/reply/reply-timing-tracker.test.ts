import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import { createReplyHotPathTimingTracker } from "./dispatch-from-config.timing.js";
import { createReplyTimingTracker, isReplyProfilerEnabled } from "./reply-timing-tracker.js";

const subsystemWarn = vi.hoisted(() => vi.fn());
const subsystemInfo = vi.hoisted(() => vi.fn());
const identity = { runId: "run-1", sessionId: "session-1", sessionKey: "agent:main" };
const warn = vi.fn();
let nowMs: number;
const advance = (ms: number) => {
  nowMs += ms;
};
const span = (name: string, ms: number) => ({ name, durationMs: ms, elapsedMs: ms });
const summary = (details: object, totalMs = 1_500) => ({ ...details, totalMs, spans: [] });
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: subsystemWarn, info: subsystemInfo }),
}));

beforeEach(() => {
  nowMs = 0;
  vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  [subsystemWarn, subsystemInfo, warn].forEach((mock) => mock.mockReset());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])("logs once at the profiling=%s threshold", async (enabled) => {
  vi.stubEnv("OPENCLAW_DIAGNOSTICS", enabled ? "reply.profiler" : "");
  const tracker = createReplyTimingTracker({
    log: { warn },
    enabled: isReplyProfilerEnabled(),
  });
  expect(
    tracker.measureSync("sync", () => {
      advance(enabled ? 500 : 0);
      return enabled ? 7 : 42;
    }),
  ).toBe(enabled ? 7 : 42);
  if (!enabled) {
    await expect(tracker.measure("async", async () => "ok")).resolves.toBe("ok");
  }
  const log = () =>
    tracker.logIfSlow({
      message: "reply timings",
      ...(enabled ? { outcome: "completed" } : { details: { runId: "run-1" } }),
    });
  log();
  expect(warn).toHaveBeenCalledTimes(Number(enabled));
  if (!enabled) {
    await tracker.measure("prepare", () => advance(5_000));
  }
  log();
  log();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    enabled ? expect.stringContaining("stages=sync:") : expect.any(String),
    expect.objectContaining({
      ...(enabled ? { outcome: "completed" } : { runId: "run-1" }),
      spans: enabled
        ? [expect.objectContaining({ name: "sync" })]
        : expect.arrayContaining([span("prepare", 5_000)]),
    }),
  );
});

it("keeps agent milestones repeatable without reopening the terminal log", () => {
  vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1_500);
  const tracker = createAgentTurnTimingTracker({ profilerEnabled: true });

  tracker.logMilestoneIfSlow({ ...identity, milestone: "model_started" });
  tracker.logMilestoneIfSlow({ ...identity, milestone: "" });
  const terminal = {
    runId: "run-1",
    outcome: "error" as const,
    error: "failed",
    milestone: "unexpected",
    token: "secret",
  };
  tracker.logIfSlow(terminal);
  tracker.logIfSlow({ ...identity, outcome: "completed" });

  expect(subsystemWarn).toHaveBeenCalledTimes(3);
  expect(subsystemWarn.mock.calls[0]?.[0]).toBe(
    "agent turn milestone runId=run-1 sessionId=session-1 sessionKey=agent:main milestone=model_started totalMs=1500 stages=none",
  );
  expect(subsystemWarn.mock.calls[1]?.[0]).toContain(" milestone= totalMs=1500 ");
  expect(subsystemWarn.mock.calls[2]?.[0]).toContain("agent turn timings runId=run-1");
  expect(subsystemWarn.mock.calls[2]?.[1]).toEqual(
    summary({
      runId: "run-1",
      sessionId: undefined,
      sessionKey: undefined,
      outcome: "error",
      error: "failed",
    }),
  );
});

it("preserves dispatch timing messages and structured details", () => {
  vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1_500);
  const tracker = createReplyHotPathTimingTracker({ profilerEnabled: true });
  const context = {
    channel: "telegram",
    runId: "run-1",
    sessionId: "session-1",
    outcome: "skipped" as const,
  };
  const details = { ...context, token: "secret" };
  tracker.logIfSlow(details);
  tracker.logIfSlow(details);

  expect(subsystemWarn).toHaveBeenCalledExactlyOnceWith(
    "reply hot path timings channel=telegram messageId=unknown runId=run-1 sessionId=session-1 sessionKey=unknown outcome=skipped totalMs=1500 stages=none",
    summary({
      ...context,
      messageId: undefined,
      sessionKey: undefined,
      reason: undefined,
    }),
  );
});

it("keeps ordinary model and tool execution out of default terminal warnings", async () => {
  const agentTiming = createAgentTurnTimingTracker();
  const dispatchTiming = createReplyHotPathTimingTracker();

  agentTiming.logMilestoneIfSlow({ ...identity, milestone: "before_embedded_run" });
  agentTiming.logExecutionPhaseIfSlow({ ...identity, phase: "turn_accepted" });
  agentTiming.logExecutionPhaseIfSlow({ ...identity, phase: "model_call_started" });
  await dispatchTiming.measure("reply.run_reply_resolver", () =>
    agentTiming.measure("embedded_run", async () => {
      nowMs += 20_000;
      agentTiming.logExecutionPhaseIfSlow({ ...identity, phase: "assistant_output_started" });
      agentTiming.logExecutionPhaseIfSlow({ ...identity, phase: "tool_execution_started" });
    }),
  );
  agentTiming.logIfSlow({ ...identity, outcome: "completed" });
  dispatchTiming.logIfSlow({ channel: "webchat", outcome: "completed" });

  expect(subsystemWarn).not.toHaveBeenCalled();
  expect(subsystemInfo).toHaveBeenCalledTimes(2);
});

it("reports slow dispatch preparation and early cancellation without profiling", async () => {
  const tracker = createReplyHotPathTimingTracker();
  await tracker.measure("reply.load_reply_resolver", () => advance(5_000));
  tracker.logPreparationIfSlow({ channel: "webchat", sessionKey: "agent:main" });
  tracker.logIfSlow(
    { channel: "webchat", outcome: "skipped", reason: "reply_operation_aborted" },
    { beforeReplyResolver: true },
  );

  expect(subsystemWarn.mock.calls.map((call) => call[1])).toMatchObject([
    {
      channel: "webchat",
      sessionKey: "agent:main",
      outcome: "milestone",
      reason: "before_reply_resolver",
      totalMs: 5_000,
      spans: [span("reply.load_reply_resolver", 5_000)],
    },
    { outcome: "skipped", reason: "reply_operation_aborted", totalMs: 5_000 },
  ]);
});

it("records the first slow execution phases without profiling or repeated tool logs", () => {
  const tracker = createAgentTurnTimingTracker();

  tracker.logExecutionPhaseIfSlow({ ...identity, phase: "runner_entered" });
  expect(subsystemWarn).not.toHaveBeenCalled();
  nowMs = 21_000;
  tracker.logExecutionPhaseIfSlow({ ...identity, phase: "turn_accepted" });
  nowMs = 24_000;
  tracker.logExecutionPhaseIfSlow({ ...identity, phase: "assistant_output_started" });
  tracker.logExecutionPhaseIfSlow({ ...identity, phase: "tool_execution_started" });
  nowMs = 30_000;
  tracker.logExecutionPhaseIfSlow({ ...identity, phase: "tool_execution_started" });

  expect(subsystemWarn.mock.calls.map((call) => call[1])).toEqual([
    summary({ ...identity, milestone: "turn_accepted" }, 21_000),
  ]);
  expect(subsystemInfo.mock.calls.map((call) => call[1])).toEqual([
    summary({ ...identity, milestone: "assistant_output_started" }, 24_000),
    summary({ ...identity, milestone: "tool_execution_started" }, 24_000),
  ]);
});
