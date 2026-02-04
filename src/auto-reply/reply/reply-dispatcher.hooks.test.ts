import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => true),
    runMessageSending: vi.fn(async () => ({})),
    runMessageSent: vi.fn(async () => {}),
  },
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

describe("createReplyDispatcher hooks", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hook: string) => hook === "message_sending" || hook === "message_sent",
    );
    hookMocks.runner.runMessageSending.mockReset().mockResolvedValue({});
    hookMocks.runner.runMessageSent.mockReset().mockResolvedValue(undefined);
  });

  it("fires message hooks with context/metadata and supports content override", async () => {
    const deliver = vi.fn(async (_payload: ReplyPayload) => {});
    hookMocks.runner.runMessageSending.mockResolvedValueOnce({ content: "override" });

    const dispatcher = createReplyDispatcher({
      deliver,
      hookContext: {
        channelId: "slack",
        accountId: "acc",
        conversationId: "channel:C1",
      },
      hookMetadata: { threadId: "t1" },
    });

    dispatcher.sendFinalReply({ text: "original", mediaUrl: "file:///tmp/photo.png" });
    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ text: "override", mediaUrl: "file:///tmp/photo.png" }),
      { kind: "final" },
    );
    expect(hookMocks.runner.runMessageSending).toHaveBeenCalledWith(
      {
        to: "channel:C1",
        content: "original",
        metadata: { threadId: "t1", kind: "final", hasMedia: true },
      },
      { channelId: "slack", accountId: "acc", conversationId: "channel:C1" },
    );
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      { to: "channel:C1", content: "override", success: true },
      { channelId: "slack", accountId: "acc", conversationId: "channel:C1" },
    );
  });

  it("cancels delivery when message_sending returns cancel", async () => {
    const deliver = vi.fn(async () => {});
    hookMocks.runner.runMessageSending.mockResolvedValueOnce({ cancel: true });

    const dispatcher = createReplyDispatcher({
      deliver,
      hookContext: { channelId: "telegram", conversationId: "123" },
    });

    dispatcher.sendFinalReply({ text: "nope" });
    await dispatcher.waitForIdle();

    expect(deliver).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      { to: "123", content: "nope", success: false, error: "cancelled by hook" },
      { channelId: "telegram", conversationId: "123" },
    );
  });

  it("reports delivery errors to message_sent", async () => {
    const deliver = vi.fn(async () => {
      throw new Error("boom");
    });
    const onError = vi.fn();

    const dispatcher = createReplyDispatcher({
      deliver,
      onError,
      hookContext: { channelId: "discord", conversationId: "channel:abc" },
    });

    dispatcher.sendFinalReply({ text: "hi" });
    await dispatcher.waitForIdle();

    expect(onError).toHaveBeenCalled();
    const call = hookMocks.runner.runMessageSent.mock.calls[0]?.[0] as
      | { success?: boolean; error?: string }
      | undefined;
    expect(call?.success).toBe(false);
    expect(call?.error).toContain("boom");
  });
});
