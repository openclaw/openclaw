import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { telegramOutbound } from "../../channels/plugins/outbound/telegram.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

const { deliverOutboundPayloads } = await import("./deliver.js");
const defaultRegistry = createTestRegistry([
  {
    pluginId: "telegram",
    plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
    source: "test",
  },
]);

describe("deliverOutboundPayloads Greptile fixes", () => {
  beforeEach(() => {
    setActivePluginRegistry(defaultRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("retries replyToId on later non-signal text payloads after a best-effort failure", async () => {
    const sendTelegram = vi
      .fn()
      .mockRejectedValueOnce(new Error("text fail"))
      .mockResolvedValueOnce({ messageId: "m2", chatId: "chat-1" });
    const onError = vi.fn();
    const cfg: OpenClawConfig = {
      channels: { telegram: { botToken: "tok-1", textChunkLimit: 2 } },
    };

    const results = await deliverOutboundPayloads({
      cfg,
      channel: "telegram",
      to: "123",
      payloads: [{ text: "ab" }, { text: "cd" }],
      replyToId: "777",
      deps: { sendTelegram },
      bestEffort: true,
      onError,
      skipQueue: true,
    });

    expect(sendTelegram).toHaveBeenCalledTimes(2);
    expect(sendTelegram.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ replyToMessageId: 777 }),
    );
    expect(sendTelegram.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ replyToMessageId: 777 }),
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ messageId: "m2", chatId: "chat-1", channel: "telegram" }]);
  });

  it("retries replyToId on later sendPayload payloads after a best-effort failure", async () => {
    const sendPayload = vi
      .fn()
      .mockRejectedValueOnce(new Error("payload fail"))
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-2" });
    const sendText = vi.fn();
    const sendMedia = vi.fn();
    const onError = vi.fn();

    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendPayload, sendText, sendMedia },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [
        { text: "first", channelData: { mode: "custom" } },
        { text: "second", channelData: { mode: "custom" } },
      ],
      replyToId: "orig-msg-id",
      bestEffort: true,
      onError,
      skipQueue: true,
    });

    expect(sendPayload).toHaveBeenCalledTimes(2);
    expect(sendPayload.mock.calls[0]?.[0]?.replyToId).toBe("orig-msg-id");
    expect(sendPayload.mock.calls[1]?.[0]?.replyToId).toBe("orig-msg-id");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ channel: "matrix", messageId: "mx-2" }]);
  });

  it("preserves explicit null reply suppression without consuming the inherited reply", async () => {
    const sendPayload = vi
      .fn()
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-1" })
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-2" });
    const sendText = vi.fn();
    const sendMedia = vi.fn();

    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendPayload, sendText, sendMedia },
          }),
        },
      ]),
    );

    const payloads: ReplyPayload[] = [
      { text: "first", channelData: { mode: "custom" }, replyToId: null },
      { text: "second", channelData: { mode: "custom" } },
    ];

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads,
      replyToId: "orig-msg-id",
      skipQueue: true,
    });

    expect(sendPayload).toHaveBeenCalledTimes(2);
    expect(sendPayload.mock.calls[0]?.[0]?.replyToId).toBeUndefined();
    expect(sendPayload.mock.calls[1]?.[0]?.replyToId).toBe("orig-msg-id");
    expect(results).toEqual([
      { channel: "matrix", messageId: "mx-1" },
      { channel: "matrix", messageId: "mx-2" },
    ]);
  });

  it("treats replyToId: undefined as inherited reply metadata", async () => {
    const sendPayload = vi
      .fn()
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-1" })
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-2" });
    const sendText = vi.fn();
    const sendMedia = vi.fn();

    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendPayload, sendText, sendMedia },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [
        { text: "first", channelData: { mode: "custom" }, replyToId: undefined },
        { text: "second", channelData: { mode: "custom" } },
      ],
      replyToId: "orig-msg-id",
      skipQueue: true,
    });

    expect(sendPayload).toHaveBeenCalledTimes(2);
    expect(sendPayload.mock.calls[0]?.[0]?.replyToId).toBe("orig-msg-id");
    expect(sendPayload.mock.calls[1]?.[0]?.replyToId).toBeNull();
    expect(results).toEqual([
      { channel: "matrix", messageId: "mx-1" },
      { channel: "matrix", messageId: "mx-2" },
    ]);
  });

  it("clears replyToId on later sendPayload payloads after the first successful send", async () => {
    const sendPayload = vi
      .fn()
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-1" })
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-2" });
    const sendText = vi.fn();
    const sendMedia = vi.fn();

    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendPayload, sendText, sendMedia },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [
        { text: "first", channelData: { mode: "custom" } },
        { text: "second", channelData: { mode: "custom" } },
      ],
      replyToId: "orig-msg-id",
      skipQueue: true,
    });

    expect(sendPayload).toHaveBeenCalledTimes(2);
    expect(sendPayload.mock.calls[0]?.[0]?.replyToId).toBe("orig-msg-id");
    expect(sendPayload.mock.calls[1]?.[0]?.replyToId).toBeNull();
    expect(results).toEqual([
      { channel: "matrix", messageId: "mx-1" },
      { channel: "matrix", messageId: "mx-2" },
    ]);
  });

  it("preserves later explicit replyToId values after the first successful send", async () => {
    const sendPayload = vi
      .fn()
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-1" })
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-2" })
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-3" });
    const sendText = vi.fn();
    const sendMedia = vi.fn();

    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendPayload, sendText, sendMedia },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [
        { text: "first", replyToId: "reply-1", channelData: { mode: "custom" } },
        { text: "second", replyToId: "reply-2", channelData: { mode: "custom" } },
        { text: "third", replyToId: "reply-3", channelData: { mode: "custom" } },
      ],
      skipQueue: true,
    });

    expect(sendPayload).toHaveBeenCalledTimes(3);
    expect(sendPayload.mock.calls[0]?.[0]?.replyToId).toBe("reply-1");
    expect(sendPayload.mock.calls[1]?.[0]?.replyToId).toBe("reply-2");
    expect(sendPayload.mock.calls[2]?.[0]?.replyToId).toBe("reply-3");
    expect(results).toEqual([
      { channel: "matrix", messageId: "mx-1" },
      { channel: "matrix", messageId: "mx-2" },
      { channel: "matrix", messageId: "mx-3" },
    ]);
  });

  it("retries replyToId on later non-signal media payloads after a best-effort failure", async () => {
    const sendText = vi.fn();
    const sendMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error("media fail"))
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-media-2" });
    const onError = vi.fn();

    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText, sendMedia },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [
        { text: "first", mediaUrl: "https://example.com/1.jpg" },
        { text: "second", mediaUrl: "https://example.com/2.jpg" },
      ],
      replyToId: "orig-msg-id",
      bestEffort: true,
      onError,
      skipQueue: true,
    });

    expect(sendMedia).toHaveBeenCalledTimes(2);
    expect(sendMedia.mock.calls[0]?.[0]?.replyToId).toBe("orig-msg-id");
    expect(sendMedia.mock.calls[1]?.[0]?.replyToId).toBe("orig-msg-id");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ channel: "matrix", messageId: "mx-media-2" }]);
  });
});
