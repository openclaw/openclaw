import { describe, expect, it, vi } from "vitest";
import { createEventHandlers } from "./tui-event-handlers.js";
import type { AgentEvent, ChatEvent, SessionEvent, TuiStateAccess } from "./tui-types.js";

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
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
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

    expect(setActivityStatus).toHaveBeenCalledWith("running");
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
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

    const agentEvt: AgentEvent = {
      runId: "run-42",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec" },
    };

    handleAgentEvent(agentEvt);

    expect(chatLog.startTool).toHaveBeenCalledWith("tc1", "exec", undefined);
  });

  it("accepts chat events when session key is an alias of the active canonical key", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: {
        currentSessionKey: "agent:main:main",
        activeChatRunId: null,
      },
    });

    handleChatEvent({
      runId: "run-alias",
      sessionKey: "main",
      state: "delta",
      message: { content: "hello" },
    });

    expect(state.activeChatRunId).toBe("run-alias");
    expect(chatLog.updateAssistant).toHaveBeenCalledWith("hello", "run-alias");
  });

  it("does not cross-match canonical session keys from different agents", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({
      state: {
        currentAgentId: "alpha",
        currentSessionKey: "agent:alpha:main",
        activeChatRunId: null,
      },
    });

    handleChatEvent({
      runId: "run-other-agent",
      sessionKey: "agent:beta:main",
      state: "delta",
      message: { content: "should be ignored" },
    });

    expect(chatLog.updateAssistant).not.toHaveBeenCalled();
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

    handleAgentEvent({
      runId: "run-123",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-off", name: "session_status" },
    });

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("omits tool output when verbose is on (non-full)", () => {
    const { chatLog, handleAgentEvent } = createHandlersHarness({
      state: {
        activeChatRunId: "run-123",
        sessionInfo: { verboseLevel: "on" },
      },
    });

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
    const { state, chatLog, setActivityStatus, loadHistory, handleChatEvent } =
      createHandlersHarness({
        state: { activeChatRunId: "run-active" },
      });

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

  it("renders final error text when chat final has no content but includes event errorMessage", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: null },
    });

    handleChatEvent({
      runId: "run-error-envelope",
      sessionKey: state.currentSessionKey,
      state: "final",
      message: { content: [] },
      errorMessage: '401 {"error":{"message":"Missing scopes: model.request"}}',
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
    const [rendered] = chatLog.finalizeAssistant.mock.calls[0] ?? [];
    expect(String(rendered)).toContain("HTTP 401");
    expect(String(rendered)).toContain("Missing scopes: model.request");
    expect(chatLog.dropAssistant).not.toHaveBeenCalledWith("run-error-envelope");
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

  it("reloads history when a local run ends without a displayable final message", () => {
    const { state, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      state: { activeChatRunId: "run-local-silent" },
    });

    noteLocalRunId("run-local-silent");

    handleChatEvent({
      runId: "run-local-silent",
      sessionKey: state.currentSessionKey,
      state: "final",
    });

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });
});

describe("tui-event-handlers: handleSessionEvent", () => {
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
    const refreshSessionInfo = vi.fn();
    const localRunIds = new Set<string>();
    const noteLocalRunId = (runId: string) => {
      localRunIds.add(runId);
    };
    const forgetLocalRunId = localRunIds.delete.bind(localRunIds);
    const isLocalRunId = localRunIds.has.bind(localRunIds);
    const clearLocalRunIds = vi.fn(() => localRunIds.clear());

    return {
      chatLog,
      tui,
      state,
      setActivityStatus,
      loadHistory,
      refreshSessionInfo,
      noteLocalRunId,
      forgetLocalRunId,
      isLocalRunId,
      clearLocalRunIds,
    };
  };

  const createSessionHarness = (params?: { state?: Partial<TuiStateAccess> }) => {
    const state = makeState(params?.state);
    const context = makeContext(state);
    const handlers = createEventHandlers({
      chatLog: context.chatLog,
      tui: context.tui,
      state,
      setActivityStatus: context.setActivityStatus,
      loadHistory: context.loadHistory,
      refreshSessionInfo: context.refreshSessionInfo,
      isLocalRunId: context.isLocalRunId,
      forgetLocalRunId: context.forgetLocalRunId,
      clearLocalRunIds: context.clearLocalRunIds,
    });
    return {
      ...context,
      state,
      ...handlers,
    };
  };

  it("refreshes history on current-session external reset event", () => {
    const {
      state,
      loadHistory,
      refreshSessionInfo,
      setActivityStatus,
      clearLocalRunIds,
      tui,
      handleSessionEvent,
    } = createSessionHarness({
      state: { activeChatRunId: "run-active", historyLoaded: true },
    });

    const sessionEvt: SessionEvent = {
      type: "reset",
      sessionKey: state.currentSessionKey,
      reason: "reset",
    };

    handleSessionEvent(sessionEvt);

    expect(state.activeChatRunId).toBeNull();
    expect(clearLocalRunIds).toHaveBeenCalledTimes(1);
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(refreshSessionInfo).toHaveBeenCalledTimes(1);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("ignores reset event for a different session", () => {
    const {
      state,
      loadHistory,
      refreshSessionInfo,
      setActivityStatus,
      clearLocalRunIds,
      tui,
      handleSessionEvent,
    } = createSessionHarness({
      state: { activeChatRunId: "run-active", currentSessionKey: "agent:main:main" },
    });

    const sessionEvt: SessionEvent = {
      type: "reset",
      sessionKey: "agent:other:other",
      reason: "reset",
    };

    handleSessionEvent(sessionEvt);

    expect(state.activeChatRunId).toBe("run-active");
    expect(clearLocalRunIds).not.toHaveBeenCalled();
    expect(setActivityStatus).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(refreshSessionInfo).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("ignores stale tool events from old runs after external reset", () => {
    const { state, chatLog, tui, handleChatEvent, handleSessionEvent, handleAgentEvent } =
      createSessionHarness({
        state: { activeChatRunId: null, currentSessionKey: "agent:main:main" },
      });

    // Step 1: Create a current-session run that becomes known to TUI state
    const oldRunId = "run-old";
    handleChatEvent({
      runId: oldRunId,
      sessionKey: state.currentSessionKey,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });

    // Verify the run is tracked
    expect(state.activeChatRunId).toBe(oldRunId);

    // Step 2: Send a current-session session reset event
    const sessionEvt: SessionEvent = {
      type: "reset",
      sessionKey: state.currentSessionKey,
      reason: "reset",
    };
    handleSessionEvent(sessionEvt);

    // Verify reset cleared state
    expect(state.activeChatRunId).toBeNull();

    // Capture requestRender call count after reset
    const requestRenderCallsAfterReset = tui.requestRender.mock.calls.length;

    // Step 3: Send a stale agent tool event for the old runId
    const staleToolEvt: AgentEvent = {
      runId: oldRunId,
      stream: "tool",
      data: {
        phase: "start",
        toolCallId: "tc-stale",
        name: "exec",
        args: { command: "echo stale" },
      },
    };
    handleAgentEvent(staleToolEvt);

    // Step 4: Assert that the stale tool event is ignored after reset
    // startTool should not be called for the stale event
    expect(chatLog.startTool).not.toHaveBeenCalled();
    // requestRender should not be called again after reset (only from initial delta and reset)
    expect(tui.requestRender.mock.calls.length).toBe(requestRenderCallsAfterReset);
  });
});
