import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { sendChannelOutboundMessage, type RuntimeSendOpts } from "./channel-outbound-send.js";

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

  const defaults = { cfg: {}, accountId: "default" };
  function send(channel: ChannelId, opts: RuntimeSendOpts = {}, text = "hello") {
    return sendChannelOutboundMessage(channel, "target", text, { ...defaults, ...opts });
  }

  function expectSend(mockFn: ReturnType<typeof vi.fn>, params: Record<string, unknown>) {
    expect(mockFn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ...defaults, to: "target", text: "hello", ...params }),
    );
  }

  function mockSend(channel: string, method = "sendText", extra = {}) {
    const sender = vi.fn(async () => ({ channel, messageId: "sent" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({ ...extra, [method]: sender });
    return sender;
  }

  it("classifies unavailable adapters as definitely not dispatched", async () => {
    mocks.loadChannelOutboundAdapter.mockResolvedValue(undefined);
    const message = "discord outbound adapter is unavailable.";

    const error = await send("discord").catch((caught: unknown) => caught);
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
      mediaUrl: "file:///tmp/photo.png",
      mediaAccess: {
        localRoots: ["/tmp/workspace"],
        readFile: mediaReadFile,
      },
      mediaLocalRoots: ["/tmp/fallback-root"],
      mediaReadFile,
      gifPlayback: true,
    };
    await send("whatsapp", opts);
    expectSend(sendMedia, opts);
  });

  it("preserves rendered html formatting through lazy text sends", async () => {
    const sendText = mockSend("telegram");
    const opts = {
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 3,
      deliveryPartCount: 4,
      onPlatformSendDispatch: vi.fn(),
    };
    const text = '<a href="https://example.com">Example</a>';
    await send("telegram", { ...opts, textMode: "html" }, text);
    expectSend(sendText, { ...opts, text, formatting: { parseMode: "HTML" } });
  });

  it("routes block sends through payload delivery", async () => {
    const sendText = vi.fn();
    const sendPayload = mockSend("slack", "sendPayload", { sendText });

    const blocks = [{ type: "section", text: { type: "plain_text", text: "OK" } }];
    await send("slack", { blocks });
    expectSend(sendPayload, {
      payload: { channelData: { slack: { blocks } }, text: "hello" },
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("accepts plugin outbound thread and reply aliases", async () => {
    const sendText = mockSend("matrix");
    const opts = {
      accountId: "sut",
      replyToId: "$parent",
      threadId: "$thread-root",
    };
    await send("matrix", opts);
    expectSend(sendText, opts);
  });
});
