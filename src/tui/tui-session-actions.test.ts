import { describe, expect, it, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import type { GatewayChatClient } from "./gateway-chat.js";
import { createSessionActions } from "./tui-session-actions.js";
import type { TuiStateAccess } from "./tui-types.js";

describe("tui session actions", () => {
  it("queues session refreshes and applies the latest result", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;

    const listSessions = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const state: TuiStateAccess = {
      agentDefaultId: "main",
      sessionMainKey: "agent:main:main",
      sessionScope: "global",
      agents: [],
      currentAgentId: "main",
      currentSessionKey: "agent:main:main",
      currentSessionId: null,
      activeChatRunId: null,
      historyLoaded: false,
      sessionInfo: {},
      initialSessionApplied: true,
      isConnected: true,
      autoMessageSent: false,
      toolsExpanded: false,
      showThinking: false,
      connectionStatus: "connected",
      activityStatus: "idle",
      statusTimeout: null,
      lastCtrlCAt: 0,
    };

    const updateFooter = vi.fn();
    const updateAutocompleteProvider = vi.fn();
    const requestRender = vi.fn();

    const { refreshSessionInfo } = createSessionActions({
      client: { listSessions } as unknown as GatewayChatClient,
      chatLog: { addSystem: vi.fn() } as unknown as import("./components/chat-log.js").ChatLog,
      tui: { requestRender } as unknown as import("@mariozechner/pi-tui").TUI,
      opts: {},
      state,
      agentNames: new Map(),
      initialSessionInput: "",
      initialSessionAgentId: null,
      resolveSessionKey: vi.fn(),
      updateHeader: vi.fn(),
      updateFooter,
      updateAutocompleteProvider,
      setActivityStatus: vi.fn(),
    });

    const first = refreshSessionInfo();
    const second = refreshSessionInfo();

    await Promise.resolve();
    expect(listSessions).toHaveBeenCalledTimes(1);

    resolveFirst?.({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [
        {
          key: "agent:main:main",
          model: "old",
          modelProvider: "anthropic",
        },
      ],
    });

    await first;
    await Promise.resolve();

    expect(listSessions).toHaveBeenCalledTimes(2);

    resolveSecond?.({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [
        {
          key: "agent:main:main",
          model: "Minimax-M2.5",
          modelProvider: "minimax",
        },
      ],
    });

    await second;

    expect(state.sessionInfo.model).toBe("Minimax-M2.5");
    expect(updateAutocompleteProvider).toHaveBeenCalledTimes(2);
    expect(updateFooter).toHaveBeenCalledTimes(2);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("suppresses heartbeat poll and heartbeat ack noise when loading history", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [{ key: "agent:main:main" }],
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      thinkingLevel: "off",
      verboseLevel: "off",
      messages: [
        {
          role: "user",
          content: `<relevant-memories>\n${HEARTBEAT_PROMPT}`,
        },
        {
          role: "assistant",
          content: "HEARTBEAT_OK all good",
        },
        {
          role: "assistant",
          content: "Disk usage crossed 95 percent on /data and needs cleanup now.",
        },
        {
          role: "user",
          content: "normal user message",
        },
      ],
    });

    const chatLog = {
      clearAll: vi.fn(),
      addSystem: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      startTool: vi.fn(() => ({ setResult: vi.fn() })),
    };

    const state: TuiStateAccess = {
      agentDefaultId: "main",
      sessionMainKey: "agent:main:main",
      sessionScope: "global",
      agents: [],
      currentAgentId: "main",
      currentSessionKey: "agent:main:main",
      currentSessionId: null,
      activeChatRunId: null,
      historyLoaded: false,
      sessionInfo: {},
      initialSessionApplied: true,
      isConnected: true,
      autoMessageSent: false,
      toolsExpanded: false,
      showThinking: false,
      connectionStatus: "connected",
      activityStatus: "idle",
      statusTimeout: null,
      lastCtrlCAt: 0,
    };

    const { loadHistory: loadSessionHistory } = createSessionActions({
      client: { listSessions, loadHistory } as unknown as GatewayChatClient,
      chatLog: chatLog as unknown as import("./components/chat-log.js").ChatLog,
      tui: { requestRender: vi.fn() } as unknown as import("@mariozechner/pi-tui").TUI,
      opts: {},
      state,
      agentNames: new Map(),
      initialSessionInput: "",
      initialSessionAgentId: null,
      resolveSessionKey: vi.fn(),
      updateHeader: vi.fn(),
      updateFooter: vi.fn(),
      updateAutocompleteProvider: vi.fn(),
      setActivityStatus: vi.fn(),
    });

    await loadSessionHistory();

    expect(loadHistory).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      limit: 200,
    });
    expect(chatLog.clearAll).toHaveBeenCalledTimes(1);
    expect(chatLog.addUser).toHaveBeenCalledTimes(1);
    expect(chatLog.addUser).toHaveBeenCalledWith("normal user message");
    expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith(
      "Disk usage crossed 95 percent on /data and needs cleanup now.",
    );
  });

  it("keeps assistant messages that mention heartbeat prompt text", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [{ key: "agent:main:main" }],
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      thinkingLevel: "off",
      verboseLevel: "off",
      messages: [
        {
          role: "assistant",
          content: `Recap for debugging only: ${HEARTBEAT_PROMPT}`,
        },
      ],
    });

    const chatLog = {
      clearAll: vi.fn(),
      addSystem: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      startTool: vi.fn(() => ({ setResult: vi.fn() })),
    };

    const state: TuiStateAccess = {
      agentDefaultId: "main",
      sessionMainKey: "agent:main:main",
      sessionScope: "global",
      agents: [],
      currentAgentId: "main",
      currentSessionKey: "agent:main:main",
      currentSessionId: null,
      activeChatRunId: null,
      historyLoaded: false,
      sessionInfo: {},
      initialSessionApplied: true,
      isConnected: true,
      autoMessageSent: false,
      toolsExpanded: false,
      showThinking: false,
      connectionStatus: "connected",
      activityStatus: "idle",
      statusTimeout: null,
      lastCtrlCAt: 0,
    };

    const { loadHistory: loadSessionHistory } = createSessionActions({
      client: { listSessions, loadHistory } as unknown as GatewayChatClient,
      chatLog: chatLog as unknown as import("./components/chat-log.js").ChatLog,
      tui: { requestRender: vi.fn() } as unknown as import("@mariozechner/pi-tui").TUI,
      opts: {},
      state,
      agentNames: new Map(),
      initialSessionInput: "",
      initialSessionAgentId: null,
      resolveSessionKey: vi.fn(),
      updateHeader: vi.fn(),
      updateFooter: vi.fn(),
      updateAutocompleteProvider: vi.fn(),
      setActivityStatus: vi.fn(),
    });

    await loadSessionHistory();

    expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith(
      `Recap for debugging only: ${HEARTBEAT_PROMPT}`,
    );
  });

  it("suppresses poll messages that use configured custom heartbeat prompts", async () => {
    const customPrompt = "custom heartbeat poll prompt";
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [{ key: "agent:main:main" }],
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      thinkingLevel: "off",
      verboseLevel: "off",
      messages: [
        { role: "user", content: customPrompt },
        { role: "user", content: "normal user message" },
      ],
    });

    const chatLog = {
      clearAll: vi.fn(),
      addSystem: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      startTool: vi.fn(() => ({ setResult: vi.fn() })),
    };

    const state: TuiStateAccess = {
      agentDefaultId: "main",
      sessionMainKey: "agent:main:main",
      sessionScope: "global",
      agents: [],
      currentAgentId: "main",
      currentSessionKey: "agent:main:main",
      currentSessionId: null,
      activeChatRunId: null,
      historyLoaded: false,
      sessionInfo: {},
      initialSessionApplied: true,
      isConnected: true,
      autoMessageSent: false,
      toolsExpanded: false,
      showThinking: false,
      connectionStatus: "connected",
      activityStatus: "idle",
      statusTimeout: null,
      lastCtrlCAt: 0,
    };

    const { loadHistory: loadSessionHistory } = createSessionActions({
      client: { listSessions, loadHistory } as unknown as GatewayChatClient,
      chatLog: chatLog as unknown as import("./components/chat-log.js").ChatLog,
      tui: { requestRender: vi.fn() } as unknown as import("@mariozechner/pi-tui").TUI,
      opts: {},
      heartbeatPrompt: customPrompt,
      state,
      agentNames: new Map(),
      initialSessionInput: "",
      initialSessionAgentId: null,
      resolveSessionKey: vi.fn(),
      updateHeader: vi.fn(),
      updateFooter: vi.fn(),
      updateAutocompleteProvider: vi.fn(),
      setActivityStatus: vi.fn(),
    });

    await loadSessionHistory();

    expect(chatLog.addUser).toHaveBeenCalledTimes(1);
    expect(chatLog.addUser).toHaveBeenCalledWith("normal user message");
  });

  it("uses configured heartbeat ack max chars when deciding history suppression", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [{ key: "agent:main:main" }],
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      thinkingLevel: "off",
      verboseLevel: "off",
      messages: [
        {
          role: "assistant",
          content: "HEARTBEAT_OK ping",
        },
      ],
    });

    const chatLog = {
      clearAll: vi.fn(),
      addSystem: vi.fn(),
      addUser: vi.fn(),
      finalizeAssistant: vi.fn(),
      startTool: vi.fn(() => ({ setResult: vi.fn() })),
    };

    const state: TuiStateAccess = {
      agentDefaultId: "main",
      sessionMainKey: "agent:main:main",
      sessionScope: "global",
      agents: [],
      currentAgentId: "main",
      currentSessionKey: "agent:main:main",
      currentSessionId: null,
      activeChatRunId: null,
      historyLoaded: false,
      sessionInfo: {},
      initialSessionApplied: true,
      isConnected: true,
      autoMessageSent: false,
      toolsExpanded: false,
      showThinking: false,
      connectionStatus: "connected",
      activityStatus: "idle",
      statusTimeout: null,
      lastCtrlCAt: 0,
    };

    const { loadHistory: loadSessionHistory } = createSessionActions({
      client: { listSessions, loadHistory } as unknown as GatewayChatClient,
      chatLog: chatLog as unknown as import("./components/chat-log.js").ChatLog,
      tui: { requestRender: vi.fn() } as unknown as import("@mariozechner/pi-tui").TUI,
      opts: {},
      heartbeatAckMaxChars: 3,
      state,
      agentNames: new Map(),
      initialSessionInput: "",
      initialSessionAgentId: null,
      resolveSessionKey: vi.fn(),
      updateHeader: vi.fn(),
      updateFooter: vi.fn(),
      updateAutocompleteProvider: vi.fn(),
      setActivityStatus: vi.fn(),
    });

    await loadSessionHistory();

    expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("ping");
  });
});
