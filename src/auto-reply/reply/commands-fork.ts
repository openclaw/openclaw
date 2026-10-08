import { resolveCommandConversationResolution } from "../../channels/conversation-resolution.js";
import { conversationIdentityFromMsgContext } from "../../config/sessions/conversation-identity.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { createNativeConversationForkHost } from "./commands-fork-host.js";
import type { CommandHandler } from "./commands-types.js";

/** An owner-only built-in command; plugin command registrations cannot replace this route. */
export const handleForkCommand: CommandHandler = async (params, allowTextCommands) => {
  if (
    !allowTextCommands ||
    !/^\/(?:fork|split)(?:\s|$)/i.test(params.command.commandBodyNormalized)
  ) {
    return null;
  }
  const reply = (text: string) => ({ shouldContinue: false, reply: { text } });
  if (!params.command.isAuthorizedSender || !params.command.senderIsOwner) {
    return reply("/fork requires an authorized owner.");
  }
  if (!params.command.assertOwnerCurrent) {
    return reply("/fork unavailable: live owner authority is required.");
  }
  try {
    params.command.assertOwnerCurrent?.();
    const conversation = resolveCommandConversationResolution({
      cfg: params.cfg,
      channel: params.command.channel,
      accountId: params.ctx.AccountId,
      from: params.ctx.From,
      originatingTo: params.ctx.OriginatingTo,
      commandTo: params.ctx.To,
      fallbackTo: params.ctx.To ?? params.ctx.From,
      threadId: params.ctx.MessageThreadId,
      threadParentId: params.ctx.ThreadParentId,
      chatType: params.ctx.ChatType,
    });
    if (!conversation || !params.sessionKey) {
      return reply("/fork unavailable: this conversation has no safe route.");
    }
    const arg = params.command.commandBodyNormalized.replace(/^\/(?:fork|split)\b/i, "").trim();
    const incomingReplyToId = params.ctx.ReplyToIdFull ?? params.ctx.ReplyToId ?? undefined;
    // Telegram forum messages can inherit the topic-creation service message
    // as their reply target even when the sender did not reply to a user turn.
    const topicRootReply =
      conversation.channel === "telegram" &&
      params.ctx.IsForum === true &&
      incomingReplyToId !== undefined &&
      params.ctx.MessageThreadId !== undefined &&
      incomingReplyToId === String(params.ctx.MessageThreadId);
    const replyToId = arg === "--back" || topicRootReply ? undefined : incomingReplyToId;
    const replyIdentity = replyToId
      ? conversationIdentityFromMsgContext({ ctx: params.ctx })
      : undefined;
    const replyConversationRef = replyIdentity?.conversationRef;
    if (
      replyToId &&
      (!replyIdentity ||
        replyIdentity.channel !== conversation.channel ||
        replyIdentity.accountId !== conversation.accountId)
    ) {
      return reply("/fork cannot verify this reply belongs to the current conversation.");
    }
    const host = createNativeConversationForkHost({
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      conversation: {
        channel: conversation.channel,
        accountId: conversation.accountId,
        conversationId: conversation.conversationId,
        ...(conversation.parentConversationId
          ? { parentConversationId: conversation.parentConversationId }
          : {}),
      },
      replyToId,
      replyConversationRef,
      signal: params.opts?.abortSignal ?? new AbortController().signal,
      assertOwnerCurrent: params.command.assertOwnerCurrent,
      operatorAuthority:
        params.opts?.operatorAuthority ?? getCommandOwnerAuthority(params.ctx)?.operatorAuthority,
    });
    if (arg === "--back") {
      const result = await host.back();
      return reply(
        result.status === "returned"
          ? result.mode === "navigate"
            ? `Previous conversation: ${String(result.destinationUrl ?? result.conversationId)} (open it to return).`
            : "Restored the previous session in this conversation."
          : result.status === "conflict"
            ? "Cannot return: the conversation binding changed."
            : "No previous fork binding to return to.",
      );
    }
    if (arg.startsWith("--")) {
      return reply("Usage: /fork [title] | /fork --back");
    }
    const prepared = await host.prepare(arg ? { title: arg } : undefined);
    if (prepared.status !== "ready") {
      return reply(
        prepared.status === "pending"
          ? "A fork is already in progress."
          : "/fork unavailable: " + prepared.reason,
      );
    }
    // Telegram can create an audience-preserving forum child. Discord's
    // current child adapter can create a public sibling of a private source
    // and cannot create one for DMs, so keep Discord forks in their source.
    const canPlaceChild =
      conversation.channel === "discord"
        ? false
        : conversation.channel !== "telegram" ||
          (params.ctx.IsForum === true &&
            /^-[0-9]+(?::topic:[0-9]+)?$/u.test(
              conversation.parentConversationId ?? conversation.conversationId,
            ));
    if (!canPlaceChild && !prepared.current) {
      return reply("/fork unavailable: this chat cannot host a child or current binding.");
    }
    const placement = prepared.child && canPlaceChild ? "child" : "current";
    let result = await host.execute({ ticket: prepared.ticket, placement });
    if (
      placement === "child" &&
      result.status === "not_placed" &&
      result.effect === "session_only" &&
      result.reason === "unsupported" &&
      prepared.current
    ) {
      result = await host.execute({ ticket: prepared.ticket, placement: "current" });
      if (result.status === "placed") {
        return reply(
          "Forked in this conversation (child placement unavailable). Use /fork --back to return.",
        );
      }
    }
    if (result.status === "placed") {
      const destination =
        typeof result.destinationUrl === "string"
          ? result.destinationUrl
          : typeof result.conversationId === "string"
            ? result.conversationId
            : "the new conversation";
      const replayNote =
        result.replay === "ambiguous"
          ? " Reply replay outcome is unconfirmed; do not retry blindly."
          : "";
      return reply(
        placement === "child"
          ? `Forked into ${destination}. Continue there; use /fork --back to return.${replayNote}`
          : `Forked in this conversation. Use /fork --back to return.${replayNote}`,
      );
    }
    if (result.status === "not_placed" && result.effect === "session_only") {
      return reply(
        "Fork session created, but routing was unavailable; no conversation was moved. Do not retry blindly. Child: " +
          (typeof result.forkSessionKey === "string" ? result.forkSessionKey : "unknown"),
      );
    }
    if (result.status === "ambiguous") {
      return reply(
        "Fork placement outcome is unconfirmed; do not retry blindly. Child: " +
          (typeof result.forkSessionKey === "string" ? result.forkSessionKey : "unknown"),
      );
    }
    return reply(
      "/fork did not complete: " +
        (typeof result.reason === "string" ? result.reason : result.status) +
        (typeof result.forkSessionKey === "string" ? `. Child: ${result.forkSessionKey}` : ""),
    );
  } catch {
    return reply("/fork blocked: unable to verify or complete this fork.");
  }
};
