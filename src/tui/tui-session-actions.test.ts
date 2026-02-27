import { describe, expect, it, vi } from "vitest";
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
          model: "Minimax-M2.1",
          modelProvider: "minimax",
        },
      ],
    });

    await second;

    expect(state.sessionInfo.model).toBe("Minimax-M2.1");
    expect(updateAutocompleteProvider).toHaveBeenCalledTimes(2);
    expect(updateFooter).toHaveBeenCalledTimes(2);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("applySessionInfoFromPatch correctly handles empty string modelProvider", () => {
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
      sessionInfo: {
        model: "gemini-3.1-pro-preview",
        modelProvider: "google",
      },
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

    const { applySessionInfoFromPatch } = createSessionActions({
      client: {} as unknown as GatewayChatClient,
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

    // Simulate a patch result with empty string modelProvider and a new model
    // This is what happens when switching to a provider that doesn't have a provider prefix
    applySessionInfoFromPatch({
      ok: true,
      path: "/tmp/sessions.json",
      key: "agent:main:main",
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        model: "gemini-3.1-pro-preview",
        modelProvider: "google",
      },
      resolved: {
        modelProvider: "", // Empty string should be treated as a valid value
        model: "kimi",
      },
    });

    // The model should be updated to "kimi" and modelProvider to "" (empty string)
    expect(state.sessionInfo.model).toBe("kimi");
    expect(state.sessionInfo.modelProvider).toBe("");
    expect(updateFooter).toHaveBeenCalled();
    expect(updateAutocompleteProvider).toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalled();
  });

  it("applySessionInfoFromPatch correctly handles undefined resolved values", () => {
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
      sessionInfo: {
        model: "claude-opus",
        modelProvider: "anthropic",
      },
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

    const { applySessionInfoFromPatch } = createSessionActions({
      client: {} as unknown as GatewayChatClient,
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

    // Simulate a patch result with only model defined (modelProvider is undefined)
    applySessionInfoFromPatch({
      ok: true,
      path: "/tmp/sessions.json",
      key: "agent:main:main",
      entry: {
        sessionId: "session-2",
        updatedAt: Date.now(),
        model: "gpt-4",
        modelProvider: "openai",
      },
      resolved: {
        model: "gpt-4-turbo",
        // modelProvider is undefined - should keep existing value
      },
    });

    // The model should be updated but modelProvider should keep the existing value
    expect(state.sessionInfo.model).toBe("gpt-4-turbo");
    expect(state.sessionInfo.modelProvider).toBe("openai");
    expect(updateFooter).toHaveBeenCalled();
  });
});
