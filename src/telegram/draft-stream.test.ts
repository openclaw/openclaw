import { describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";

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
  return createTelegramDraftStream({
    // oxlint-disable-next-line typescript/no-explicit-any
    api: api as any,
    chatId: 123,
    thread,
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
    const api = {
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({ message_id: 17 })
        .mockResolvedValueOnce({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
    });

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
});
