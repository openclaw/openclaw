/**
 * End-to-end integration test for #14920: replyToId passthrough
 *
 * Verifies that sendMessage forwards replyToId all the way through
 * deliverOutboundPayloads → createChannelHandler → plugin sendText.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

const sendTextSpy = vi.fn(async () => ({
  channel: "mattermost" as const,
  messageId: "msg-1",
}));

const sendMediaSpy = vi.fn(async () => ({
  channel: "mattermost" as const,
  messageId: "msg-2",
}));

const mattermostOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: sendTextSpy,
  sendMedia: sendMediaSpy,
};

const registry = createTestRegistry([
  {
    pluginId: "mattermost",
    source: "test",
    plugin: createOutboundTestPlugin({
      id: "mattermost",
      outbound: mattermostOutbound,
      label: "Mattermost",
    }),
  },
]);

const emptyRegistry = createTestRegistry([]);

describe("sendMessage replyToId end-to-end (#14920)", () => {
  beforeEach(() => {
    sendTextSpy.mockClear();
    sendMediaSpy.mockClear();
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("forwards replyToId from sendMessage to plugin sendText", async () => {
    const { sendMessage } = await import("./message.js");

    await sendMessage({
      cfg: {},
      to: "channel-123",
      content: "Thread reply",
      channel: "mattermost",
      replyToId: "post-abc-123",
    });

    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    const callArgs = sendTextSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs?.replyToId).toBe("post-abc-123");
    expect(callArgs?.to).toBe("channel-123");
    expect(callArgs?.text).toBe("Thread reply");
  });

  it("plugin sendText receives undefined replyToId when not provided", async () => {
    const { sendMessage } = await import("./message.js");

    await sendMessage({
      cfg: {},
      to: "channel-123",
      content: "Root message",
      channel: "mattermost",
    });

    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    const callArgs = sendTextSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs?.replyToId).toBeUndefined();
  });
});
