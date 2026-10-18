// Channel outbound send tests cover CLI send runtime handoff to channel outbound adapters.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { sendChannelOutboundMessage } from "./channel-outbound-send.js";

const mocks = vi.hoisted(() => ({
  loadChannelOutboundAdapter: vi.fn(),
}));

vi.mock("../../channels/plugins/outbound/load.js", () => ({
  loadChannelOutboundAdapter: mocks.loadChannelOutboundAdapter,
}));

describe("sendChannelOutboundMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function expectSingleCallParams(mockFn: ReturnType<typeof vi.fn>) {
    expect(mockFn).toHaveBeenCalledTimes(1);
    const params = mockFn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    if (params === undefined) {
      throw new Error("expected outbound send call params");
    }
    return params;
  }

  it.each(["discord"] as const)(
    "classifies unavailable %s adapters as definitely not dispatched",
    async (channelId) => {
      mocks.loadChannelOutboundAdapter.mockResolvedValue(undefined);
      const unavailableMessage = `${channelId} outbound adapter is unavailable.`;

      const error = await sendChannelOutboundMessage(channelId, "target", "hello", {
        cfg: {},
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(error).toMatchObject({
        name: "PlatformMessageNotDispatchedError",
        message: unavailableMessage,
        cause: expect.objectContaining({
          message: unavailableMessage,
        }),
      });
    },
  );

  it("routes media sends through sendMedia and preserves media access", async () => {
    const sendMedia = vi.fn(async () => ({ channel: "whatsapp", messageId: "wa-1" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText: vi.fn(),
      sendMedia,
    });

    const mediaReadFile = vi.fn(async () => Buffer.from("image"));

    await sendChannelOutboundMessage("whatsapp", "+15551234567", "caption", {
      cfg: {},
      mediaUrl: "file:///tmp/photo.png",
      mediaAccess: {
        localRoots: ["/tmp/workspace"],
        readFile: mediaReadFile,
      },
      mediaLocalRoots: ["/tmp/fallback-root"],
      mediaReadFile,
      accountId: "default",
      gifPlayback: true,
    });

    const params = expectSingleCallParams(sendMedia);
    expect(params.cfg).toEqual({});
    expect(params.to).toBe("+15551234567");
    expect(params.text).toBe("caption");
    expect(params.mediaUrl).toBe("file:///tmp/photo.png");
    expect(params.mediaAccess).toEqual({
      localRoots: ["/tmp/workspace"],
      readFile: mediaReadFile,
    });
    expect(params.mediaLocalRoots).toEqual(["/tmp/fallback-root"]);
    expect(params.mediaReadFile).toBe(mediaReadFile);
    expect(params.accountId).toBe("default");
    expect(params.gifPlayback).toBe(true);
  });

  it("preserves rendered html formatting through lazy text sends", async () => {
    const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "tg-1" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const onPlatformSendDispatch = vi.fn();
    const opts = {
      cfg: {},
      textMode: "html" as const,
      accountId: "default",
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 3,
      deliveryPartCount: 4,
      onPlatformSendDispatch,
    };

    await sendChannelOutboundMessage(
      "telegram",
      "12345",
      '<a href="https://example.com">Example</a>',
      opts,
    );

    const params = expectSingleCallParams(sendText);
    expect(params.formatting).toEqual({ parseMode: "HTML" });
    expect(params.accountId).toBe("default");
    expect(params.deliveryQueueId).toBe("queue-1");
    expect(params.deliveryPartIndex).toBe(3);
    expect(params.deliveryPartCount).toBe(4);
    expect(params.onPlatformSendDispatch).toBe(onPlatformSendDispatch);
  });

  it("routes block sends through payload delivery", async () => {
    const sendPayload = vi.fn(async () => ({ channel: "slack", messageId: "slack-blocks" }));
    const sendText = vi.fn();
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendPayload,
      sendText,
    });

    const blocks = [
      {
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "OK" }, value: "ok" }],
      },
    ];

    await sendChannelOutboundMessage("slack", "C123", "fallback", {
      cfg: {},
      accountId: "default",
      blocks,
    });

    const params = expectSingleCallParams(sendPayload);
    expect(params.accountId).toBe("default");
    expect(params.cfg).toEqual({});
    expect(params.payload).toEqual({
      channelData: {
        slack: { blocks },
      },
      text: "fallback",
    });
    expect(params.text).toBe("fallback");
    expect(params.to).toBe("C123");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("accepts plugin outbound thread and reply aliases", async () => {
    const sendText = vi.fn(async () => ({ channel: "matrix", messageId: "$reply" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    await sendChannelOutboundMessage("matrix", "room:!ops:example.org", "hello thread", {
      cfg: {},
      accountId: "sut",
      replyToId: "$parent",
      threadId: "$thread-root",
    });

    const params = expectSingleCallParams(sendText);
    expect(params.accountId).toBe("sut");
    expect(params.replyToId).toBe("$parent");
    expect(params.threadId).toBe("$thread-root");
    expect(params.to).toBe("room:!ops:example.org");
  });
});
