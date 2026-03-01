import { describe, expect, it, vi } from "vitest";
import { createEventHandlers } from "./tui-event-handlers.js";
import type { AgentEvent, ChatEvent, TuiStateAccess } from "./tui-types.js";

type MockFn = ReturnType<typeof vi.fn>;
type HandlerChatLog = {
  startTool: (...args: unknown[]) => void;
  updateToolResult: (...args: unknown[]) => void;
  addSystem: (...args: unknown[]) => void;
  updateAssistant: (...args: unknown[]) => void;
  finalizeAssistant: (...args: unknown[]) => void;
  dropAssistant: (...args: unknown[]) => void;
};
type HandlerTui = { requestRender: (...args: unknown[]) => void };
type MockChatLog = {
  startTool: MockFn;
  updateToolResult: MockFn;
  addSystem: MockFn;
  updateAssistant: MockFn;
  finalizeAssistant: MockFn;
  dropAssistant: MockFn;
};
type MockTui = { requestRender: MockFn };

function createMockChatLog(): MockChatLog & HandlerChatLog {
  return {
    startTool: vi.fn(),
    updateToolResult: vi.fn(),
    addSystem: vi.fn(),
    updateAssistant: vi.fn(),
    finalizeAssistant: vi.fn(),
    dropAssistant: vi.fn(),
  } as unknown as MockChatLog & HandlerChatLog;
}

describe("tui-event-handlers: handleAgentEvent", () => {
  const makeState = (overrides?: Partial<TuiStateAccess>): TuiStateAccess => ({
    agentDefaultId: "main",
    sessionMainKey: "agent:main:main",
    sessionScope: "global",
    agents: [],
    currentAgentId: "main",
    currentSessionKey: "agent:main:main",
    currentSessionId: "session-1",
    activeChatRunId: "run-1",
    historyLoaded: true,
    sessionInfo: { verboseLevel: "on" },
    initialSessionApplied: true,
    isConnected: true,
    autoMessageSent: false,
    toolsExpanded: false,
    showThinking: false,
    connectionStatus: "connected",
    activityStatus: "idle",
    statusTimeout: null,
    lastCtrlCAt: 0,
    ...overrides,
  });

  const makeContext = (state: TuiStateAccess) => {
    const chatLog = createMockChatLog();
    const tui = { requestRender: vi.fn() } as unknown as MockTui & HandlerTui;
    const setActivityStatus = vi.fn();
    const loadHistory = vi.fn();
    const localRunIds = new Set<string>();
    const noteLocalRunId = (runId: string) => {
      localRunIds.add(runId);
    };
    const forgetLocalRunId = localRunIds.delete.bind(localRunIds);
    const isLocalRunId = localRunIds.has.bind(localRunIds);
    const clearLocalRunIds = localRunIds.clear.bind(localRunIds);

    return {
      chatLog,
      tui,
      state,
      setActivityStatus,
      loadHistory,
      noteLocalRunId,
      forgetLocalRunId,
      isLocalRunId,
      clearLocalRunIds,
    };
  };

  const createHandlersHarness = (params?: {
    state?: Partial<TuiStateAccess>;
    chatLog?: HandlerChatLog;
  }) => {
    const state = makeState(params?.state);
    const context = makeContext(state);
    const chatLog = (params?.chatLog ?? context.chatLog) as MockChatLog & HandlerChatLog;
    const handlers = createEventHandlers({
      chatLog,
      tui: context.tui,
      state,
      setActivityStatus: context.setActivityStatus,
      loadHistory: context.loadHistory,
      isLocalRunId: context.isLocalRunId,
      forgetLocalRunId: context.forgetLocalRunId,
    });
    return {
      ...context,
      state,
      chatLog,
      ...handlers,
    };
  };

  it("processes tool events when runId matches activeChatRunId (even if sessionId differs)", () => {
    const { chatLog, tui, handleAgentEvent } = createHandlersHarness({
      state: { currentSessionId: "session-xyz", activeChatRunId: "run-123" },
    });
    handleAgentEvent({ runId: "run-123", stream: "lifecycle", data: { phase: "start" } });

    const evt: AgentEvent = {
      runId: "run-123",
      stream: "tool",
      data: {
        phase: "start",
        toolCallId: "tc1",
        name: "exec",
        args: { command: "echo hi" },
      },
    };

    handleAgentEvent(evt);

    expect(chatLog.startTool).toHaveBeenCalledWith("tc1", "exec", { command: "echo hi" });
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("ignores tool events when runId does not match activeChatRunId", () => {
    const { chatLog, tui, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-1" },
    });

    const evt: AgentEvent = {
      runId: "run-2",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec" },
    };

    handleAgentEvent(evt);

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(chatLog.updateToolResult).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("processes lifecycle events when runId matches activeChatRunId", () => {
    const chatLog = createMockChatLog();
    const { tui, setActivityStatus, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-9" },
      chatLog,
    });

    const evt: AgentEvent = {
      runId: "run-9",
      stream: "lifecycle",
      data: { phase: "start" },
    };

    handleAgentEvent(evt);

    expect(setActivityStatus).toHaveBeenCalledWith("running (think auto)");
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("updates effective think from lifecycle generating metadata", () => {
    const { state, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-9",
        sessionInfo: { verboseLevel: "on", configuredThink: "auto", lastEffectiveThink: "xhigh" },
      },
    });

    handleAgentEvent({
      runId: "run-9",
      stream: "lifecycle",
      data: { phase: "start", generating: { thinkingLevel: "medium" } },
    });

    expect(state.sessionInfo.effectiveThink).toBe("medium");
    expect(state.sessionInfo.lastEffectiveThink).toBe("medium");
  });

  it("prefers lifecycle effectiveThink when provided", () => {
    const { state, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-9",
        sessionInfo: { verboseLevel: "on", configuredThink: "auto", lastEffectiveThink: "low" },
      },
    });

    handleAgentEvent({
      runId: "run-9",
      stream: "lifecycle",
      data: { phase: "start", effectiveThink: "high", generating: { thinkingLevel: "medium" } },
    });

    expect(state.sessionInfo.effectiveThink).toBe("high");
    expect(state.sessionInfo.lastEffectiveThink).toBe("high");
  });

  it("extracts router and generation pass tokens from lifecycle generating.routingPass", () => {
    const { state, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-tokens",
        sessionInfo: { verboseLevel: "on" },
      },
    });

    handleAgentEvent({
      runId: "run-tokens",
      stream: "lifecycle",
      data: {
        phase: "start",
        generating: {
          thinkingLevel: "low",
          routingPass: {
            pass: 2,
            pass1TokenUsage: { input: 100, output: 5 },
            pass2TokenUsage: { input: 500, output: 120 },
          },
        },
      },
    });

    expect(state.sessionInfo.routerPassTokens).toEqual({ input: 100, output: 5 });
    expect(state.sessionInfo.generationPassTokens).toEqual({ input: 500, output: 120 });
  });

  it("shows resolved think status during router phase", () => {
    const { state, handleAgentEvent, setActivityStatus } = createHandlersHarness({
      state: {
        activeChatRunId: "run-router-think",
        sessionInfo: { verboseLevel: "on", configuredThink: "auto" },
      },
    });

    handleAgentEvent({
      runId: "run-router-think",
      stream: "lifecycle",
      data: {
        phase: "router",
        generating: {
          thinkingLevel: "high",
          routingPass: {
            pass: 1,
            pass1TokenUsage: { input: 120, output: 8 },
          },
        },
      },
    });

    expect(state.sessionInfo.routerPassTokens).toEqual({ input: 120, output: 8 });
    expect(setActivityStatus).toHaveBeenCalledWith("routing (think auto→high)");
  });

  it("shows served model in running status when lifecycle includes it", () => {
    const { state, handleAgentEvent, setActivityStatus } = createHandlersHarness({
      state: {
        activeChatRunId: "run-served",
        sessionInfo: { verboseLevel: "on", configuredThink: "auto" },
      },
    });

    handleAgentEvent({
      runId: "run-served",
      stream: "lifecycle",
      data: {
        phase: "start",
        effectiveThink: "medium",
        servedProvider: "openrouter",
        servedModel: "openrouter/anthropic/claude-sonnet-4-6",
      },
    });

    expect(state.sessionInfo.servedModelProvider).toBe("openrouter");
    expect(state.sessionInfo.servedModel).toBe("openrouter/anthropic/claude-sonnet-4-6");
    expect(setActivityStatus).toHaveBeenCalledWith(
      "running (think auto→medium) · model openrouter/anthropic/claude-sonnet-4-6",
    );
  });

  it("clears pass tokens on lifecycle end", () => {
    const { state, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-clear",
        sessionInfo: {
          routerPassTokens: { input: 50, output: 2 },
          generationPassTokens: { input: 200, output: 30 },
        },
      },
    });

    handleAgentEvent({
      runId: "run-clear",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(state.sessionInfo.routerPassTokens).toBeNull();
    expect(state.sessionInfo.generationPassTokens).toBeNull();
  });

  it("sets generationPassTokens from chat final usage", () => {
    const { state, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleAgentEvent({
      runId: "run-usage",
      stream: "lifecycle",
      data: { phase: "start", sessionKey: state.currentSessionKey },
    });

    handleChatEvent({
      runId: "run-usage",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [{ type: "text", text: "done" }] },
      usage: { input: 1000, output: 250 },
    });

    expect(state.sessionInfo.generationPassTokens).toEqual({ input: 1000, output: 250 });
  });

  it("buffers assistant delta until lifecycle start is processed", () => {
    const { state, chatLog, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-11",
        sessionInfo: { verboseLevel: "on", configuredThink: "auto" },
      },
    });

    handleChatEvent({
      runId: "run-11",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "partial before start" },
    });
    expect(chatLog.updateAssistant).not.toHaveBeenCalled();

    handleAgentEvent({
      runId: "run-11",
      stream: "lifecycle",
      data: {
        phase: "start",
        configuredThink: "auto",
        generating: { thinkingLevel: "medium" },
      },
    });

    expect(chatLog.updateAssistant).toHaveBeenCalled();
    expect(state.sessionInfo.currentRunId).toBe("run-11");
    expect(state.sessionInfo.configuredThink).toBe("auto");
    expect(state.sessionInfo.effectiveThink).toBe("medium");
  });

  it("captures runId from chat events when activeChatRunId is unset", () => {
    const { state, chatLog, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    const chatEvt: ChatEvent = {
      runId: "run-42",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    };

    handleChatEvent(chatEvt);

    expect(state.activeChatRunId).toBe("run-42");
    handleAgentEvent({ runId: "run-42", stream: "lifecycle", data: { phase: "start" } });

    const agentEvt: AgentEvent = {
      runId: "run-42",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec" },
    };

    handleAgentEvent(agentEvt);

    expect(chatLog.startTool).toHaveBeenCalledWith("tc1", "exec", undefined);
  });

  it("accepts lifecycle start before chat delta for current session", () => {
    const { state, setActivityStatus, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: null,
        sessionInfo: { verboseLevel: "on", configuredThink: "auto" },
      },
    });

    handleAgentEvent({
      runId: "run-early",
      stream: "lifecycle",
      data: {
        phase: "start",
        sessionKey: state.currentSessionKey,
        configuredThink: "auto",
        generating: { thinkingLevel: "medium" },
      },
    });

    expect(state.activeChatRunId).toBe("run-early");
    expect(state.sessionInfo.currentRunId).toBe("run-early");
    expect(state.sessionInfo.effectiveThink).toBe("medium");
    expect(setActivityStatus).toHaveBeenCalledWith("running (think auto→medium)");
  });

  it("clears run mapping when the session changes", () => {
    const { state, chatLog, tui, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-old",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    });

    state.currentSessionKey = "agent:main:other";
    state.activeChatRunId = null;
    tui.requestRender.mockClear();

    handleAgentEvent({
      runId: "run-old",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc2", name: "exec" },
    });

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("accepts tool events after chat final for the same run", () => {
    const { state, chatLog, tui, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });
    handleAgentEvent({ runId: "run-final", stream: "lifecycle", data: { phase: "start" } });

    handleChatEvent({
      runId: "run-final",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [{ type: "text", text: "done" }] },
    });

    handleAgentEvent({
      runId: "run-final",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-final", name: "session_status" },
    });

    expect(chatLog.startTool).toHaveBeenCalledWith("tc-final", "session_status", undefined);
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("ignores lifecycle updates for non-active runs in the same session", () => {
    const { state, tui, setActivityStatus, handleChatEvent, handleAgentEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-active" },
      });

    handleChatEvent({
      runId: "run-other",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    });
    setActivityStatus.mockClear();
    tui.requestRender.mockClear();

    handleAgentEvent({
      runId: "run-other",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(setActivityStatus).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("suppresses tool events when verbose is off", () => {
    const { chatLog, tui, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-123",
        sessionInfo: { verboseLevel: "off" },
      },
    });
    handleAgentEvent({ runId: "run-123", stream: "lifecycle", data: { phase: "start" } });
    const rendersBeforeTool = tui.requestRender.mock.calls.length;

    handleAgentEvent({
      runId: "run-123",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-off", name: "session_status" },
    });

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(tui.requestRender.mock.calls.length).toBe(rendersBeforeTool);
  });

  it("omits tool output when verbose is on (non-full)", () => {
    const { chatLog, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-123",
        sessionInfo: { verboseLevel: "on" },
      },
    });
    handleAgentEvent({ runId: "run-123", stream: "lifecycle", data: { phase: "start" } });

    handleAgentEvent({
      runId: "run-123",
      stream: "tool",
      data: {
        phase: "update",
        toolCallId: "tc-on",
        name: "session_status",
        partialResult: { content: [{ type: "text", text: "secret" }] },
      },
    });

    handleAgentEvent({
      runId: "run-123",
      stream: "tool",
      data: {
        phase: "result",
        toolCallId: "tc-on",
        name: "session_status",
        result: { content: [{ type: "text", text: "secret" }] },
        isError: false,
      },
    });

    expect(chatLog.updateToolResult).toHaveBeenCalledTimes(1);
    expect(chatLog.updateToolResult).toHaveBeenCalledWith(
      "tc-on",
      { content: [] },
      { isError: false },
    );
  });

  it("refreshes history after a non-local chat final", () => {
    const { state, loadHistory, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "external-run",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [{ type: "text", text: "done" }] },
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  function createConcurrentRunHarness(localContent = "partial") {
    const { state, chatLog, setActivityStatus, loadHistory, handleChatEvent, handleAgentEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-active" },
      });
    handleAgentEvent({ runId: "run-active", stream: "lifecycle", data: { phase: "start" } });

    handleChatEvent({
      runId: "run-active",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: localContent },
    });

    return { state, chatLog, setActivityStatus, loadHistory, handleChatEvent };
  }

  it("does not reload history or clear active run when another run final arrives mid-stream", () => {
    const { state, chatLog, setActivityStatus, loadHistory, handleChatEvent } =
      createConcurrentRunHarness("partial");

    loadHistory.mockClear();
    setActivityStatus.mockClear();

    handleChatEvent({
      runId: "run-other",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [{ type: "text", text: "other final" }] },
    });

    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");

    handleChatEvent({
      runId: "run-active",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "continued" },
    });

    expect(chatLog.updateAssistant).toHaveBeenLastCalledWith("continued", "run-active");
  });

  it("suppresses non-local empty final placeholders during concurrent runs", () => {
    const { state, chatLog, loadHistory, handleChatEvent } =
      createConcurrentRunHarness("local stream");

    loadHistory.mockClear();
    chatLog.finalizeAssistant.mockClear();
    chatLog.dropAssistant.mockClear();

    handleChatEvent({
      runId: "run-other",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [] },
    });

    expect(chatLog.finalizeAssistant).not.toHaveBeenCalledWith("(no output)", "run-other");
    expect(chatLog.dropAssistant).toHaveBeenCalledWith("run-other");
    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
  });

  it("drops streaming assistant when chat final has no message", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-silent",
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { content: "hello" },
    });
    chatLog.dropAssistant.mockClear();
    chatLog.finalizeAssistant.mockClear();

    handleChatEvent({
      runId: "run-silent",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(chatLog.dropAssistant).toHaveBeenCalledWith("run-silent");
    expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
  });
});
