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
  tracker.measureSync("sync", () => advance(enabled ? 500 : 0));
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

  expect(subsystemWarn.mock.calls.map(([, details]) => details)).toEqual([
    summary({ ...identity, milestone: "model_started" }),
    summary({ ...identity, milestone: "" }),
    summary({
      runId: "run-1",
      sessionId: undefined,
      sessionKey: undefined,
      outcome: "error",
      error: "failed",
    }),
  ]);
  expect(JSON.stringify(subsystemWarn.mock.calls)).not.toMatch(/secret|unexpected/);
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
  tracker.logIfSlow(context);

  expect(subsystemWarn).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    summary({
      ...context,
      messageId: undefined,
      sessionKey: undefined,
      reason: undefined,
    }),
  );
  expect(JSON.stringify(subsystemWarn.mock.calls)).not.toContain("secret");
});

it.each([false, true])(
  "logs first execution observations only (slow admission=%s)",
  async (slowAdmission) => {
    const agent = createAgentTurnTimingTracker();
    const dispatch = createReplyHotPathTimingTracker();
    const phase = (value: Parameters<typeof agent.logExecutionPhaseIfSlow>[0]["phase"]) =>
      agent.logExecutionPhaseIfSlow({ ...identity, phase: value });
    agent.logMilestoneIfSlow({ ...identity, milestone: "before_embedded_run" });
    phase(slowAdmission ? "runner_entered" : "turn_accepted");
    phase("model_call_started");
    expect(subsystemWarn).not.toHaveBeenCalled();
    await dispatch.measure("reply.run_reply_resolver", () =>
      agent.measure("embedded_run", () => {
        nowMs = slowAdmission ? 21_000 : 20_000;
        if (slowAdmission) {
          phase("turn_accepted");
          nowMs = 24_000;
        }
        phase("assistant_output_started");
        phase("tool_execution_started");
      }),
    );
    const outputMs = nowMs;
    nowMs = 30_000;
    phase("tool_execution_started");
    agent.logIfSlow({ ...identity, outcome: "completed" });
    dispatch.logIfSlow({ channel: "webchat", outcome: "completed" });
    expect(subsystemWarn.mock.calls.map(([, details]) => details)).toEqual(
      slowAdmission ? [summary({ ...identity, milestone: "turn_accepted" }, 21_000)] : [],
    );
    expect(subsystemInfo.mock.calls.map(([, details]) => details)).toEqual([
      summary({ ...identity, milestone: "assistant_output_started" }, outputMs),
      summary({ ...identity, milestone: "tool_execution_started" }, outputMs),
    ]);
  },
);

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
