import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
} from "../../logging/diagnostic-run-activity.js";
import { markDiagnosticModelStartedForTest } from "../../logging/diagnostic-run-activity.test-support.js";
import type { PartialReplyPayload } from "../get-reply-options.types.js";
import type { GetReplyOptions } from "../types.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  expectRecordFields,
  expectNoMockCallWithFields,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type { EmbeddedAgentParams } from "./agent-runner-execution.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";

const sanitizerState = vi.hoisted(() => ({
  sanitizeUserFacingText: vi.fn(),
}));

vi.mock("../../agents/embedded-agent-helpers/sanitize-user-facing-text.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../agents/embedded-agent-helpers/sanitize-user-facing-text.js")
  >("../../agents/embedded-agent-helpers/sanitize-user-facing-text.js");
  sanitizerState.sanitizeUserFacingText.mockImplementation(actual.sanitizeUserFacingText);
  return {
    ...actual,
    sanitizeUserFacingText: (...args: Parameters<typeof actual.sanitizeUserFacingText>) =>
      sanitizerState.sanitizeUserFacingText(...args),
  };
});

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();
const emitAgentEvent = vi.mocked((await import("../../infra/agent-events.js")).emitAgentEvent);
const finalResult = () => ({ payloads: [{ text: "final" }], meta: {} });
type AgentEvent = Parameters<NonNullable<EmbeddedAgentParams["onAgentEvent"]>>[0];

async function sendEvents(params: EmbeddedAgentParams, events: AgentEvent[]) {
  for (const event of events) {
    await params.onAgentEvent?.(event);
  }
  return finalResult();
}

function mockEvents(events: AgentEvent[]) {
  state.runEmbeddedAgentMock.mockImplementationOnce((params: EmbeddedAgentParams) =>
    sendEvents(params, events),
  );
}

function toolStart(name: string, args: Record<string, unknown>, extra = {}): AgentEvent {
  return { stream: "tool", data: { name, phase: "start", args, ...extra } };
}

function itemStart(name: string, extra: Record<string, unknown>): AgentEvent {
  return { stream: "item", data: { name, phase: "start", status: "running", ...extra } };
}

function lifecycle(data: Record<string, unknown>): AgentEvent {
  return { stream: "lifecycle", data };
}

function terminalEventsForRun(runId: string) {
  return emitAgentEvent.mock.calls
    .map(([event]) => event)
    .filter(
      (event) =>
        event.runId === runId &&
        event.stream === "lifecycle" &&
        (event.data.phase === "end" || event.data.phase === "error"),
    );
}

function terminalData(runId: string, sessionKey?: string) {
  const events = terminalEventsForRun(runId);
  expect(events).toHaveLength(1);
  const event = expectDefined(events[0], "terminal event");
  if (sessionKey) {
    expectRecordFields(event, { sessionKey });
  }
  return event.data;
}

beforeEach(() => {
  sanitizerState.sanitizeUserFacingText.mockClear();
  resetDiagnosticRunActivityForTest();
});

async function executeTestTurn(
  params?: Parameters<typeof createMinimalRunAgentTurnParams>[0],
  overrides?: Partial<AgentTurnParams>,
) {
  return executeAgentTurn({ ...createMinimalRunAgentTurnParams(params), ...overrides });
}

function executeOptions(opts: GetReplyOptions) {
  return executeTestTurn({ opts }, { commandBody: "hello" });
}

describe("executeAgentTurn: lifecycle progress", () => {
  it("keeps operational agent events from resetting repeated request evidence", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      const sessionId = params.sessionId ?? "session";
      const sessionKey = params.sessionKey ?? "main";
      markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId: params.runId });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        markDiagnosticModelStartedForTest({
          sessionId,
          sessionKey,
          runId: params.runId,
          provider: "mock",
          model: "request-model",
          observationUnit: "request",
        });
      }
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })
          .repeatedRequestNoProgressAgeMs,
      ).toBe(0);

      for (const event of [
        {
          stream: "item",
          data: { kind: "preamble", phase: "update", progressText: "Working" },
        },
        { stream: "tool", data: { phase: "start", name: "read", toolCallId: "call-1" } },
        {
          stream: "tool",
          data: { phase: "result", name: "read", toolCallId: "call-1", isError: false },
        },
        { stream: "item", data: { phase: "end", status: "completed", itemId: "item-1" } },
        { stream: "thinking", data: { delta: "internal" } },
        { stream: "custom.runtime", data: { status: "ready" } },
      ]) {
        await params.onAgentEvent?.(event);
      }
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })
          .repeatedRequestNoProgressAgeMs,
      ).toBeGreaterThanOrEqual(0);
      return finalResult();
    });

    await executeTestTurn();
  });

  it("forwards suppression facts alongside the matching raw tool event", async () => {
    const onItemEvent = vi.fn();
    const onToolStart = vi.fn();
    mockEvents([
      itemStart("bash", {
        itemId: "cmd-1",
        toolCallId: "cmd-1",
        kind: "command",
        title: "Command",
        suppressChannelProgress: true,
      }),
      toolStart(
        "bash",
        { command: "pnpm test" },
        {
          itemId: "cmd-1",
          toolCallId: "cmd-1",
        },
      ),
    ]);

    const result = await executeTestTurn({
      opts: { onItemEvent, onToolStart } satisfies GetReplyOptions,
    });

    expect(result.kind).toBe("success");
    expect(onItemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "cmd-1", suppressChannelProgress: true }),
    );
    expect(onToolStart).toHaveBeenCalledWith({
      itemId: "cmd-1",
      toolCallId: "cmd-1",
      name: "bash",
      phase: "start",
      args: { command: "pnpm test" },
      detailMode: undefined,
    });
  });

  it("forwards quiet item facts while keeping hidden raw tool starts private", async () => {
    const onItemEvent = vi.fn();
    const onToolStart = vi.fn();
    mockEvents([
      toolStart("exec", { command: "pwd" }),
      itemStart("exec", {
        itemId: "tool:exec-1",
        kind: "tool",
        title: "exec pwd",
      }),
      toolStart("wait", { runId: "ordinary_wait" }),
      toolStart("wait", { runId: "cm_1" }, { hideFromChannelProgress: true }),
      itemStart("wait", {
        itemId: "tool:wait-1",
        kind: "tool",
        title: "wait",
        hideFromChannelProgress: true,
      }),
    ]);

    const result = await executeTestTurn({
      opts: { onItemEvent, onToolStart } satisfies GetReplyOptions,
    });

    expect(result.kind).toBe("success");
    expect(onToolStart).toHaveBeenCalledTimes(2);
    expect(onToolStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: "exec", phase: "start" }),
    );
    expect(onToolStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: "wait", phase: "start" }),
    );
    expect(onItemEvent).toHaveBeenCalledTimes(2);
    expect(onItemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "exec", phase: "start" }),
    );
    expect(onItemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "wait", hideFromChannelProgress: true }),
    );
  });

  it("fires tool-start progress before slow typing signals resolve for best-effort agent events", async () => {
    const onToolStart = vi.fn(async () => {});
    let releaseTyping: (() => void) | undefined;
    const typingSignals = createMockTypingSignaler();
    vi.mocked(typingSignals.signalToolStart).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseTyping = resolve;
        }),
    );
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      void params.onAgentEvent?.(toolStart("exec", { command: "echo hi" }));
      await Promise.resolve();
      await Promise.resolve();
      return finalResult();
    });

    const result = await executeTestTurn({
      opts: { onToolStart } satisfies GetReplyOptions,
      typingSignals,
    });

    try {
      expect(result.kind).toBe("success");
      expect(onToolStart).toHaveBeenCalledWith({
        itemId: undefined,
        toolCallId: undefined,
        name: "exec",
        phase: "start",
        args: { command: "echo hi" },
        detailMode: undefined,
      });
    } finally {
      releaseTyping?.();
      await Promise.resolve();
    }
  });

  it("starts presentation callbacks in source order while typing signals are slow", async () => {
    const callbackOrder: string[] = [];
    const record = (event: string) => () => {
      callbackOrder.push(event);
    };
    let releaseTyping: (() => void) | undefined;
    const typingPending = new Promise<void>((resolve) => {
      releaseTyping = resolve;
    });
    const typingSignals = createMockTypingSignaler();
    vi.mocked(typingSignals.signalMessageStart).mockReturnValue(typingPending);
    vi.mocked(typingSignals.signalTextDelta).mockReturnValue(typingPending);
    vi.mocked(typingSignals.signalReasoningDelta).mockReturnValue(typingPending);
    vi.mocked(typingSignals.signalToolStart).mockReturnValue(typingPending);

    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      void params.onAssistantMessageStart?.();
      void params.onPartialReply?.({ text: "answer before tool" });
      void params.onReasoningStream?.({ text: "reasoning before tool" });
      void params.onReasoningEnd?.();
      void params.onAgentEvent?.(toolStart("exec", { command: "echo hi" }));
      await Promise.resolve();
      await Promise.resolve();
      return finalResult();
    });

    const result = await executeTestTurn({
      opts: {
        preserveProgressCallbackStartOrder: true,
        onAssistantMessageStart: record("message-start"),
        onPartialReply: record("partial"),
        onReasoningStream: record("reasoning"),
        onReasoningEnd: record("reasoning-end"),
        onToolStart: record("tool"),
      } satisfies GetReplyOptions,
      typingSignals,
    });

    try {
      expect(result.kind).toBe("success");
      expect(callbackOrder).toEqual([
        "message-start",
        "partial",
        "reasoning",
        "reasoning-end",
        "tool",
      ]);
    } finally {
      releaseTyping?.();
      await Promise.resolve();
    }
  });

  it("starts typing when a presentation callback throws inline", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await expect(params.onPartialReply?.({ text: "before failure" })).rejects.toThrow(
        "presentation failed",
      );
      return finalResult();
    });
    const typingSignals = createMockTypingSignaler();
    const result = await executeTestTurn({
      opts: {
        preserveProgressCallbackStartOrder: true,
        onPartialReply: () => {
          throw new Error("presentation failed");
        },
      },
      typingSignals,
    });

    expect(result.kind).toBe("success");
    expect(typingSignals.signalTextDelta).toHaveBeenCalledWith("before failure");
  });

  it("materializes sanitizer-empty partial text to undefined", async () => {
    let captured: PartialReplyPayload | undefined;
    const typingSignals = createMockTypingSignaler();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onPartialReply?.({ text: "[tool calls omitted]" });
      return { payloads: [], meta: {} };
    });

    await executeTestTurn(
      {
        opts: {
          onPartialReply: (payload) => {
            captured = payload;
          },
        },
      },
      { typingSignals },
    );

    expect(captured).toBeDefined();
    expect(sanitizerState.sanitizeUserFacingText).not.toHaveBeenCalled();
    expect(captured?.text).toBeUndefined();
    expect(captured?.text).toBeUndefined();
    expect(sanitizerState.sanitizeUserFacingText).toHaveBeenCalledTimes(1);
    expect(typingSignals.signalTextDelta).toHaveBeenCalledWith("[tool calls omitted]");
  });

  it("leaves Codex app-server telemetry publication to the harness", async () => {
    mockEvents([
      {
        stream: "codex_app_server.guardian",
        sessionKey: "agent:main:subagent:codex-child",
        data: {
          phase: "blocked",
          message: "command requires approval",
        },
      },
    ]);

    const result = await executeOptions({ runId: "run-codex" });

    expect(result.kind).toBe("success");
    expectNoMockCallWithFields(emitAgentEvent, {
      runId: "run-codex",
      stream: "codex_app_server.guardian",
    });
  });

  it("publishes the timeout explanation and records failed dispatch through the lifecycle backstop", async () => {
    const onAgentRunTerminalOutcome = vi.fn();
    const timeoutText = "Request timed out before a response was generated. Please try again.";
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.(lifecycle({ phase: "start", startedAt: 1_000 }));
      return {
        payloads: [
          { text: "An earlier tool failed.", isError: true },
          { text: timeoutText, isError: true },
        ],
        meta: {
          error: { kind: "incomplete_turn", message: timeoutText, fallbackSafe: false },
          aborted: false,
          stopReason: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
          livenessState: "blocked",
          replayInvalid: false,
        },
      };
    });

    const result = await executeOptions({ runId: "run-timeout", onAgentRunTerminalOutcome });

    expect(result.kind).toBe("success");
    expect(onAgentRunTerminalOutcome).toHaveBeenCalledExactlyOnceWith("failed");
    const lifecycleData = terminalData("run-timeout", "main");
    expectRecordFields(lifecycleData, {
      phase: "error",
      error: timeoutText,
      startedAt: 1_000,
      aborted: false,
      stopReason: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
      livenessState: "blocked",
      replayInvalid: false,
    });
    expect(typeof lifecycleData.endedAt).toBe("number");
  });

  it("preserves explicit deferred guidance over distinct timeout metadata and payload errors", async () => {
    const deferredError = "Reconnect the selected provider, then try again.";
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await sendEvents(params, [
        lifecycle({ phase: "start" }),
        lifecycle({ phase: "finishing", error: deferredError, livenessState: "blocked" }),
      ]);
      return {
        payloads: [{ text: "Rendered payload diagnostic.", isError: true }],
        meta: {
          error: { kind: "incomplete_turn", message: "Internal provider diagnostic." },
          stopReason: "timeout",
          timeoutPhase: "provider",
        },
      };
    });

    await executeTestTurn({ opts: { runId: "run-deferred-diagnostic" } });

    const terminalEvents = terminalEventsForRun("run-deferred-diagnostic");
    expect(terminalEvents).toHaveLength(1);
    const lifecycleEvent = expectDefined(terminalEvents[0], "terminal lifecycle event");
    expectRecordFields(lifecycleEvent.data, {
      phase: "error",
      error: deferredError,
    });
    expect(JSON.stringify(lifecycleEvent)).not.toContain("Internal provider diagnostic.");
    expect(JSON.stringify(lifecycleEvent)).not.toContain("Rendered payload diagnostic.");
  });

  it("does not turn a tool error into terminal failure for a successful run", async () => {
    const stopReason = "completed";
    const aborted = false;
    const onAgentRunTerminalOutcome = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.(lifecycle({ phase: "start" }));
      return {
        payloads: [
          { text: "A tool timed out before the run settled.", isError: true },
          { text: "Settled output." },
        ],
        meta: { stopReason, aborted, replayInvalid: false },
      };
    });

    const result = await executeTestTurn({
      opts: { runId: "run-tool-diagnostic", onAgentRunTerminalOutcome },
    });

    expect(result.kind).toBe("success");
    expect(onAgentRunTerminalOutcome).not.toHaveBeenCalledWith("failed");
    const lifecycleData = terminalData("run-tool-diagnostic");
    expectRecordFields(lifecycleData, {
      phase: "end",
      stopReason,
      aborted,
      replayInvalid: false,
    });
    expect(lifecycleData).not.toHaveProperty("error");
  });

  it("shows only the successful reply after a transient provider retry", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await sendEvents(params, [
        lifecycle({ phase: "start", startedAt: 1_000 }),
        lifecycle({
          phase: "finishing",
          error: "provider rejected the first attempt",
          livenessState: "blocked",
          aborted: false,
        }),
        lifecycle({ phase: "start", startedAt: 2_000 }),
        lifecycle({ phase: "finishing", livenessState: "working", aborted: false }),
      ]);
      return {
        payloads: [{ text: "recovered" }],
        meta: { stopReason: "stop", livenessState: "working", aborted: false },
      };
    });

    const result = await executeOptions({ runId: "run-recovered", onBlockReply });

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads).toEqual([{ text: "recovered" }]);
    }
    expect(onBlockReply).not.toHaveBeenCalled();
    expectRecordFields(terminalData("run-recovered", "main"), {
      phase: "end",
      startedAt: 2_000,
      stopReason: "stop",
      livenessState: "working",
      aborted: false,
    });
  });

  it("uses a rebound lifecycle generation for embedded terminal events", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionStarted?.({ lifecycleGeneration: "post-restart" });
      await params.onAgentEvent?.(lifecycle({ phase: "start", startedAt: 1_000 }));
      throw new Error("rebound failure");
    });

    const result = await executeOptions({ runId: "run-rebound" });

    expect(result.kind).toBe("final");
    const lifecycleEvents = emitAgentEvent.mock.calls
      .map((call) => call[0])
      .filter(
        (event) =>
          event.runId === "run-rebound" &&
          event.stream === "lifecycle" &&
          (event.data.phase === "error" || event.data.fallbackExhaustedFailure === true),
      );
    expect(lifecycleEvents.length).toBeGreaterThan(0);
    expect(lifecycleEvents.every((event) => event.lifecycleGeneration === "post-restart")).toBe(
      true,
    );
  });

  it("does not duplicate embedded lifecycle terminal events already reported by the runner", async () => {
    mockEvents([
      lifecycle({ phase: "start", startedAt: 1_000 }),
      lifecycle({ phase: "end", endedAt: 1_500 }),
    ]);

    const result = await executeOptions({ runId: "run-complete" });

    expect(result.kind).toBe("success");
    const terminalEvents = terminalEventsForRun("run-complete");
    expect(terminalEvents).toEqual([]);
  });
});
