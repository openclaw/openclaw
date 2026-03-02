import type { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";

// Mock the sendMessageDraft helper so tests don't hit the real Telegram API.
vi.mock("./draft-message-api.js", () => ({
  sendMessageDraft: vi.fn().mockResolvedValue(true),
}));
import { sendMessageDraft } from "./draft-message-api.js";

type TelegramDraftStreamParams = Parameters<typeof createTelegramDraftStream>[0];

function createMockDraftApi(sendMessageImpl?: () => Promise<{ message_id: number }>) {
  return {
    sendMessage: vi.fn(sendMessageImpl ?? (async () => ({ message_id: 17 }))),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  };
}

function createForumDraftStream(api: ReturnType<typeof createMockDraftApi>) {
  return createThreadedDraftStream(api, { id: 99, scope: "forum" });
}

function createThreadedDraftStream(
  api: ReturnType<typeof createMockDraftApi>,
  thread: { id: number; scope: "forum" | "dm" },
) {
  return createDraftStream(api, { thread });
}

function createDraftStream(
  api: ReturnType<typeof createMockDraftApi>,
  overrides: Omit<Partial<TelegramDraftStreamParams>, "api" | "chatId"> = {},
) {
  return createTelegramDraftStream({
    api: api as unknown as Bot["api"],
    chatId: 123,
    ...overrides,
  });
}

async function expectInitialForumSend(
  api: ReturnType<typeof createMockDraftApi>,
  text = "Hello",
): Promise<void> {
  await vi.waitFor(() =>
    expect(api.sendMessage).toHaveBeenCalledWith(123, text, { message_thread_id: 99 }),
  );
}

function createForceNewMessageHarness(params: { throttleMs?: number } = {}) {
  const api = createMockDraftApi();
  api.sendMessage
    .mockResolvedValueOnce({ message_id: 17 })
    .mockResolvedValueOnce({ message_id: 42 });
  const stream = createDraftStream(
    api,
    params.throttleMs != null ? { throttleMs: params.throttleMs } : {},
  );
  return { api, stream };
}

describe("createTelegramDraftStream", () => {
  it("sends stream preview message with message_thread_id when provided", async () => {
    const api = createMockDraftApi();
    const stream = createForumDraftStream(api);

    stream.update("Hello");
    await expectInitialForumSend(api);
  });

  it("edits existing stream preview message on subsequent updates", async () => {
    const api = createMockDraftApi();
    const stream = createForumDraftStream(api);

    stream.update("Hello");
    await expectInitialForumSend(api);
    await (api.sendMessage.mock.results[0]?.value as Promise<unknown>);

    stream.update("Hello again");
    await stream.flush();

    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "Hello again");
  });

  it("waits for in-flight updates before final flush edit", async () => {
    let resolveSend: ((value: { message_id: number }) => void) | undefined;
    const firstSend = new Promise<{ message_id: number }>((resolve) => {
      resolveSend = resolve;
    });
    const api = createMockDraftApi(() => firstSend);
    const stream = createForumDraftStream(api);

    stream.update("Hello");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    stream.update("Hello final");
    const flushPromise = stream.flush();
    expect(api.editMessageText).not.toHaveBeenCalled();

    resolveSend?.({ message_id: 17 });
    await flushPromise;

    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "Hello final");
  });

  it("omits message_thread_id for general topic id", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 1, scope: "forum" });

    stream.update("Hello");

    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", undefined));
  });

  it("includes message_thread_id for dm threads and clears preview on cleanup", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 42, scope: "dm" });

    stream.update("Hello");
    await vi.waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", { message_thread_id: 42 }),
    );
    await stream.clear();

    expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
  });

  it("creates new message after forceNewMessage is called", async () => {
    const { api, stream } = createForceNewMessageHarness();

    // First message
    stream.update("Hello");
    await stream.flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    // Normal edit (same message)
    stream.update("Hello edited");
    await stream.flush();
    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "Hello edited");

    // Force new message (e.g. after thinking block ends)
    stream.forceNewMessage();
    stream.update("After thinking");
    await stream.flush();

    // Should have sent a second new message, not edited the first
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenLastCalledWith(123, "After thinking", undefined);
  });

  it("sends first update immediately after forceNewMessage within throttle window", async () => {
    vi.useFakeTimers();
    try {
      const { api, stream } = createForceNewMessageHarness({ throttleMs: 1000 });

      stream.update("Hello");
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));

      stream.update("Hello edited");
      expect(api.editMessageText).not.toHaveBeenCalled();

      stream.forceNewMessage();
      stream.update("Second message");
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
      expect(api.sendMessage).toHaveBeenLastCalledWith(123, "Second message", undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rebind to an old message when forceNewMessage races an in-flight send", async () => {
    let resolveFirstSend: ((value: { message_id: number }) => void) | undefined;
    const firstSend = new Promise<{ message_id: number }>((resolve) => {
      resolveFirstSend = resolve;
    });
    const api = {
      sendMessage: vi.fn().mockReturnValueOnce(firstSend).mockResolvedValueOnce({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const onSupersededPreview = vi.fn();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      onSupersededPreview,
    });

    stream.update("Message A partial");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));

    // Rotate to message B before message A send resolves.
    stream.forceNewMessage();
    stream.update("Message B partial");

    resolveFirstSend?.({ message_id: 17 });
    await stream.flush();

    expect(onSupersededPreview).toHaveBeenCalledWith({
      messageId: 17,
      textSnapshot: "Message A partial",
      parseMode: undefined,
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "Message B partial", undefined);
    expect(api.editMessageText).not.toHaveBeenCalledWith(123, 17, "Message B partial");
  });

  it("supports rendered previews with parse_mode", async () => {
    const api = createMockDraftApi();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      renderText: (text) => ({ text: `<i>${text}</i>`, parseMode: "HTML" }),
    });

    stream.update("hello");
    await stream.flush();
    expect(api.sendMessage).toHaveBeenCalledWith(123, "<i>hello</i>", { parse_mode: "HTML" });

    stream.update("hello again");
    await stream.flush();
    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "<i>hello again</i>", {
      parse_mode: "HTML",
    });
  });

  it("enforces maxChars after renderText expansion", async () => {
    const api = createMockDraftApi();
    const warn = vi.fn();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      maxChars: 100,
      renderText: () => ({ text: `<b>${"<".repeat(120)}</b>`, parseMode: "HTML" }),
      warn,
    });

    stream.update("short raw text");
    await stream.flush();

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("telegram stream preview stopped (text length 127 > 100)"),
    );
  });
});

describe("draft stream initial message debounce", () => {
  const createMockApi = () => ({
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isFinal has highest priority", () => {
    it("sends immediately on stop() even with 1 character", async () => {
      const api = createMockApi();
      const stream = createTelegramDraftStream({
        api: api as unknown as Bot["api"],
        chatId: 123,
        minInitialChars: 30,
      });

      stream.update("Y");
      await stream.stop();
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalledWith(123, "Y", undefined);
    });

    it("sends immediately on stop() with short sentence", async () => {
      const api = createMockApi();
      const stream = createTelegramDraftStream({
        api: api as unknown as Bot["api"],
        chatId: 123,
        minInitialChars: 30,
      });

      stream.update("Ok.");
      await stream.stop();
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalledWith(123, "Ok.", undefined);
    });
  });

  describe("minInitialChars threshold", () => {
    it("does not send first message below threshold", async () => {
      const api = createMockApi();
      const stream = createTelegramDraftStream({
        api: api as unknown as Bot["api"],
        chatId: 123,
        minInitialChars: 30,
      });

      stream.update("Processing"); // 10 chars, below 30
      await stream.flush();

      expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("sends first message when reaching threshold", async () => {
      const api = createMockApi();
      const stream = createTelegramDraftStream({
        api: api as unknown as Bot["api"],
        chatId: 123,
        minInitialChars: 30,
      });

      // Exactly 30 chars
      stream.update("I am processing your request..");
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalled();
    });

    it("works with longer text above threshold", async () => {
      const api = createMockApi();
      const stream = createTelegramDraftStream({
        api: api as unknown as Bot["api"],
        chatId: 123,
        minInitialChars: 30,
      });

      stream.update("I am processing your request, please wait a moment"); // 50 chars
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalled();
    });
  });

  describe("subsequent updates after first message", () => {
    it("edits normally after first message is sent", async () => {
      const api = createMockApi();
      const stream = createTelegramDraftStream({
        api: api as unknown as Bot["api"],
        chatId: 123,
        minInitialChars: 30,
      });

      // First message at threshold (30 chars)
      stream.update("I am processing your request..");
      await stream.flush();
      expect(api.sendMessage).toHaveBeenCalledTimes(1);

      // Subsequent updates should edit, not wait for threshold
      stream.update("I am processing your request.. and summarizing");
      await stream.flush();

      expect(api.editMessageText).toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledTimes(1); // still only 1 send
    });
  });

  describe("default behavior without debounce params", () => {
    it("sends immediately without minInitialChars set (backward compatible)", async () => {
      const api = createMockApi();
      const stream = createTelegramDraftStream({
        api: api as unknown as Bot["api"],
        chatId: 123,
        // no minInitialChars (backward-compatible behavior)
      });

      stream.update("Hi");
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalledWith(123, "Hi", undefined);
    });
  });
});

describe("sendMessageDraft integration", () => {
  beforeEach(() => {
    vi.mocked(sendMessageDraft).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses sendMessageDraft for in-progress updates by default", async () => {
    const api = createMockDraftApi();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
    });

    stream.update("Thinking...");
    await stream.flush();

    // sendMessageDraft should have been called for the in-progress update.
    expect(sendMessageDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chat_id: 123, text: "Thinking..." }),
    );
    // sendMessage should NOT have been called (no final flush yet).
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("finalizes with sendMessage after sendMessageDraft updates", async () => {
    const api = createMockDraftApi();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
    });

    stream.update("Thinking...");
    await stream.stop();
    await stream.flush();

    expect(sendMessageDraft).toHaveBeenCalled();
    // Final stop() triggers sendMessage for the permanent message.
    expect(api.sendMessage).toHaveBeenCalledWith(123, "Thinking...", undefined);
  });

  it("reuses the same draft_id across multiple updates", async () => {
    const api = createMockDraftApi();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 456,
    });

    stream.update("Part one");
    await stream.flush();
    stream.update("Part one. Part two");
    await stream.flush();

    const calls = vi.mocked(sendMessageDraft).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const draftIds = calls.map((c) => c[1].draft_id);
    // All calls should use the same non-zero draft_id.
    expect(new Set(draftIds).size).toBe(1);
    expect(draftIds[0]).toBeGreaterThan(0);
  });

  it("falls back to legacy send-then-edit when sendMessageDraft returns ok=false", async () => {
    vi.mocked(sendMessageDraft).mockResolvedValue(false);
    const api = createMockDraftApi();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
    });

    stream.update("Hello");
    await stream.flush();

    // Should have fallen back to sendMessage.
    expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", undefined);
  });

  it("falls back to legacy send-then-edit when sendMessageDraft throws", async () => {
    vi.mocked(sendMessageDraft).mockRejectedValue(new Error("Method not found"));
    const api = createMockDraftApi();
    const warn = vi.fn();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      warn,
    });

    stream.update("Hello");
    await stream.flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("falling back to send-then-edit"));
    expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", undefined);
  });

  it("respects useSendMessageDraft=false opt-out", async () => {
    const api = createMockDraftApi();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      useSendMessageDraft: false,
    });

    stream.update("Hello");
    await stream.flush();

    expect(sendMessageDraft).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", undefined);
  });

  it("passes message_thread_id to sendMessageDraft for threaded chats", async () => {
    const api = createMockDraftApi();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      thread: { id: 99, scope: "forum" },
    });

    stream.update("Hello thread");
    await stream.flush();

    expect(sendMessageDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message_thread_id: 99 }),
    );
  });
});
