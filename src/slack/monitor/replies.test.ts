import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
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
    sendMock.mockResolvedValue({ messageId: "m-1", channelId: "C123" });
  });
  it("passes identity to sendMessageSlack for text replies", async () => {
    const identity = { username: "Bot", iconEmoji: ":robot:" };
    await deliverReplies(baseParams({ identity }));

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ identity });
  });

  it("passes identity to sendMessageSlack for media replies", async () => {
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
    await deliverReplies(baseParams());

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).not.toHaveProperty("identity");
  });

  it("reports delivered=false for channelData-only payloads", async () => {
    const result = await deliverReplies(
      baseParams({
        replies: [{ channelData: { traceId: "noop" } }],
      }),
    );

    expect(sendMock).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: false, messageId: undefined });
  });

  it("reports delivered metadata from successful sends", async () => {
    sendMock.mockResolvedValueOnce({ messageId: "slack-msg-1", channelId: "C123" });

    const result = await deliverReplies(baseParams({ replies: [{ text: "hello   " }] }));

    expect(sendMock).toHaveBeenCalledOnce();
    expect(result).toEqual({
      delivered: true,
      messageId: "slack-msg-1",
      deliveredContent: "hello",
    });
  });
});
