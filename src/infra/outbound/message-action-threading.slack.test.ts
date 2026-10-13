import { expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  resolveAndApplyOutboundReplyToId,
  resolveAndApplyOutboundThreadId,
} from "./message-action-threading.js";

const { slackPlugin } = await loadBundledPluginFacade<{ slackPlugin: ChannelPlugin }>({
  pluginId: "slack",
  artifactBasename: "channel-plugin-api.ts",
});

it.each([
  { source: "C123", target: "channel:C123" },
  { source: "team:T123:channel:C123", target: "channel:C123" },
  { source: "team:T123:channel:C123", target: "C123" },
])(
  "keeps a message-tool update in its Slack root from $source via $target",
  async ({ source, target }) => {
    const sendText = slackPlugin.outbound?.sendText;
    if (!sendText) {
      throw new Error("slack outbound.sendText unavailable");
    }
    const cfg = {
      channels: { slack: { botToken: "xoxb-test", appToken: "xapp-test" } },
    };
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "msg-1", channelId: "C123" });
    const toolContext = {
      currentChannelProvider: "slack",
      currentChannelId: source,
      currentMessagingTarget: source,
      currentThreadTs: "1712345678.123456",
      currentMessageId: "1712345688.654321",
      replyToMode: "all" as const,
    };
    const params: Record<string, unknown> = { target, message: "Still checking." };
    const reply = resolveAndApplyOutboundReplyToId(params, {
      channel: "slack",
      toolContext,
      matchesToolContextTarget: slackPlugin.threading?.matchesToolContextTarget,
    });
    const threadId = resolveAndApplyOutboundThreadId(params, {
      cfg,
      to: target,
      toolContext,
      resolveAutoThreadId: slackPlugin.threading?.resolveAutoThreadId,
      resolveReplyTransport: slackPlugin.threading?.resolveReplyTransport,
      replyToIsExplicit: reply?.source === "explicit",
    });

    await sendText({
      cfg,
      to: target,
      text: "Still checking.",
      replyToId: String(params.replyTo),
      threadId,
      deps: { sendSlack },
    });

    expect(params.replyTo).toBe("1712345678.123456");
    expect(threadId).toBe("1712345678.123456");
    expect(sendSlack).toHaveBeenCalledExactlyOnceWith(
      target,
      "Still checking.",
      expect.objectContaining({ threadTs: "1712345678.123456" }),
    );
  },
);
