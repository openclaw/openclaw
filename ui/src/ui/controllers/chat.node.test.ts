import { describe, expect, it } from "vitest";
import {
  handleChatEvent,
  isLocalMessage,
  loadChatHistory,
  sendChatMessage,
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

describe("isLocalMessage", () => {
  it("returns true for messages with _localId", () => {
    const msg = { role: "user", content: [{ type: "text", text: "hi" }], _localId: "abc-123" };
    expect(isLocalMessage(msg)).toBe(true);
  });

  it("returns false for plain server messages", () => {
    const msg = { role: "user", content: [{ type: "text", text: "hi" }] };
    expect(isLocalMessage(msg)).toBe(false);
  });

  it("returns false for null / non-object", () => {
    expect(isLocalMessage(null)).toBe(false);
    expect(isLocalMessage(undefined)).toBe(false);
    expect(isLocalMessage("hello")).toBe(false);
    expect(isLocalMessage(42)).toBe(false);
  });
});

describe("sendChatMessage", () => {
  function mockClient(response: unknown = {}) {
    return {
      request: async () => response,
    } as unknown as ChatState["client"];
  }

  it("marks optimistic user message with _localId", async () => {
    const state = createState({ client: mockClient(), connected: true });
    const runId = await sendChatMessage(state, "hello");
    expect(runId).toBeTruthy();

    // The optimistic message should carry _localId
    const lastMsg = state.chatMessages[state.chatMessages.length - 1] as Record<string, unknown>;
    expect(lastMsg.role).toBe("user");
    expect(lastMsg._localId).toBe(runId);
    expect(isLocalMessage(lastMsg)).toBe(true);
  });

  it("returns null when not connected", async () => {
    const state = createState({ client: mockClient(), connected: false });
    const runId = await sendChatMessage(state, "hello");
    expect(runId).toBe(null);
    expect(state.chatMessages).toEqual([]);
  });
});

describe("loadChatHistory – preserves pending messages", () => {
  function mockClientWithHistory(messages: unknown[]) {
    return {
      request: async () => ({ messages }),
    } as unknown as ChatState["client"];
  }

  it("replaces messages normally when no local messages exist", async () => {
    const serverMsgs = [
      { role: "user", content: [{ type: "text", text: "msg1" }] },
      { role: "assistant", content: [{ type: "text", text: "reply1" }] },
    ];
    const state = createState({
      client: mockClientWithHistory(serverMsgs),
      connected: true,
      chatMessages: [{ role: "user", content: [{ type: "text", text: "old" }] }],
    });
    await loadChatHistory(state);
    expect(state.chatMessages).toEqual(serverMsgs);
  });

  it("preserves unconfirmed local messages after server refresh", async () => {
    const serverMsgs = [
      { role: "user", content: [{ type: "text", text: "msg1" }] },
      { role: "assistant", content: [{ type: "text", text: "reply1" }] },
    ];
    const pendingMsg = {
      role: "user",
      content: [{ type: "text", text: "msg2" }],
      timestamp: Date.now(),
      _localId: "local-run-id",
    };
    const state = createState({
      client: mockClientWithHistory(serverMsgs),
      connected: true,
      chatMessages: [
        { role: "user", content: [{ type: "text", text: "msg1" }] },
        { role: "assistant", content: [{ type: "text", text: "reply1" }] },
        pendingMsg,
      ],
    });
    await loadChatHistory(state);

    // Server messages + the unconfirmed pending message
    expect(state.chatMessages.length).toBe(3);
    const last = state.chatMessages[2] as Record<string, unknown>;
    expect(last._localId).toBe("local-run-id");
    expect(last.role).toBe("user");
  });

  it("drops local messages once the server confirms them", async () => {
    const serverMsgs = [
      { role: "user", content: [{ type: "text", text: "msg1" }] },
      { role: "assistant", content: [{ type: "text", text: "reply1" }] },
      { role: "user", content: [{ type: "text", text: "msg2" }] },
    ];
    const pendingMsg = {
      role: "user",
      content: [{ type: "text", text: "msg2" }],
      timestamp: Date.now(),
      _localId: "local-run-id",
    };
    const state = createState({
      client: mockClientWithHistory(serverMsgs),
      connected: true,
      chatMessages: [{ role: "user", content: [{ type: "text", text: "msg1" }] }, pendingMsg],
    });
    await loadChatHistory(state);

    // msg2 is now confirmed by the server, so the local copy should be dropped
    expect(state.chatMessages).toEqual(serverMsgs);
    expect(state.chatMessages.some((m) => isLocalMessage(m))).toBe(false);
  });

  it("handles race: user sends while loadChatHistory is in-flight", async () => {
    // Simulate: loadChatHistory starts, then user sends a message, then the
    // server response arrives without the new message.
    let resolveRequest!: (value: unknown) => void;
    const client = {
      request: () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    } as unknown as ChatState["client"];

    const state = createState({
      client,
      connected: true,
      chatMessages: [{ role: "assistant", content: [{ type: "text", text: "Hello" }] }],
    });

    // Start loading (won't resolve yet)
    const loadPromise = loadChatHistory(state);

    // Simulate user sending a message while load is in-flight
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "user",
        content: [{ type: "text", text: "new message" }],
        timestamp: Date.now(),
        _localId: "pending-run",
      },
    ];

    // Now resolve the server response (without the new message)
    resolveRequest({
      messages: [{ role: "assistant", content: [{ type: "text", text: "Hello" }] }],
    });
    await loadPromise;

    // The user's pending message should be preserved
    expect(state.chatMessages.length).toBe(2);
    const last = state.chatMessages[1] as Record<string, unknown>;
    expect(last._localId).toBe("pending-run");
    expect((last.content as Array<{ text: string }>)[0].text).toBe("new message");
  });

  it("preserves multiple pending messages", async () => {
    const serverMsgs = [{ role: "user", content: [{ type: "text", text: "first" }] }];
    const pending1 = {
      role: "user",
      content: [{ type: "text", text: "second" }],
      timestamp: Date.now(),
      _localId: "run-2",
    };
    const pending2 = {
      role: "user",
      content: [{ type: "text", text: "third" }],
      timestamp: Date.now() + 1,
      _localId: "run-3",
    };
    const state = createState({
      client: mockClientWithHistory(serverMsgs),
      connected: true,
      chatMessages: [serverMsgs[0], pending1, pending2],
    });
    await loadChatHistory(state);

    expect(state.chatMessages.length).toBe(3);
    expect((state.chatMessages[1] as Record<string, unknown>)._localId).toBe("run-2");
    expect((state.chatMessages[2] as Record<string, unknown>)._localId).toBe("run-3");
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

  it("returns 'final' for final from another run without clearing state", () => {
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
      message: { role: "assistant", content: [{ type: "text", text: "Sub-agent" }] },
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
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
});
