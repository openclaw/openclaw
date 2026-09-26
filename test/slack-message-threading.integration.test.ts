// Root integration owns the shared threading helpers plus the public Slack adapter.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../extensions/slack/api.js";
import {
  resolveAndApplyOutboundReplyToId,
  resolveAndApplyOutboundThreadId,
} from "../src/infra/outbound/message-action-threading.js";

describe("Slack message-tool thread inheritance", () => {
  it("keeps an ordinary message-tool update in the incoming Slack thread", async () => {
    const cfg = {
      channels: { slack: { botToken: "xoxb-test" } },
    } satisfies OpenClawConfig;
    const sendMessageSlackMock = vi.fn(async () => ({ messageId: "msg-1", channelId: "C123" }));
    const sendText = slackPlugin.outbound?.sendText;
    if (!sendText) {
      throw new Error("slack outbound.sendText unavailable");
    }
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

    await sendText({
      cfg,
      to: "channel:C123",
      text: "Still checking.",
      replyToId: String(params.replyTo),
      threadId,
      deps: { slack: sendMessageSlackMock },
    });

    expect(params.replyTo).toBe("1712345678.123456");
    expect(threadId).toBe("1712345678.123456");
    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "channel:C123",
      "Still checking.",
      expect.objectContaining({ threadTs: "1712345678.123456" }),
    );
  });
});
