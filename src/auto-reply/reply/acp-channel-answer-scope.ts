import { readConversationBindingRouteFacts } from "../../channels/conversation-binding-route-facts.js";
import type { MsgContext } from "../templating.js";

/** Compare the admitted channel origin, not the target session shared by multiple bindings. */
export function resolveAcpChannelAnswerScope(ctx: MsgContext) {
  if (!ctx.SenderId?.trim()) {
    return undefined;
  }
  const observed = readConversationBindingRouteFacts(ctx)?.conversation;
  const channel = observed?.channel ?? ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider;
  const conversation =
    observed?.conversationId ?? ctx.OriginatingTo ?? ctx.NativeChannelId ?? ctx.To;
  if (!channel || !conversation) {
    return undefined;
  }
  return JSON.stringify([
    channel,
    observed?.accountId ?? ctx.AccountId ?? "default",
    conversation,
    ctx.MessageThreadId == null ? null : String(ctx.MessageThreadId),
    ctx.SenderId,
  ]);
}
