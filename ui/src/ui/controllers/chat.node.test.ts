import { describe, expect, it } from "vitest";
import { handleChatEvent, type ChatEventPayload, type ChatState } from "./chat.ts";

function createState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    chatAttachments: [],
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatStreamStartedAt: null,
    chatThinkingLevel: null,
    client: null,
    connected: true,
    lastError: null,
    sessionKey: "main",
    ...overrides,
  };
}

describe("handleChatEvent — final state fallback", () => {
  it("preserves streamed text when final payload has no displayable message", () => {
    // Regression: when the assistant streams text then immediately calls a tool,
    // the final event may arrive with no message (or a non-assistant message).
    // The streamed text must be preserved in chatMessages rather than discarded,
    // so the user does not see text vanish and have to reload to recover it.
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "run a command" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Let me run that command for you.",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: undefined,
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatStream).toBe(null);
    expect(state.chatRunId).toBe(null);
    // Streamed text must survive in chatMessages
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Let me run that command for you." }],
    });
  });

  it("does not add empty fallback message when final payload is missing and stream is empty", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: undefined,
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(0);
    expect(state.chatStream).toBe(null);
  });

  it("does not add whitespace-only stream as fallback", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "   \n  ",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: undefined,
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(0);
  });

  it("does not add fallback when final payload already has a valid message", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Let me check...",
      chatStreamStartedAt: 100,
    });
    const finalMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Here is the result." }],
      timestamp: 200,
    };
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: finalMsg,
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toEqual(finalMsg);
  });
});
