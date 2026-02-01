import { describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";

describe("createTelegramDraftStream", () => {
  it("passes message_thread_id when provided", () => {
    const api = { sendMessageDraft: vi.fn().mockResolvedValue(true) };
    const stream = createTelegramDraftStream({
      api: api as any,
      chatId: 123,
      draftId: 42,
      messageThreadId: 99,
    });

    stream.update("Hello");

    expect(api.sendMessageDraft).toHaveBeenCalledWith(123, 42, "Hello", {
      message_thread_id: 99,
    });
  });

  it("omits message_thread_id for general topic id", () => {
    const api = { sendMessageDraft: vi.fn().mockResolvedValue(true) };
    const stream = createTelegramDraftStream({
      api: api as any,
      chatId: 123,
      draftId: 42,
      messageThreadId: 1,
    });

    stream.update("Hello");

    expect(api.sendMessageDraft).toHaveBeenCalledWith(123, 42, "Hello", undefined);
  });
});
