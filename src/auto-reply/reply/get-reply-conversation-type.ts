import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";

export function resolveReplyPolicyConversationType(
  ctx: Pick<
    MsgContext,
    "ChatType" | "CommandSource" | "CommandTargetSessionKey" | "CommandTurn" | "SessionKey"
  >,
  inboundSessionKey?: string,
): "direct" | "group" | undefined {
  const sourceSessionKey = inboundSessionKey ?? ctx.SessionKey;
  const targetSessionKey = resolveCommandTurnTargetSessionKey(ctx);
  if (targetSessionKey && targetSessionKey !== sourceSessionKey) {
    return undefined;
  }
  const chatType = normalizeChatType(ctx.ChatType);
  return chatType === "channel" ? "group" : chatType;
}
