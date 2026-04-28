import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

export type SourceReplyDeliveryModeContext = {
  ChatType?: string;
};

export function resolveSourceReplyDeliveryMode(params: {
  cfg: OpenClawConfig;
  ctx: SourceReplyDeliveryModeContext;
  requested?: SourceReplyDeliveryMode;
}): SourceReplyDeliveryMode {
  if (params.requested) {
    return params.requested;
  }
  const chatType = normalizeChatType(params.ctx.ChatType);
  if (chatType === "group" || chatType === "channel") {
    return params.cfg.messages?.groupChat?.visibleReplies === "automatic"
      ? "automatic"
      : "message_tool_only";
  }
  return "automatic";
}
