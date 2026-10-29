// Core reply inheritance must reach the registered Slack outbound adapter.
import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  resolveAndApplyOutboundReplyToId,
  resolveAndApplyOutboundThreadId,
} from "./message-action-threading.js";

const { slackPlugin } = await loadBundledPluginFacade<{ slackPlugin: ChannelPlugin }>({
  pluginId: "slack",
  artifactBasename: "channel-plugin-api.js",
});

describe("message action Slack threading", () => {
  const cfg = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
      },
    },
  };

  it("keeps an ordinary message-tool update in the incoming Slack thread", async () => {
    const toolContext = {
      currentChannelProvider: "slack",
      currentChannelId: "C123",
      currentThreadTs: "1712345678.123456",
      currentMessageId: "1712345688.654321",
      replyToMode: "all" as const,
    };
    const params: Record<string, unknown> = { message: "Still checking." };
    const reply = resolveAndApplyOutboundReplyToId(params, {
      channel: "slack",
      toolContext,
      matchesToolContextTarget: slackPlugin.threading?.matchesToolContextTarget,
    });
    const threadId = resolveAndApplyOutboundThreadId(params, {
      cfg,
      to: "channel:C123",
      toolContext,
      resolveAutoThreadId: slackPlugin.threading?.resolveAutoThreadId,
      resolveReplyTransport: slackPlugin.threading?.resolveReplyTransport,
      replyToIsExplicit: reply?.source === "explicit",
    });

    const sendText = slackPlugin.outbound?.sendText;
    if (!sendText) {
      throw new Error("slack outbound.sendText unavailable");
    }
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "msg-1", channelId: "C123" });
    await sendText({
      cfg,
      to: "channel:C123",
      text: "Still checking.",
      replyToId: String(params.replyTo),
      threadId,
      deps: { sendSlack },
    });

    expect(params.replyTo).toBe("1712345678.123456");
    expect(threadId).toBe("1712345678.123456");
    expect(sendSlack).toHaveBeenCalledWith(
      "channel:C123",
      "Still checking.",
      expect.objectContaining({ threadTs: "1712345678.123456" }),
    );
  });
});
