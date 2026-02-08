import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.js";
import { handleChatEvent, sendChatMessage, type ChatEventPayload, type ChatState } from "./chat.js";

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
});

describe("sendChatMessage", () => {
  function createMockClient(): { client: GatewayBrowserClient; request: ReturnType<typeof vi.fn> } {
    const request = vi.fn().mockResolvedValue({});
    const mock = {
      request,
      get connected() {
        return true;
      },
      start: vi.fn(),
      stop: vi.fn(),
    };
    return {
      client: mock as unknown as GatewayBrowserClient,
      request,
    };
  }

  it("adds regular messages optimistically to chatMessages", async () => {
    const { client: mockClient, request: mockRequest } = createMockClient();
    const state = createState({
      client: mockClient,
      connected: true,
      sessionKey: "main",
    });
    const initialMessageCount = state.chatMessages.length;

    await sendChatMessage(state, "Hello, world!");

    // Message should be added optimistically
    expect(state.chatMessages.length).toBe(initialMessageCount + 1);
    expect(state.chatMessages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Hello, world!" }],
    });
    // Should be sent to server
    expect(mockRequest).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
        message: "Hello, world!",
      }),
    );
  });

  it("does not add /new command optimistically to chatMessages", async () => {
    const { client: mockClient, request: mockRequest } = createMockClient();
    const state = createState({
      client: mockClient,
      connected: true,
      sessionKey: "main",
    });
    const initialMessageCount = state.chatMessages.length;

    await sendChatMessage(state, "/new");

    // Message should NOT be added optimistically
    expect(state.chatMessages.length).toBe(initialMessageCount);
    // But should still be sent to server
    expect(mockRequest).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
        message: "/new",
      }),
    );
  });

  it("does not add /reset command optimistically to chatMessages", async () => {
    const { client: mockClient, request: mockRequest } = createMockClient();
    const state = createState({
      client: mockClient,
      connected: true,
      sessionKey: "main",
    });
    const initialMessageCount = state.chatMessages.length;

    await sendChatMessage(state, "/reset");

    // Message should NOT be added optimistically
    expect(state.chatMessages.length).toBe(initialMessageCount);
    // But should still be sent to server
    expect(mockRequest).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
        message: "/reset",
      }),
    );
  });

  it("does not add /new with arguments optimistically to chatMessages", async () => {
    const { client: mockClient, request: mockRequest } = createMockClient();
    const state = createState({
      client: mockClient,
      connected: true,
      sessionKey: "main",
    });
    const initialMessageCount = state.chatMessages.length;

    await sendChatMessage(state, "/new with some text");

    // Message should NOT be added optimistically
    expect(state.chatMessages.length).toBe(initialMessageCount);
    // But should still be sent to server
    expect(mockRequest).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
        message: "/new with some text",
      }),
    );
  });

  it("does not add /reset with arguments optimistically to chatMessages", async () => {
    const { client: mockClient, request: mockRequest } = createMockClient();
    const state = createState({
      client: mockClient,
      connected: true,
      sessionKey: "main",
    });
    const initialMessageCount = state.chatMessages.length;

    await sendChatMessage(state, "/reset session please");

    // Message should NOT be added optimistically
    expect(state.chatMessages.length).toBe(initialMessageCount);
    // But should still be sent to server
    expect(mockRequest).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
        message: "/reset session please",
      }),
    );
  });

  it("handles case-insensitive reset commands", async () => {
    const { client: mockClient } = createMockClient();
    const state = createState({
      client: mockClient,
      connected: true,
      sessionKey: "main",
    });

    // Test various casings
    await sendChatMessage(state, "/NEW");
    expect(state.chatMessages.length).toBe(0);

    await sendChatMessage(state, "/Reset");
    expect(state.chatMessages.length).toBe(0);

    await sendChatMessage(state, "/NeW test");
    expect(state.chatMessages.length).toBe(0);
  });
});
