import { describe, expect, it, vi } from "vitest";
import { navigateToSessionChat } from "../../ui/src/ui/session-chat-navigation.ts";
import type { UiSettings } from "../../ui/src/ui/storage.ts";

function buildSettings(): UiSettings {
  return {
    gatewayUrl: "ws://localhost/ui",
    token: "abc123",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
  };
}

describe("navigateToSessionChat", () => {
  it("switches to the requested chat session without clearing the gateway token", () => {
    const applySettings = vi.fn();
    const loadAssistantIdentity = vi.fn(async () => undefined);
    const setTab = vi.fn();
    const state = {
      sessionKey: "main",
      chatMessage: "draft message",
      chatStream: "streaming",
      chatStreamStartedAt: 123,
      chatRunId: "run-1",
      settings: buildSettings(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
      applySettings: vi.fn((next: UiSettings) => {
        applySettings(next);
        state.settings = next;
      }),
      loadAssistantIdentity,
      setTab,
    };

    navigateToSessionChat(state, "agent:main:session-123");

    expect(state.sessionKey).toBe("agent:main:session-123");
    expect(state.chatMessage).toBe("");
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
    expect(state.chatRunId).toBeNull();
    expect(state.resetToolStream).toHaveBeenCalledOnce();
    expect(state.resetChatScroll).toHaveBeenCalledOnce();
    expect(applySettings).toHaveBeenCalledWith({
      ...buildSettings(),
      token: "abc123",
      sessionKey: "agent:main:session-123",
      lastActiveSessionKey: "agent:main:session-123",
    });
    expect(state.settings.token).toBe("abc123");
    expect(loadAssistantIdentity).toHaveBeenCalledOnce();
    expect(setTab).toHaveBeenCalledWith("chat");
  });
});
