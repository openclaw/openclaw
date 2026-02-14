import { describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";

describe("createTelegramDraftStream", () => {
  it("passes message_thread_id when provided", () => {
    const api = { sendMessageDraft: vi.fn().mockResolvedValue(true) };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      draftId: 42,
      thread: { id: 99, scope: "forum" },
    });

    stream.update("Hello");

    expect(api.sendMessageDraft).toHaveBeenCalledWith(123, 42, "Hello", {
      message_thread_id: 99,
    });
  });

  it("omits message_thread_id for general topic id", () => {
    const api = { sendMessageDraft: vi.fn().mockResolvedValue(true) };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      draftId: 42,
      thread: { id: 1, scope: "forum" },
    });

    stream.update("Hello");

    expect(api.sendMessageDraft).toHaveBeenCalledWith(123, 42, "Hello", undefined);
  });

  it("omits message_thread_id for dm threads (Telegram rejects it in private chats)", () => {
    const api = { sendMessageDraft: vi.fn().mockResolvedValue(true) };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      draftId: 42,
      thread: { id: 1, scope: "dm" },
    });

    stream.update("Hello");

    // DM scope → no message_thread_id (#12929)
    expect(api.sendMessageDraft).toHaveBeenCalledWith(123, 42, "Hello", undefined);
  });
});
