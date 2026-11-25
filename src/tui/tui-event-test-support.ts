import { type Mock, vi } from "vitest";
import type { createEventHandlers } from "./tui-event-handlers.js";
import type { TuiStateAccess } from "./tui-types.js";

type HandlerContext = Parameters<typeof createEventHandlers>[0];
type HandlerChatLog = HandlerContext["chatLog"];
type HandlerBtwPresenter = HandlerContext["btw"];
type MockChatLog = { [Key in keyof HandlerChatLog]: Mock<HandlerChatLog[Key]> };
type MockBtwPresenter = { [Key in keyof HandlerBtwPresenter]: Mock<HandlerBtwPresenter[Key]> };

export function createMockChatLog(): MockChatLog {
  return {
    addLiveUser: vi.fn<HandlerChatLog["addLiveUser"]>(),
    startTool: vi.fn<HandlerChatLog["startTool"]>(),
    updateToolResult: vi.fn<HandlerChatLog["updateToolResult"]>(),
    addSystem: vi.fn<HandlerChatLog["addSystem"]>(),
    addPendingSystem: vi.fn<HandlerChatLog["addPendingSystem"]>(),
    dismissPendingSystem: vi.fn<HandlerChatLog["dismissPendingSystem"]>(),
    updateAssistant: vi.fn<HandlerChatLog["updateAssistant"]>(),
    finalizeAssistant: vi.fn<HandlerChatLog["finalizeAssistant"]>(),
    dropAssistant: vi.fn<HandlerChatLog["dropAssistant"]>(),
  };
}

export function createMockBtwPresenter(): MockBtwPresenter {
  return {
    showResult: vi.fn<HandlerBtwPresenter["showResult"]>(),
    clear: vi.fn<HandlerBtwPresenter["clear"]>(),
  };
}

export function makeTuiState(overrides: Partial<TuiStateAccess> = {}): TuiStateAccess {
  return {
    agentDefaultId: "main",
    sessionMainKey: "agent:main:main",
    sessionScope: "global",
    agents: [],
    currentAgentId: "main",
    currentSessionKey: "agent:main:main",
    currentSessionId: "session-1",
    activeChatRunId: null,
    pendingSubmit: null,
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
  };
}
