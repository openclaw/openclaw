import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const emitHookMock = vi.fn();
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));
vi.mock("../../hooks/emit-message-sent.js", () => ({
  emitMessageSentHook: (...args: unknown[]) => emitHookMock(...args),
}));

import { deliverReplies } from "./replies.js";

function baseParams(overrides?: Record<string, unknown>) {
  return {
    replies: [{ text: "hello" }],
    target: "C123",
    token: "xoxb-test",
    runtime: { log: () => {}, error: () => {}, exit: () => {} },
    textLimit: 4000,
    replyToMode: "off" as const,
    ...overrides,
  };
}

describe("deliverReplies identity passthrough", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });
  it("passes identity to sendMessageSlack for text replies", async () => {
    sendMock.mockResolvedValue({ messageId: "ts-1", channelId: "C123" });
    const identity = { username: "Bot", iconEmoji: ":robot:" };
    await deliverReplies(baseParams({ identity }));

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ identity });
  });

  it("passes identity to sendMessageSlack for media replies", async () => {
    sendMock.mockResolvedValue({ messageId: "ts-1", channelId: "C123" });
    const identity = { username: "Bot", iconUrl: "https://example.com/icon.png" };
    await deliverReplies(
      baseParams({
        identity,
        replies: [{ text: "caption", mediaUrls: ["https://example.com/img.png"] }],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ identity });
  });

  it("omits identity key when not provided", async () => {
    sendMock.mockResolvedValue({ messageId: "ts-1", channelId: "C123" });
    await deliverReplies(baseParams());

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).not.toHaveProperty("identity");
  });
});

describe("deliverReplies message:sent hook", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ messageId: "ts-1", channelId: "C123" });
    emitHookMock.mockReset();
  });

  it("emits success hook with messageId after delivery", async () => {
    await deliverReplies(baseParams({ sessionKey: "sess-1", accountId: "acct" }));

    expect(emitHookMock).toHaveBeenCalledWith({
      to: "C123",
      content: "hello",
      success: true,
      messageId: "ts-1",
      channelId: "slack",
      accountId: "acct",
      sessionKey: "sess-1",
    });
  });

  it("emits failure hook when send throws", async () => {
    sendMock.mockRejectedValue(new Error("network error"));

    await expect(deliverReplies(baseParams({ sessionKey: "sess-1" }))).rejects.toThrow(
      "network error",
    );

    expect(emitHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "network error",
        channelId: "slack",
      }),
    );
  });

  it("emits hook without sessionKey when not provided", async () => {
    await deliverReplies(baseParams());

    expect(emitHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        sessionKey: undefined,
      }),
    );
  });
});
