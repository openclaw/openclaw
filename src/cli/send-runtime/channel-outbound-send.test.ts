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

  function expectSend(mockFn: ReturnType<typeof vi.fn>, params: Record<string, unknown>) {
    expect(mockFn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(params));
  }

  function mockSend(channel: string, method = "sendText", extra = {}) {
    const send = vi.fn(async () => ({ channel, messageId: "sent" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({ ...extra, [method]: send });
    return send;
  }

  it("classifies unavailable adapters as definitely not dispatched", async () => {
    mocks.loadChannelOutboundAdapter.mockResolvedValue(undefined);
    const message = "discord outbound adapter is unavailable.";

    const error = await sendChannelOutboundMessage("discord", "target", "hello", {
      cfg: {},
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({
      name: "PlatformMessageNotDispatchedError",
      message,
      cause: expect.objectContaining({ message }),
    });
  });

  it("routes media sends through sendMedia and preserves media access", async () => {
    const sendMedia = mockSend("whatsapp", "sendMedia", { sendText: vi.fn() });
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const opts = {
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
    };
    await sendChannelOutboundMessage("whatsapp", "+15551234567", "caption", opts);

    expectSend(sendMedia, {
      ...opts,
      to: "+15551234567",
      text: "caption",
    });
  });

  it("preserves rendered html formatting through lazy text sends", async () => {
    const sendText = mockSend("telegram");
    const onPlatformSendDispatch = vi.fn();
    const opts = {
      cfg: {},
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
      { ...opts, textMode: "html" },
    );

    expectSend(sendText, { ...opts, formatting: { parseMode: "HTML" } });
  });

  it("routes block sends through payload delivery", async () => {
    const sendText = vi.fn();
    const sendPayload = mockSend("slack", "sendPayload", { sendText });

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

    expectSend(sendPayload, {
      accountId: "default",
      cfg: {},
      payload: { channelData: { slack: { blocks } }, text: "fallback" },
      text: "fallback",
      to: "C123",
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("accepts plugin outbound thread and reply aliases", async () => {
    const sendText = mockSend("matrix");
    const opts = {
      cfg: {},
      accountId: "sut",
      replyToId: "$parent",
      threadId: "$thread-root",
    };
    await sendChannelOutboundMessage("matrix", "room:!ops:example.org", "hello thread", opts);

    expectSend(sendText, { ...opts, to: "room:!ops:example.org" });
  });
});
