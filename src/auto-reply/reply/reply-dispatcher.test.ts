import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: mocks.getGlobalHookRunner,
}));

const { createReplyDispatcher } = await import("./reply-dispatcher.js");

describe("createReplyDispatcher – message_sent hook", () => {
  let mockRunMessageSent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRunMessageSent = vi.fn().mockResolvedValue(undefined);
    mocks.getGlobalHookRunner.mockReturnValue({
      runMessageSent: mockRunMessageSent,
      hasHooks: vi.fn().mockReturnValue(true),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls runMessageSent after successful delivery", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      hookContext: {
        channelId: "telegram",
        accountId: "acct-1",
        conversationId: "conv-1",
      },
    });

    dispatcher.sendFinalReply({ text: "Hello world" });
    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(mockRunMessageSent).toHaveBeenCalledTimes(1);
    expect(mockRunMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "conv-1",
        content: "Hello world",
        success: true,
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "acct-1",
        conversationId: "conv-1",
      }),
    );
  });

  it("passes hookContext through to the hook context", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      hookContext: {
        channelId: "discord",
        accountId: "bot-7",
        conversationId: "ch-42",
      },
    });

    dispatcher.sendBlockReply({ text: "hi" });
    await dispatcher.waitForIdle();

    expect(mockRunMessageSent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelId: "discord",
        accountId: "bot-7",
        conversationId: "ch-42",
      }),
    );
  });

  it("does NOT call runMessageSent when delivery fails", async () => {
    const deliver = vi.fn().mockRejectedValue(new Error("network down"));
    const onError = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver,
      onError,
      hookContext: {
        channelId: "telegram",
        conversationId: "conv-1",
      },
    });

    dispatcher.sendFinalReply({ text: "fail" });
    await dispatcher.waitForIdle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(mockRunMessageSent).not.toHaveBeenCalled();
  });

  it("does NOT call runMessageSent when normalized text is empty", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({ deliver });

    // Empty text payload is dropped by normalizeReplyPayload, so deliver is never called
    const enqueued = dispatcher.sendFinalReply({ text: "" });
    await dispatcher.waitForIdle();

    expect(enqueued).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(mockRunMessageSent).not.toHaveBeenCalled();
  });

  it("runMessageSent errors don't break delivery (fire-and-forget)", async () => {
    mockRunMessageSent.mockRejectedValue(new Error("hook exploded"));
    const deliver = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver,
      onError,
      hookContext: {
        channelId: "telegram",
        conversationId: "conv-1",
      },
    });

    dispatcher.sendFinalReply({ text: "safe" });
    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(1);
    // onError should NOT have been called — the hook error is swallowed
    expect(onError).not.toHaveBeenCalled();
  });
});
