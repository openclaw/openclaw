import { describe, expect, it, vi } from "vitest";
import { handleSendChat } from "../app-chat.ts";
import { CHAT_HISTORY_RENDER_LIMIT } from "../chat/history-limits.ts";
import {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  navigateChatInputHistory,
  recordNonTranscriptInputHistory,
  resetChatInputHistoryNavigation,
  type ChatInputHistoryState,
} from "../chat/input-history.ts";
import { GatewayRequestError } from "../gateway.ts";
import {
  abortChatRun,
  handleChatEvent,
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

  it("ignores NO_REPLY delta updates", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Hello",
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Hello");
  });

  it("appends final payload from another run without clearing active stream", () => {
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
    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toEqual(payload.message);
  });

  it("drops NO_REPLY final payload from another run without clearing active stream", () => {
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
        content: [{ type: "text", text: "NO_REPLY" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toEqual([]);
  });

  it("returns final for another run when payload has no message", () => {
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
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatMessages).toEqual([]);
  });

  it("persists streamed text when final event carries no message", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Here is my reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
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
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(existingMessage);
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Here is my reply" }],
    });
  });

  it("does not persist empty or whitespace-only stream on final", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "   ",
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
    expect(state.chatMessages).toEqual([]);
  });

  it("does not persist null stream on final with no message", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: null,
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([]);
  });

  it("prefers final payload message over streamed text", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Streamed partial",
      chatStreamStartedAt: 100,
    });
    const finalMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Complete reply" }],
      timestamp: 101,
    };
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: finalMsg,
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([finalMsg]);
    expect(state.chatStream).toBe(null);
  });

  it("appends final payload message from own run before clearing stream state", () => {
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Reply" }],
        timestamp: 101,
      },
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([payload.message]);
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

  it("drops NO_REPLY final payload from another run", () => {
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
        content: [{ type: "text", text: "NO_REPLY" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([]);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
  });

  it("drops NO_REPLY final payload from own run", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "NO_REPLY",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
  });

  it("does not persist NO_REPLY stream text on final without message", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "NO_REPLY",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([]);
  });

  it("does not persist NO_REPLY stream text on abort", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "NO_REPLY",
      chatStreamStartedAt: 100,
    });
    const payload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: "not-an-assistant-message",
    } as unknown as ChatEventPayload;

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatMessages).toEqual([]);
  });

  it("keeps user messages containing NO_REPLY text", () => {
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
        role: "user",
        content: [{ type: "text", text: "NO_REPLY" }],
      },
    };

    // User messages with NO_REPLY text should NOT be filtered — only assistant messages.
    // normalizeFinalAssistantMessage returns null for user role, so this falls through.
    expect(handleChatEvent(state, payload)).toBe("final");
  });

  it("keeps assistant message when text field has real reply but content is NO_REPLY", () => {
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
      message: {
        role: "assistant",
        text: "real reply",
        content: "NO_REPLY",
      },
    };

    // entry.text takes precedence — "real reply" is NOT silent, so the message is kept.
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(1);
  });
});

describe("loadChatHistory", () => {
  it("filters NO_REPLY assistant messages from history", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
      { role: "assistant", content: [{ type: "text", text: "Real answer" }] },
      { role: "assistant", text: "  NO_REPLY  " },
    ];
    const mockClient = {
      request: vi.fn().mockResolvedValue({ messages, thinkingLevel: "low" }),
    };
    const state = createState({
      client: mockClient as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(messages[0]);
    expect(state.chatMessages[1]).toEqual(messages[2]);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatLoading).toBe(false);
  });

  it("keeps assistant message when text field has real content but content is NO_REPLY", async () => {
    const messages = [{ role: "assistant", text: "real reply", content: "NO_REPLY" }];
    const mockClient = {
      request: vi.fn().mockResolvedValue({ messages }),
    };
    const state = createState({
      client: mockClient as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    // text takes precedence — "real reply" is NOT silent, so message is kept.
    expect(state.chatMessages).toHaveLength(1);
  });
});

describe("sendChatMessage", () => {
  it("formats structured non-auth connect failures for chat send", async () => {
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Fetch failed",
        details: { code: "CONTROL_UI_ORIGIN_NOT_ALLOWED" },
      }),
    );
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const result = await sendChatMessage(state, "hello");

    expect(result).toBeNull();
    expect(state.lastError).toContain("origin not allowed");
    expect(state.chatMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "text",
          text: expect.stringContaining("origin not allowed"),
        },
      ],
    });
  });
});

describe("abortChatRun", () => {
  it("formats structured non-auth connect failures for chat abort", async () => {
    // Abort now shares the same structured connect-error formatter as send.
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Fetch failed",
        details: { code: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED" },
      }),
    );
    const state = createState({
      connected: true,
      chatRunId: "run-1",
      client: { request } as unknown as ChatState["client"],
    });

    const result = await abortChatRun(state);

    expect(result).toBe(false);
    expect(request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "main",
      runId: "run-1",
    });
    expect(state.lastError).toContain("device identity required");
  });
});

function textMessage(role: string, text: string) {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function createChatHistoryState(
  overrides: Partial<ChatInputHistoryState> = {},
): ChatInputHistoryState {
  return {
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatLocalInputHistoryBySession: {},
    sessionKey: "main",
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
    ...overrides,
  };
}

describe("chat input history navigation", () => {
  it("builds from user messages in the render window only", () => {
    const windowMessages = Array.from({ length: CHAT_HISTORY_RENDER_LIMIT }, (_, i) =>
      textMessage("assistant", `assistant-${i}`),
    );
    windowMessages[0] = textMessage("user", "inside-old");
    windowMessages[CHAT_HISTORY_RENDER_LIMIT - 1] = textMessage("user", "inside-new");
    const host = createChatHistoryState({
      chatMessage: "draft",
      chatMessages: [
        textMessage("user", "outside-window"),
        textMessage("assistant", "x"),
        ...windowMessages,
      ],
    });

    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("inside-new");

    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("inside-old");

    expect(navigateChatInputHistory(host, "up")).toBe(false);
  });

  it("restores draft when navigating down past latest history entry", () => {
    const host = createChatHistoryState({
      chatMessage: "in-progress",
      chatMessages: [
        textMessage("user", "older"),
        textMessage("assistant", "a"),
        textMessage("user", "newer"),
      ],
    });

    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("newer");
    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("older");

    expect(navigateChatInputHistory(host, "down")).toBe(true);
    expect(host.chatMessage).toBe("newer");
    expect(navigateChatInputHistory(host, "down")).toBe(true);
    expect(host.chatMessage).toBe("in-progress");
    expect(navigateChatInputHistory(host, "down")).toBe(false);
  });

  it("resets navigation snapshot when draft changes manually", () => {
    const host = createChatHistoryState({
      chatMessage: "draft",
      chatMessages: [textMessage("user", "one"), textMessage("user", "two")],
    });

    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("two");

    handleChatDraftChange(host, "typed fresh");
    expect(host.chatInputHistoryItems).toBeNull();
    expect(host.chatInputHistoryIndex).toBe(-1);

    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("two");
  });

  it("rebuilds history snapshot after session changes", () => {
    const host = createChatHistoryState({
      chatMessage: "draft-main",
      chatMessages: [textMessage("user", "main-user")],
    });

    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("main-user");

    host.sessionKey = "other";
    host.chatMessage = "draft-other";
    host.chatMessages = [textMessage("user", "other-user")];

    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("other-user");
  });

  it("includes non-transcript local inputs in session history recall", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
    const host = createChatHistoryState({
      chatMessage: "",
      chatMessages: [textMessage("user", "older-user-message")],
    });

    recordNonTranscriptInputHistory(host, "/status");

    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("/status");

    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("older-user-message");
    now.mockRestore();
  });

  it("clears internal navigation state on explicit reset", () => {
    const host = createChatHistoryState({
      chatInputHistorySessionKey: "main",
      chatInputHistoryItems: ["x"],
      chatInputHistoryIndex: 0,
      chatDraftBeforeHistory: "draft",
    });

    resetChatInputHistoryNavigation(host);
    expect(host.chatInputHistorySessionKey).toBeNull();
    expect(host.chatInputHistoryItems).toBeNull();
    expect(host.chatInputHistoryIndex).toBe(-1);
    expect(host.chatDraftBeforeHistory).toBeNull();
  });

  it("enters history on ArrowUp only when caret is at start in editing mode", () => {
    const host = createChatHistoryState({
      chatMessage: "draft",
      chatMessages: [textMessage("user", "older")],
    });

    expect(
      handleChatInputHistoryKey(host, {
        key: "ArrowUp",
        selectionStart: 2,
        selectionEnd: 2,
        valueLength: 5,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 38,
      }),
    ).toMatchObject({
      handled: false,
      decision: "blocked:arrowup-not-at-start",
      historyNavigationActiveBefore: false,
      historyNavigationActiveAfter: false,
    });
    expect(host.chatInputHistoryIndex).toBe(-1);

    expect(
      handleChatInputHistoryKey(host, {
        key: "ArrowUp",
        selectionStart: 0,
        selectionEnd: 0,
        valueLength: 5,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 38,
      }),
    ).toMatchObject({
      handled: true,
      preventDefault: true,
      restoreCaret: "up",
      decision: "handled:enter-history-up",
      historyNavigationActiveBefore: false,
      historyNavigationActiveAfter: true,
    });
    expect(host.chatInputHistoryIndex).toBe(0);
    expect(host.chatMessage).toBe("older");
  });

  it("navigates bidirectionally once history mode is active regardless of caret edge", () => {
    const host = createChatHistoryState({
      chatMessage: "draft",
      chatMessages: [textMessage("user", "oldest"), textMessage("user", "newest")],
    });

    expect(
      handleChatInputHistoryKey(host, {
        key: "ArrowUp",
        selectionStart: 0,
        selectionEnd: 0,
        valueLength: 5,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 38,
      }),
    ).toMatchObject({
      handled: true,
      decision: "handled:enter-history-up",
      historyNavigationActiveAfter: true,
    });
    expect(host.chatMessage).toBe("newest");

    expect(
      handleChatInputHistoryKey(host, {
        key: "ArrowUp",
        selectionStart: 6,
        selectionEnd: 6,
        valueLength: 6,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 38,
      }),
    ).toMatchObject({
      handled: true,
      decision: "handled:history-up",
      historyNavigationActiveBefore: true,
      historyNavigationActiveAfter: true,
    });
    expect(host.chatMessage).toBe("oldest");

    expect(
      handleChatInputHistoryKey(host, {
        key: "ArrowDown",
        selectionStart: 0,
        selectionEnd: 0,
        valueLength: 6,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 40,
      }),
    ).toMatchObject({
      handled: true,
      decision: "handled:history-down",
      restoreCaret: "down",
      historyNavigationActiveBefore: true,
      historyNavigationActiveAfter: true,
    });
    expect(host.chatMessage).toBe("newest");
  });

  it("blocks history recall while session history is loading", () => {
    const host = createChatHistoryState({
      chatLoading: true,
      chatMessage: "",
      chatMessages: [textMessage("user", "old-session-entry")],
      sessionKey: "next",
    });

    expect(
      handleChatInputHistoryKey(host, {
        key: "ArrowUp",
        selectionStart: 0,
        selectionEnd: 0,
        valueLength: 0,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 38,
      }),
    ).toMatchObject({
      handled: false,
      preventDefault: false,
      restoreCaret: null,
      decision: "blocked:history-loading",
      historyNavigationActiveBefore: false,
      historyNavigationActiveAfter: false,
    });
    expect(host.chatInputHistoryItems).toBeNull();
    expect(host.chatInputHistoryIndex).toBe(-1);
    expect(host.chatMessage).toBe("");
  });

  it("drops stale history mode before handling arrow keys after external draft replacement", () => {
    const host = createChatHistoryState({
      chatMessage: "draft",
      chatMessages: [textMessage("user", "older"), textMessage("user", "newer")],
    });

    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatInputHistoryIndex).toBe(0);
    expect(host.chatMessage).toBe("newer");

    host.chatMessage = "/focus ";

    expect(
      handleChatInputHistoryKey(host, {
        key: "ArrowDown",
        selectionStart: 7,
        selectionEnd: 7,
        valueLength: 7,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 40,
      }),
    ).toMatchObject({
      handled: false,
      preventDefault: false,
      restoreCaret: null,
      decision: "blocked:arrowdown-editing-mode",
      historyNavigationActiveBefore: false,
      historyNavigationActiveAfter: false,
    });
    expect(host.chatInputHistoryIndex).toBe(-1);
    expect(host.chatInputHistoryItems).toBeNull();
    expect(host.chatDraftBeforeHistory).toBeNull();
    expect(host.chatMessage).toBe("/focus ");
  });

  it("records locally handled slash commands for subsequent ArrowUp recall", async () => {
    const onSlashAction = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(3_000);
    const host = {
      connected: true,
      client: null,
      chatStream: null,
      chatLoading: false,
      chatMessage: "/focus",
      chatMessages: [],
      chatLocalInputHistoryBySession: {},
      chatInputHistorySessionKey: null,
      chatInputHistoryItems: null,
      chatInputHistoryIndex: -1,
      chatDraftBeforeHistory: null,
      chatAttachments: [],
      chatQueue: [],
      chatRunId: null,
      chatSending: false,
      lastError: null,
      basePath: "",
      hello: null,
      chatAvatarUrl: null,
      chatModelOverrides: {},
      chatModelsLoading: false,
      chatModelCatalog: [],
      refreshSessionsAfterChat: new Set<string>(),
      sessionKey: "main",
      onSlashAction,
    };

    await handleSendChat(host, undefined, undefined);

    expect(onSlashAction).toHaveBeenCalledWith("toggle-focus");
    expect(host.chatMessage).toBe("");
    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("/focus");
    now.mockRestore();
  });
});

describe("loadChatHistory", () => {
  it("filters assistant NO_REPLY messages and keeps user NO_REPLY messages", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
        { role: "assistant", content: [{ type: "text", text: "visible answer" }] },
        { role: "user", content: [{ type: "text", text: "NO_REPLY" }] },
      ],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state);

    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "main",
      limit: 200,
    });
    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "visible answer" }] },
      { role: "user", content: [{ type: "text", text: "NO_REPLY" }] },
    ]);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatLoading).toBe(false);
    expect(state.lastError).toBeNull();
  });

  it("invalidates cached input-history snapshot after async history replacement", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [{ role: "user", content: [{ type: "text", text: "new-session-entry" }] }],
    });
    const state = {
      ...createState({
        connected: true,
        client: { request } as unknown as ChatState["client"],
        sessionKey: "next",
        chatMessages: [{ role: "user", content: [{ type: "text", text: "old-session-entry" }] }],
      }),
      chatLocalInputHistoryBySession: {},
      chatInputHistorySessionKey: null,
      chatInputHistoryItems: null,
      chatInputHistoryIndex: -1,
      chatDraftBeforeHistory: null,
    } as ChatState & ChatInputHistoryState;
    state.resetChatInputHistoryNavigation = () => resetChatInputHistoryNavigation(state);

    expect(navigateChatInputHistory(state, "up")).toBe(true);
    expect(state.chatMessage).toBe("old-session-entry");
    expect(state.chatInputHistoryItems).toEqual(["old-session-entry"]);

    await loadChatHistory(state);

    expect(state.chatInputHistoryItems).toBeNull();
    expect(state.chatInputHistorySessionKey).toBeNull();
    state.chatMessage = "";
    expect(navigateChatInputHistory(state, "up")).toBe(true);
    expect(state.chatMessage).toBe("new-session-entry");
  });

  it("invalidates cached input-history snapshot when history reload fails", async () => {
    const request = vi.fn().mockRejectedValue(new Error("history failed"));
    const state = {
      ...createState({
        connected: true,
        client: { request } as unknown as ChatState["client"],
        sessionKey: "next",
        chatMessages: [{ role: "user", content: [{ type: "text", text: "old-session-entry" }] }],
      }),
      chatLocalInputHistoryBySession: {},
      chatInputHistorySessionKey: null,
      chatInputHistoryItems: null,
      chatInputHistoryIndex: -1,
      chatDraftBeforeHistory: null,
    } as ChatState & ChatInputHistoryState;
    state.resetChatInputHistoryNavigation = () => resetChatInputHistoryNavigation(state);

    expect(navigateChatInputHistory(state, "up")).toBe(true);
    expect(state.chatInputHistoryItems).toEqual(["old-session-entry"]);
    expect(state.chatInputHistoryIndex).toBe(0);

    await loadChatHistory(state);

    expect(state.chatInputHistoryItems).toBeNull();
    expect(state.chatInputHistorySessionKey).toBeNull();
    expect(state.chatInputHistoryIndex).toBe(-1);
    expect(state.chatDraftBeforeHistory).toBeNull();
    expect(state.lastError).toContain("history failed");
  });
});
