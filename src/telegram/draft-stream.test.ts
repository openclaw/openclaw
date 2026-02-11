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

  it("keeps message_thread_id for dm threads", () => {
    const api = { sendMessageDraft: vi.fn().mockResolvedValue(true) };
    const stream = createTelegramDraftStream({
      // oxlint-disable-next-line typescript/no-explicit-any
      api: api as any,
      chatId: 123,
      draftId: 42,
      thread: { id: 1, scope: "dm" },
    });

    stream.update("Hello");

    expect(api.sendMessageDraft).toHaveBeenCalledWith(123, 42, "Hello", {
      message_thread_id: 1,
    });
  });

  it("stops on draft timeout to avoid blocking final delivery", async () => {
    vi.useFakeTimers();
    try {
      const api = { sendMessageDraft: vi.fn(() => new Promise(() => undefined)) };
      const warn = vi.fn();
      const stream = createTelegramDraftStream({
        // oxlint-disable-next-line typescript/no-explicit-any
        api: api as any,
        chatId: 123,
        draftId: 42,
        draftTimeoutMs: 60,
        throttleMs: 50,
        warn,
      });

      stream.update("Hello");
      const flushPromise = stream.flush();
      await vi.advanceTimersByTimeAsync(80);
      await flushPromise;

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("timeout"));

      stream.update("Hello again");
      await vi.advanceTimersByTimeAsync(200);
      expect(api.sendMessageDraft).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
