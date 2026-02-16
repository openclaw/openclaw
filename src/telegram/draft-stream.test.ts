import { describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";

describe("createTelegramDraftStream", () => {
  it("sends stream preview message with message_thread_id when provided", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 17 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      thread: { id: 99, scope: "forum" },
    });

    stream.update("Hello");

    await vi.waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", { message_thread_id: 99 }),
    );
  });

  it("edits existing stream preview message on subsequent updates", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 17 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      thread: { id: 99, scope: "forum" },
    });

    stream.update("Hello");
    await vi.waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", { message_thread_id: 99 }),
    );
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
    const api = {
      sendMessage: vi.fn().mockReturnValue(firstSend),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      thread: { id: 99, scope: "forum" },
    });

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
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 17 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      thread: { id: 1, scope: "forum" },
    });

    stream.update("Hello");

    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", undefined));
  });

  it("omits message_thread_id for dm threads and clears preview on cleanup", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 17 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      thread: { id: 1, scope: "dm" },
    });

    stream.update("Hello");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", undefined));
    await stream.clear();

    expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
  });

  it("includes reply_to_message_id in initial sendMessage when replyToMessageId is set", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      replyToMessageId: 999,
    });

    stream.update("Hello");
    await vi.waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", { reply_to_message_id: 999 }),
    );
  });

  it("includes both reply_to_message_id and message_thread_id when both are set", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      thread: { id: 99, scope: "forum" },
      replyToMessageId: 555,
    });

    stream.update("Hello");
    await vi.waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", {
        message_thread_id: 99,
        reply_to_message_id: 555,
      }),
    );
  });

  it("passes undefined params when neither thread nor replyToMessageId is set", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
    });

    stream.update("Hello");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", undefined));
  });

  it("includes reply_to_message_id even when thread resolves to general topic", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      thread: { id: 1, scope: "forum" },
      replyToMessageId: 888,
    });

    stream.update("Hello");
    await vi.waitFor(() =>
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", { reply_to_message_id: 888 }),
    );
  });
});
