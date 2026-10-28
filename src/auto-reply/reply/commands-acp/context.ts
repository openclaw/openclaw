import { normalizeConversationTargetRef } from "../../../infra/outbound/session-binding-normalization.js";
import { stringifyRouteThreadId } from "../../../plugin-sdk/channel-route.js";
import {
  resolveConversationBindingAccountIdFromMessage,
  resolveConversationBindingChannelFromMessage,
  resolveConversationBindingContextFromAcpCommand,
} from "../conversation-binding-input.js";

export function resolveAcpCommandBindingContext(
  params: Parameters<typeof resolveConversationBindingContextFromAcpCommand>[0],
): {
  channel: string;
  accountId: string;
  threadId?: string;
  conversationId?: string;
  parentConversationId?: string;
} {
  const resolved = resolveConversationBindingContextFromAcpCommand(params);
  if (resolved) {
    // Binding lookup drops self-parent defaults that inbound routing may retain.
    return normalizeConversationTargetRef(resolved);
  }
  return {
    channel: resolveConversationBindingChannelFromMessage(params.ctx, params.command.channel),
    accountId: resolveConversationBindingAccountIdFromMessage({
      ctx: params.ctx,
      cfg: params.cfg,
      commandChannel: params.command.channel,
    }),
    threadId: stringifyRouteThreadId(params.ctx.MessageThreadId),
  };
}
