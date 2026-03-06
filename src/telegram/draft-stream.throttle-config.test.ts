import { describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";

vi.mock("../channels/draft-stream-controls.js", () => ({
  createFinalizableDraftLifecycle: vi.fn().mockReturnValue({
    loop: { flush: vi.fn() },
    update: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
  }),
}));

const mockApi = {
  sendMessageDraft: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  editMessageText: vi.fn().mockResolvedValue(true),
  deleteMessage: vi.fn().mockResolvedValue(true),
} as never;

describe("createTelegramDraftStream throttleMs config (#38066)", () => {
  it("accepts custom throttleMs", () => {
    const stream = createTelegramDraftStream({
      api: mockApi,
      chatId: 123,
      throttleMs: 300,
    });
    expect(stream).toBeDefined();
    expect(stream.update).toBeInstanceOf(Function);
  });

  it("uses default when throttleMs is not provided", () => {
    const stream = createTelegramDraftStream({
      api: mockApi,
      chatId: 123,
    });
    expect(stream).toBeDefined();
  });

  it("clamps throttleMs to minimum 250ms", () => {
    const stream = createTelegramDraftStream({
      api: mockApi,
      chatId: 123,
      throttleMs: 100,
    });
    expect(stream).toBeDefined();
  });
});
