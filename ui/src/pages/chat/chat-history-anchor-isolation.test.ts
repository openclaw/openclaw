import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { loadChatHistory, type ChatHistoryResult, type ChatState } from "./chat-history.ts";
import { createInitialChatRealtimeState } from "./chat-realtime.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resetChatStateForRouteSession } from "./chat-state-route.ts";
import { cacheChatSessionSnapshot, readChatMessagesFromCache } from "./session-message-cache.ts";

function message(role: "assistant" | "user", text: string, id: string, seq: number) {
  return {
    role,
    content: [{ type: "text", text }],
    __openclaw: { id, seq },
  };
}

function createHistoryState(request: ReturnType<typeof vi.fn>): ChatState {
  return {
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    connectionEpoch: 1,
    sessionKey: "main",
    currentSessionId: "session-current",
    chatLoading: false,
    chatMessages: [],
    chatMessagesBySession: new Map(),
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    hello: null,
  };
}

function createRouteState(): ChatPageHost {
  return {
    settings: { gatewayUrl: "ws://gateway.test/control" },
    assistantAgentId: "main",
    agentsList: { defaultId: "main", mainKey: "main", agents: [] },
    hello: null,
    initialUserMessage: createInitialUserMessageHandoff(),
    sessionKey: "agent:main:first",
    chatMessage: "",
    chatComposerFallbackByScope: {},
    chatQueue: [],
    chatMessages: [],
    chatMessagesBySession: new Map(),
    imageLightbox: null,
    imageLightboxRequestVersion: 0,
    chatAttachments: [],
    chatToolMessages: [],
    chatStreamSegments: [],
    toolStreamById: new Map(),
    toolStreamOrder: [],
    sessionsResult: null,
    resetChatInputHistoryNavigation: vi.fn(),
    resetChatScroll: vi.fn(),
    requestUpdate: vi.fn(),
    ...createInitialChatRealtimeState(),
  } as unknown as ChatPageHost;
}

describe("historical transcript anchor isolation", () => {
  it("keeps live events out of the anchored view until ordinary history succeeds", async () => {
    const current = message("user", "current tail", "current-tail", 9);
    const historical = message("user", "historical hit", "historical-hit", 1);
    const final = message("assistant", "new live reply", "live-final", 10);
    let resolveOrdinary: (result: ChatHistoryResult) => void = () => undefined;
    const ordinary = new Promise<ChatHistoryResult>((resolve) => {
      resolveOrdinary = resolve;
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ messages: [historical], sessionId: "session-history" })
      .mockReturnValueOnce(ordinary);
    const state = createHistoryState(request);
    state.chatMessages = [current];
    cacheChatSessionSnapshot(
      state.chatMessagesBySession ?? new Map(),
      state,
      { sessionKey: state.sessionKey },
      {
        messages: [current],
        pagination: { hasMore: false, completeSnapshot: true },
        sessionId: "session-current",
      },
    );

    await loadChatHistory(state, {
      startup: true,
      historyAnchor: { sessionId: "session-history", messageId: "historical-hit" },
    });
    expect(state.chatHistoryAnchorActive).toBe(true);
    expect(state.chatMessages).toEqual([historical]);

    expect(
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "live-run",
        state: "delta",
        deltaText: "streaming",
      }),
    ).toBe("delta");
    expect(
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "live-run",
        state: "final",
        message: final,
      }),
    ).toBe("final");
    expect(state.chatMessages).toEqual([historical]);
    expect(state.chatStream).toBeNull();
    expect(
      readChatMessagesFromCache(state.chatMessagesBySession ?? new Map(), state, {
        sessionKey: "main",
      }),
    ).toEqual([current, final]);

    const refresh = loadChatHistory(state);
    expect(state.chatHistoryAnchorActive).toBe(true);
    resolveOrdinary({ messages: [current, final], sessionId: "session-current" });
    await refresh;

    expect(state.chatHistoryAnchorActive).toBe(false);
    expect(state.chatMessages).toEqual([current, final]);
  });

  it("restores the canonical cache after switching away from an anchored view", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    const state = createRouteState();
    const current = message("assistant", "current tail", "current-tail", 9);
    const historical = message("user", "historical hit", "historical-hit", 1);
    cacheChatSessionSnapshot(
      state.chatMessagesBySession,
      state,
      { sessionKey: state.sessionKey },
      {
        messages: [current],
        pagination: { hasMore: false, completeSnapshot: true },
        sessionId: "session-current",
      },
    );
    state.chatMessages = [historical];
    state.chatHistoryAnchorActive = true;

    resetChatStateForRouteSession(state, "agent:main:second");
    expect(state.chatHistoryAnchorActive).toBe(false);
    expect(state.chatMessages).toEqual([]);

    resetChatStateForRouteSession(state, "agent:main:first");
    expect(state.chatMessages).toEqual([current]);
    expect(state.currentSessionId).toBe("session-current");
  });
});
