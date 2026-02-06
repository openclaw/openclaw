import type { ChannelOutboundAdapter } from "../types.js";
import { chunkMarkdownText } from "../../../auto-reply/chunk.js";
import { resolveDingTalkAccount } from "../../../dingtalk/accounts.js";
import { parseDingTalkTarget } from "../../../dingtalk/targets.js";

export const dingtalkOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, log }) => {
    const account = resolveDingTalkAccount({ cfg, accountId });
    if (!account.config.clientId || !account.config.clientSecret) {
      throw new Error("DingTalk not configured");
    }
    const target = parseDingTalkTarget(to ?? "");
    const { sendDingTalkProactiveText } = await import("../../../dingtalk/send.js");
    await sendDingTalkProactiveText(
      account.config,
      target.type === "group"
        ? { type: "group", openConversationId: target.id }
        : { type: "user", userId: target.id },
      text,
      { log },
    );
    return { channel: "dingtalk", messageId: "unknown" };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, log }) => {
    const account = resolveDingTalkAccount({ cfg, accountId });
    if (!account.config.clientId || !account.config.clientSecret) {
      throw new Error("DingTalk not configured");
    }
    const target = parseDingTalkTarget(to ?? "");
    const payload = mediaUrl ? mediaUrl : (text ?? "");
    const { sendDingTalkProactiveText } = await import("../../../dingtalk/send.js");
    await sendDingTalkProactiveText(
      account.config,
      target.type === "group"
        ? { type: "group", openConversationId: target.id }
        : { type: "user", userId: target.id },
      payload,
      { msgType: mediaUrl ? "image" : "text", log },
    );
    return { channel: "dingtalk", messageId: "unknown" };
  },
};
