import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadChatHistory: vi.fn(),
  loadSessions: vi.fn(),
  refreshChatAvatar: vi.fn(),
  syncUrlWithSessionKey: vi.fn(),
}));

vi.mock("./app-chat.ts", () => ({
  refreshChat: vi.fn(),
  refreshChatAvatar: mocks.refreshChatAvatar,
}));

vi.mock("./controllers/chat.ts", () => ({
  loadChatHistory: mocks.loadChatHistory,
}));

vi.mock("./controllers/sessions.ts", () => ({
  loadSessions: mocks.loadSessions,
}));

vi.mock("./app-settings.ts", () => ({
  syncUrlWithSessionKey: mocks.syncUrlWithSessionKey,
}));

import { switchChatSession } from "./app-render.helpers.ts";

describe("switchChatSession", () => {
  beforeEach(() => {
    mocks.loadChatHistory.mockReset();
    mocks.loadSessions.mockReset();
    mocks.refreshChatAvatar.mockReset();
    mocks.syncUrlWithSessionKey.mockReset();
  });

  it("refreshes the chat avatar when switching sessions", () => {
    const applySettings = vi.fn();
    const loadAssistantIdentity = vi.fn();
    const resetToolStream = vi.fn();
    const resetChatScroll = vi.fn();
    const state = {
      sessionKey: "agent:alpha:main",
      chatMessage: "draft",
      chatMessages: [{ role: "assistant", content: "stale" }],
      chatStream: "stream",
      chatQueue: [{ id: "queued" }],
      chatRunId: "run-1",
      settings: {
        sessionKey: "agent:alpha:main",
        lastActiveSessionKey: "agent:alpha:main",
      },
      applySettings,
      loadAssistantIdentity,
      resetToolStream,
      resetChatScroll,
      chatStreamStartedAt: 123,
    };

    switchChatSession(state as never, "agent:beta:main");

    expect(state.sessionKey).toBe("agent:beta:main");
    expect(state.chatMessage).toBe("");
    expect(state.chatMessages).toEqual([]);
    expect(state.chatStream).toBeNull();
    expect((state as never as { chatStreamStartedAt: unknown }).chatStreamStartedAt).toBeNull();
    expect(state.chatQueue).toEqual([]);
    expect(state.chatRunId).toBeNull();
    expect(resetToolStream).toHaveBeenCalledTimes(1);
    expect(resetChatScroll).toHaveBeenCalledTimes(1);
    expect(applySettings).toHaveBeenCalledWith({
      sessionKey: "agent:beta:main",
      lastActiveSessionKey: "agent:beta:main",
    });
    expect(loadAssistantIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.refreshChatAvatar).toHaveBeenCalledWith(state);
    expect(mocks.loadChatHistory).toHaveBeenCalledWith(state);
    expect(mocks.loadSessions).toHaveBeenCalledWith(state, {
      activeMinutes: 0,
      limit: 0,
      includeGlobal: true,
      includeUnknown: true,
    });
    expect(mocks.syncUrlWithSessionKey).toHaveBeenCalledWith(
      state,
      "agent:beta:main",
      true,
    );
  });
});
