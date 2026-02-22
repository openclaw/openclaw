import { describe, expect, it, vi } from "vitest";
import { handleChatEvent, loadChatHistory, type ChatEventPayload, type ChatState } from "./chat.ts";

function createMockClient(response: unknown) {
  return {
    request: vi.fn().mockResolvedValue(response),
  };
}

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

  it("processes aborted from own run and keeps partial assistant message", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const partialMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
      timestamp: 2,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: partialMessage,
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toEqual([existingMessage, partialMessage]);
  });

  it("falls back to streamed partial when aborted payload message is invalid", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: "not-an-assistant-message",
    } as unknown as ChatEventPayload;

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(existingMessage);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
    });
  });

  it("falls back to streamed partial when aborted payload has non-assistant role", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: {
        role: "user",
        content: [{ type: "text", text: "unexpected" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
    });
  });

  it("processes aborted from own run without message and empty stream", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toEqual([existingMessage]);
  });
});

describe("loadChatHistory", () => {
  it("does nothing when not connected", async () => {
    const state = createState({ connected: false });
    await loadChatHistory(state);
    expect(state.chatLoading).toBe(false);
  });

  it("loads messages from server", async () => {
    const serverMessages = [
      { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "Hi!" }], timestamp: 2000 },
    ];
    const client = createMockClient({ messages: serverMessages });
    const state = createState({
      client: client as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual(serverMessages);
    expect(state.chatLoading).toBe(false);
  });

  it("preserves local user messages not yet on server", async () => {
    const localMessage = {
      role: "user",
      content: [{ type: "text", text: "New message" }],
      timestamp: 3000,
      _localOnly: true,
    };
    const serverMessages = [
      { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "Hi!" }], timestamp: 2000 },
    ];
    const client = createMockClient({ messages: serverMessages });
    const state = createState({
      client: client as unknown as ChatState["client"],
      connected: true,
      chatMessages: [localMessage],
    });

    await loadChatHistory(state, { preserveLocalUser: true });

    expect(state.chatMessages).toHaveLength(3);
    expect(state.chatMessages[2]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "New message" }],
      _localOnly: true,
    });
  });

  it("removes local messages that are now on server (deduplication)", async () => {
    const localMessage = {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
      timestamp: 1000,
      _localOnly: true,
    };
    const serverMessages = [
      { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1000, id: "msg-1" },
      { role: "assistant", content: [{ type: "text", text: "Hi!" }], timestamp: 2000 },
    ];
    const client = createMockClient({ messages: serverMessages });
    const state = createState({
      client: client as unknown as ChatState["client"],
      connected: true,
      chatMessages: [localMessage],
    });

    await loadChatHistory(state, { preserveLocalUser: true });

    // Should only have server messages, local duplicate removed
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toHaveProperty("id", "msg-1");
  });

  it("maintains chronological order when merging local messages", async () => {
    // Local message sent at timestamp 1500 (between server messages)
    const localMessage = {
      role: "user",
      content: [{ type: "text", text: "Middle message" }],
      timestamp: 1500,
      _localOnly: true,
    };
    const serverMessages = [
      { role: "user", content: [{ type: "text", text: "First" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "Last" }], timestamp: 2000 },
    ];
    const client = createMockClient({ messages: serverMessages });
    const state = createState({
      client: client as unknown as ChatState["client"],
      connected: true,
      chatMessages: [localMessage],
    });

    await loadChatHistory(state, { preserveLocalUser: true });

    // Should be sorted: 1000, 1500, 2000
    expect(state.chatMessages).toHaveLength(3);
    expect((state.chatMessages[0] as Record<string, unknown>).timestamp).toBe(1000);
    expect((state.chatMessages[1] as Record<string, unknown>).timestamp).toBe(1500);
    expect((state.chatMessages[2] as Record<string, unknown>).timestamp).toBe(2000);
  });

  it("handles race condition - preserves messages added during loading", async () => {
    const client = {
      request: vi.fn().mockImplementation(async () => {
        // Simulate delay and state change during request
        return { messages: [] };
      }),
    };
    const localMessage = {
      role: "user",
      content: [{ type: "text", text: "Sent during load" }],
      timestamp: 1000,
      _localOnly: true,
    };
    const state = createState({
      client: client as unknown as ChatState["client"],
      connected: true,
      chatMessages: [localMessage],
    });

    await loadChatHistory(state, { preserveLocalUser: true });

    // Local message should be preserved even if server returns empty
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toMatchObject({ _localOnly: true });
  });
});
