import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceAgentRunActivity } from "./agent-run-control-shared.js";
import {
  classifyRealtimeVoiceAgentControlText as classify,
  controlRealtimeVoiceAgentRun,
  parseRealtimeVoiceAgentControlToolArgs as parseArgs,
  resolveRealtimeVoiceAgentControlIntent as resolveIntent,
  shouldAutoControlRealtimeVoiceAgentText as shouldAutoControl,
} from "./agent-run-control.js";
import type { TalkEvent } from "./talk-events.js";

vi.mock("../agents/embedded-agent-runner/runs.js", () => {
  throw new Error("mutating run commands unavailable");
});

function createDeps(options: {
  activeSessionId?: string;
  unconfirmed?: boolean;
  activity?: RealtimeVoiceAgentRunActivity;
}) {
  return {
    abortEmbeddedAgentRun: vi.fn(() => true),
    // Preserve the dependency callback contract exported in v2026.8.1.
    queueEmbeddedAgentMessageWithOutcomeAsync: vi.fn(
      async (
        sessionId: string,
        _text: string,
        _options?: {
          steeringMode?: "all";
          isInboundUserMessage?: boolean;
          taskSuggestionDeliveryMode?: undefined;
        },
      ) => ({
        queued: true as const,
        sessionId,
        target: "embedded_run" as const,
        gatewayHealth: "live" as const,
        enqueuedAtMs: 123,
        ...(options.unconfirmed
          ? { transcriptCommit: "unconfirmed" as const, errorMessage: "receipt unavailable" }
          : {}),
      }),
    ),
    getDiagnosticSessionActivitySnapshot: vi.fn(() => options.activity ?? {}),
    resolveActiveEmbeddedRunSessionId: vi.fn(() => options.activeSessionId),
  };
}

function control(
  params: Partial<Parameters<typeof controlRealtimeVoiceAgentRun>[0]>,
  deps?: Parameters<typeof controlRealtimeVoiceAgentRun>[1],
) {
  return controlRealtimeVoiceAgentRun(
    { sessionKey: "agent:main:main", text: "status", mode: "status", ...params },
    deps,
  );
}

function progress(name: string, phase: string, seq = 1): TalkEvent {
  return {
    id: `event-${seq}`,
    type: "tool.progress",
    sessionId: "talk-1",
    seq,
    timestamp: new Date(seq - 1).toISOString(),
    mode: "realtime",
    transport: "gateway-relay",
    brain: "agent-consult",
    payload: { name, phase },
  };
}

function createRunTarget(runId = "owned-run") {
  return { runId, signal: new AbortController().signal, isCurrent: () => true };
}

describe("classifyRealtimeVoiceAgentControlText", () => {
  it("keeps ambiguous active-call speech out of automatic steering", () => {
    const safeDefault = {
      mode: "status",
      confidence: "low",
      reason: "safe_default",
      shouldAutoControl: false,
    };
    expect(resolveIntent({ text: "hello" })).toMatchObject(safeDefault);
    expect(shouldAutoControl("hi")).toBe(false);
    expect(shouldAutoControl("hey")).toBe(false);
    expect(shouldAutoControl("don't stop that")).toBe(false);
    expect(classify("stop it from using the slow path")).toBe("steer");
    expect(shouldAutoControl("stop it from using the slow path")).toBe(true);
    expect(shouldAutoControl("stop using the slow path")).toBe(true);
    expect(resolveIntent({ text: "¿cómo va esto?" })).toMatchObject(safeDefault);
    expect(shouldAutoControl("¿cómo va esto?")).toBe(false);
    expect(shouldAutoControl("actually focus on WebUI")).toBe(true);
  });

  it("parses semantic realtime control tool calls", () => {
    const expectedSteer = { text: "revísalo en español", mode: "steer" };
    expect(parseArgs({ ...expectedSteer })).toStrictEqual(expectedSteer);
    expect(parseArgs({ message: "status?" })).toStrictEqual({
      text: "status?",
      mode: "status",
    });
    expect(parseArgs(JSON.stringify(expectedSteer))).toStrictEqual(expectedSteer);
  });
});

describe("controlRealtimeVoiceAgentRun", () => {
  it.each([null, "stale-run"])(
    "never falls back from exact selector %s to a shared global key",
    async (runId) => {
      const deps = createDeps({
        activeSessionId: "another-agent-session",
        activity: { hasActiveEmbeddedRun: true },
      });
      const target = runId ? createRunTarget(runId) : null;
      for (const mode of ["status", "cancel", "steer"] as const) {
        const result = await control(
          { sessionKey: "global", runTarget: target, text: mode, mode },
          deps,
        );
        expect(result.active).toBe(false);
      }
      expect(deps.resolveActiveEmbeddedRunSessionId).not.toHaveBeenCalled();
      expect(deps.getDiagnosticSessionActivitySnapshot).not.toHaveBeenCalled();
      expect(deps.abortEmbeddedAgentRun).not.toHaveBeenCalled();
      expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
    },
  );

  it.each(["provided callback", "legacy adapter"])(
    "controls the exact live owner through %s",
    async (route) => {
      const deps = createDeps({ activeSessionId: "another-agent-session" });
      const abort = vi.fn(() => true);
      const cancelRun = route === "provided callback" ? vi.fn(async () => true) : undefined;
      const resolveActiveEmbeddedRunOwnerByRunId = vi.fn(() => ({
        runId: "owned-run",
        sessionId: "owned-session",
        sessionKey: "global",
        abort,
      }));
      const result = await control(
        {
          sessionKey: "global",
          runTarget: createRunTarget(),
          text: "cancel",
          mode: "cancel",
          cancelRun,
        },
        { ...deps, resolveActiveEmbeddedRunOwnerByRunId },
      );
      expect(result).toMatchObject({ ok: true, sessionId: "owned-session", aborted: true });
      expect([...new Set(resolveActiveEmbeddedRunOwnerByRunId.mock.calls.flat())]).toEqual([
        "owned-run",
      ]);
      if (cancelRun) {
        expect(cancelRun).toHaveBeenCalledExactlyOnceWith("owned-run");
        expect(abort).not.toHaveBeenCalled();
      } else {
        expect(abort).toHaveBeenCalledOnce();
      }
      expect(deps.getDiagnosticSessionActivitySnapshot).toHaveBeenCalledExactlyOnceWith({
        sessionId: "owned-session",
      });
      expect(deps.resolveActiveEmbeddedRunSessionId).not.toHaveBeenCalled();
      expect(deps.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null])(
    "answers read-only status without mutating commands (target=%s)",
    async (runTarget) => {
      if (runTarget === null) {
        // mock-isolation: A null exact-run target must answer status even when global session-key projections cannot load.
        vi.doMock("../sessions/session-controller.queries.js", () => {
          throw new Error("session-key projections unavailable");
        });
      }
      try {
        await expect(
          control({ sessionKey: "agent:status-probe:main", runTarget }),
        ).resolves.toMatchObject({ ok: true, mode: "status", active: false, speak: true });
      } finally {
        vi.doUnmock("../sessions/session-controller.queries.js");
      }
    },
  );

  it("queues steering into the active embedded run", async () => {
    const deps = createDeps({ activeSessionId: "session-active" });
    await expect(
      control({ text: "use the safer path", mode: "steer" }, deps),
    ).resolves.toMatchObject({
      ok: true,
      mode: "steer",
      sessionKey: "agent:main:main",
      sessionId: "session-active",
      active: true,
      queued: true,
      speak: true,
      suppress: false,
    });
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "session-active",
      "use the safer path",
      {
        steeringMode: "all",
        debounceMs: 0,
        isInboundUserMessage: true,
        taskSuggestionDeliveryMode: undefined,
      },
    );
  });

  it("reports unconfirmed followup without claiming success or sending again", async () => {
    const deps = createDeps({ activeSessionId: "session-active", unconfirmed: true });
    const result = await control({ text: "continue", mode: "followup" }, deps);
    expect(result).toMatchObject({
      ok: false,
      queued: true,
      reason: "delivery_unconfirmed",
      speak: true,
      show: true,
      suppress: false,
    });
    expect(result.message).toContain("could not confirm");
    expect(result.message).toContain("not sent again");
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledOnce();
    expect(deps.abortEmbeddedAgentRun).not.toHaveBeenCalled();
  });

  it("refuses a source-bound control with only the shipped narrow V1 callback", async () => {
    const deps = createDeps({ activeSessionId: "owned-session" });
    const result = await control(
      {
        sessionKey: "global",
        runTarget: createRunTarget(),
        mode: "steer",
        text: "source-bound",
      },
      {
        ...deps,
        resolveActiveEmbeddedRunOwnerByRunId: () => ({
          runId: "owned-run",
          sessionId: "owned-session",
          sessionKey: "global",
          abort: () => true,
        }),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      queued: false,
      reason: "guarded_injection_unsupported",
    });
    expect(result.message).toContain("cannot safely accept scoped voice steering");
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("wraps follow-up steering so the active run treats it as deferred context", async () => {
    const deps = createDeps({ activeSessionId: "session-active" });
    await expect(
      control({ text: "also check the migration", mode: "followup" }, deps),
    ).resolves.toMatchObject({ ok: true, mode: "followup", speak: true });
    const queuedText = deps.queueEmbeddedAgentMessageWithOutcomeAsync.mock.calls[0]?.[1] ?? "";
    expect(queuedText).toContain("Spoken follow-up for the current voice call.");
    expect(queuedText).toContain("also check the migration");
  });

  it("cancels the active run without queueing a steering message", async () => {
    const deps = createDeps({ activeSessionId: "session-active" });
    await expect(control({ text: "stop", mode: "cancel" }, deps)).resolves.toMatchObject({
      ok: true,
      mode: "cancel",
      sessionId: "session-active",
      aborted: true,
      providerResult: {
        status: "cancelled",
        message: "Cancelled the active OpenClaw run.",
      },
    });
    expect(deps.abortEmbeddedAgentRun).toHaveBeenCalledWith("session-active");
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "diagnostic run activity without Talk events",
      options: {
        activity: {
          activeWorkKind: "tool_call",
          hasActiveEmbeddedRun: true,
          activeToolName: "exec_command",
        },
      },
      params: { sessionKey: "agent:main:discord:channel:1001", text: "what are you doing" },
      active: true,
      message: "OpenClaw is running exec_command.",
    },
    {
      name: "ended run ignoring stale control progress",
      options: {},
      params: { recentEvents: [progress("openclaw_agent_control", "status")] },
      active: false,
      message: "I'm not working on an active request right now.",
    },
    {
      name: "active run ignoring control progress",
      options: { activeSessionId: "session-active" },
      params: {
        recentEvents: [
          progress("exec_command", "running"),
          progress("openclaw_agent_control", "status", 2),
        ],
      },
      active: true,
      message: "OpenClaw is working in exec_command (running).",
    },
  ] as const)("reports $name", async ({ options, params, active, message }) => {
    const deps = createDeps(options);
    await expect(control(params, deps)).resolves.toMatchObject({
      ok: true,
      mode: "status",
      active,
      message,
    });
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });
});
