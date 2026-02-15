import { describe, expect, it } from "vitest";
import {
  handleChatEvent,
  sessionKeyMatches,
  type ChatEventPayload,
  type ChatState,
} from "./chat.ts";

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

describe("sessionKeyMatches", () => {
  it("matches identical keys", () => {
    expect(sessionKeyMatches("main", "main")).toBe(true);
  });

  it("matches agent-scoped event key against base state key", () => {
    expect(sessionKeyMatches("agent:default:main", "main")).toBe(true);
  });

  it("matches base event key against agent-scoped state key", () => {
    expect(sessionKeyMatches("main", "agent:default:main")).toBe(true);
  });

  it("rejects keys that do not match", () => {
    expect(sessionKeyMatches("other", "main")).toBe(false);
  });

  it("rejects partial suffix matches without colon boundary", () => {
    // "xmain" ends with "main" but is NOT a valid agent-scoped match
    expect(sessionKeyMatches("agent:x:xmain", "main")).toBe(false);
  });

  it("handles both keys being agent-scoped but different", () => {
    expect(sessionKeyMatches("agent:a:key1", "agent:b:key2")).toBe(false);
  });

  it("handles both keys being agent-scoped and matching base", () => {
    expect(sessionKeyMatches("agent:a:main", "agent:b:main")).toBe(false);
  });
});

describe("handleChatEvent", () => {
  it("returns null when payload is missing", () => {
    const state = createState();
    expect(handleChatEvent(state, undefined)).toBe(null);
  });

  it("returns null when sessionKey does not match", () => {
    const state = createState({ sessionKey: "main" });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "other",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe(null);
  });

  it("returns null for delta from another run", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Hello",
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    };
    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Hello");
  });

  it("returns 'final' for final from another run (e.g. sub-agent announce) without clearing state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Sub-agent findings" }],
      },
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
  });

  it("processes final from own run and clears state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Reply",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });

  it("matches agent-scoped event key against base state key", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "streaming...",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "agent:default:main",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatStream).toBe(null);
    expect(state.chatMessages).toHaveLength(1);
  });

  it("optimistically appends final assistant message", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Working...",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Result" }] },
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(1);
    expect((state.chatMessages[0] as { role: string }).role).toBe("assistant");
  });

  it("does not duplicate assistant message on final if already present", () => {
    const existingMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Result" }],
      timestamp: 100,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "",
      chatStreamStartedAt: 100,
      chatMessages: [existingMsg],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Result" }] },
    };
    handleChatEvent(state, payload);
    // Should NOT append a duplicate — still only 1 message
    expect(state.chatMessages).toHaveLength(1);
  });
});
