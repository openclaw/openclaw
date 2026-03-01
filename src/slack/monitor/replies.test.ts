import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const emitMessageSentHookMock = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/emit-message-sent.js", () => ({
  emitMessageSentHook: (...args: unknown[]) => emitMessageSentHookMock(...args),
}));

const sendMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

import { deliverReplies } from "./replies.js";

function baseParams(overrides?: Record<string, unknown>) {
  return {
    replies: [{ text: "hello" }],
    target: "C123",
    token: "xoxb-test",
    runtime: { log: () => {}, error: () => {}, exit: () => {} } as unknown as RuntimeEnv,
    textLimit: 4000,
    replyToMode: "off" as const,
    ...overrides,
  };
}

describe("deliverReplies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits message:sent hook on successful text delivery", async () => {
    await deliverReplies({
      ...baseParams(),
      accountId: "acct-1",
      sessionKey: "agent:main:main",
      target: "C12345",
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(emitMessageSentHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "C12345",
        content: "hello",
        success: true,
        channelId: "slack",
        accountId: "acct-1",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("emits message:sent failure hook when send throws", async () => {
    sendMock.mockRejectedValueOnce(new Error("slack_api_error"));

    await expect(
      deliverReplies({
        ...baseParams(),
        target: "C99999",
        sessionKey: "sess-fail",
      }),
    ).rejects.toThrow("slack_api_error");

    expect(emitMessageSentHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "C99999",
        success: false,
        error: "slack_api_error",
        channelId: "slack",
      }),
    );
  });

  it("emits hook per media item on successful delivery", async () => {
    await deliverReplies({
      ...baseParams({
        replies: [
          {
            text: "caption",
            mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
          },
        ],
      }),
      target: "C12345",
      sessionKey: "sess-media",
    });

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(emitMessageSentHookMock).toHaveBeenCalledTimes(2);
    expect(emitMessageSentHookMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ content: "caption", success: true }),
    );
    expect(emitMessageSentHookMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ content: "https://example.com/b.jpg", success: true }),
    );
  });
});

describe("deliverReplies identity passthrough", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("passes identity to sendMessageSlack for text replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const identity = { username: "Bot", iconEmoji: ":robot:" };
    await deliverReplies(baseParams({ identity }));

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ identity });
  });

  it("passes identity to sendMessageSlack for media replies", async () => {
    sendMock.mockResolvedValue(undefined);
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
    sendMock.mockResolvedValue(undefined);
    await deliverReplies(baseParams());

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).not.toHaveProperty("identity");
  });
});
