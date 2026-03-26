import { describe, expect, it, vi } from "vitest";
import type { GatewayChatClient } from "./gateway-chat.js";
import { createSessionActions } from "./tui-session-actions.js";
import type { TuiStateAccess } from "./tui-types.js";

describe("tui session actions", () => {
  const createBtwPresenter = () => ({
    clear: vi.fn(),
    showResult: vi.fn(),
  });

  const createBaseState = (): TuiStateAccess => ({
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
  });

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

    const state = createBaseState();

    const updateFooter = vi.fn();
    const updateAutocompleteProvider = vi.fn();
    const requestRender = vi.fn();

    const { refreshSessionInfo } = createSessionActions({
      client: { listSessions } as unknown as GatewayChatClient,
      chatLog: { addSystem: vi.fn() } as unknown as import("./components/chat-log.js").ChatLog,
      btw: createBtwPresenter(),
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
          model: "Minimax-M2.7",
          modelProvider: "minimax",
        },
      ],
    });

    await second;

    expect(state.sessionInfo.model).toBe("Minimax-M2.7");
    expect(updateAutocompleteProvider).toHaveBeenCalledTimes(2);
    expect(updateFooter).toHaveBeenCalledTimes(2);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("keeps patched model selection when a refresh returns an older snapshot", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [
        {
          key: "agent:main:main",
          model: "old-model",
          modelProvider: "ollama",
          updatedAt: 100,
        },
      ],
    });

    const state = {
      ...createBaseState(),
      sessionInfo: {
        model: "old-model",
        modelProvider: "ollama",
        updatedAt: 100,
      },
    };

    const { applySessionInfoFromPatch, refreshSessionInfo } = createSessionActions({
      client: { listSessions } as unknown as GatewayChatClient,
      chatLog: { addSystem: vi.fn() } as unknown as import("./components/chat-log.js").ChatLog,
      btw: createBtwPresenter(),
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

    applySessionInfoFromPatch({
      ok: true,
      path: "/tmp/sessions.json",
      key: "agent:main:main",
      entry: {
        sessionId: "session-1",
        model: "new-model",
        modelProvider: "openai",
        updatedAt: 200,
      },
    });

    expect(state.sessionInfo.model).toBe("new-model");
    expect(state.sessionInfo.modelProvider).toBe("openai");

    await refreshSessionInfo();

    expect(state.sessionInfo.model).toBe("new-model");
    expect(state.sessionInfo.modelProvider).toBe("openai");
    expect(state.sessionInfo.updatedAt).toBe(200);
  });

  it("accepts older session snapshots after switching session keys", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      ts: Date.now(),
      path: "/tmp/sessions.json",
      count: 1,
      defaults: {},
      sessions: [
        {
          key: "agent:main:other",
          model: "session-model",
          modelProvider: "openai",
          updatedAt: 50,
        },
      ],
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-2",
      messages: [],
    });
    const btw = createBtwPresenter();

    const state = {
      ...createBaseState(),
      historyLoaded: true,
      sessionInfo: {
        model: "previous-model",
        modelProvider: "anthropic",
        updatedAt: 500,
      },
    };

    const { setSession } = createSessionActions({
      client: {
        listSessions,
        loadHistory,
      } as unknown as GatewayChatClient,
      chatLog: {
        addSystem: vi.fn(),
        clearAll: vi.fn(),
      } as unknown as import("./components/chat-log.js").ChatLog,
      btw,
      tui: { requestRender: vi.fn() } as unknown as import("@mariozechner/pi-tui").TUI,
      opts: {},
      state,
      agentNames: new Map(),
      initialSessionInput: "",
      initialSessionAgentId: null,
      resolveSessionKey: vi.fn((raw?: string) => raw ?? "agent:main:main"),
      updateHeader: vi.fn(),
      updateFooter: vi.fn(),
      updateAutocompleteProvider: vi.fn(),
      setActivityStatus: vi.fn(),
    });

    await setSession("agent:main:other");

    expect(loadHistory).toHaveBeenCalledWith({
      sessionKey: "agent:main:other",
      limit: 200,
    });
    expect(state.currentSessionKey).toBe("agent:main:other");
    expect(state.sessionInfo.model).toBe("session-model");
    expect(state.sessionInfo.modelProvider).toBe("openai");
    expect(state.sessionInfo.updatedAt).toBe(50);
    expect(btw.clear).toHaveBeenCalled();
  });

  it("flushes the next queued prompt when abort is requested with no active run", async () => {
    const flushQueuedMessage = vi.fn().mockResolvedValue(true);
    const chatLog = {
      addSystem: vi.fn(),
    } as unknown as import("./components/chat-log.js").ChatLog;
    const tui = {
      requestRender: vi.fn(),
    } as unknown as import("@mariozechner/pi-tui").TUI;
    const state = createBaseState();

    const { abortActive } = createSessionActions({
      client: {} as GatewayChatClient,
      chatLog,
      btw: createBtwPresenter(),
      tui,
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
      flushQueuedMessage,
    });

    await abortActive();

    expect(flushQueuedMessage).toHaveBeenCalledTimes(1);
    expect(chatLog.addSystem).not.toHaveBeenCalledWith("no active run");
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });
});
