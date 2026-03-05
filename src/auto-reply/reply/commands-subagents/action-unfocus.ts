import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { parseTelegramTarget } from "../../../telegram/targets.js";
import type { CommandHandlerResult } from "../commands-types.js";
import {
  type SubagentsCommandContext,
  isDiscordSurface,
  isTelegramSurface,
  resolveChannelAccountId,
  resolveCommandSurfaceChannel,
  stopWithText,
} from "./shared.js";

function resolveTelegramConversationId(
  params: SubagentsCommandContext["params"],
): string | undefined {
  const rawThreadId =
    params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
  const threadId = rawThreadId || undefined;
  const toCandidates = [
    typeof params.ctx.OriginatingTo === "string" ? params.ctx.OriginatingTo : "",
    typeof params.command.to === "string" ? params.command.to : "",
    typeof params.ctx.To === "string" ? params.ctx.To : "",
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  const chatId = toCandidates
    .map((candidate) => parseTelegramTarget(candidate).chatId.trim())
    .find((candidate) => candidate.length > 0);
  if (!chatId) {
    return undefined;
  }
  if (threadId) {
    return `${chatId}:topic:${threadId}`;
  }
  if (chatId.startsWith("-")) {
    return undefined;
  }
  return chatId;
}

export async function handleSubagentsUnfocusAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params } = ctx;
  const channel = resolveCommandSurfaceChannel(params);
  if (channel !== "discord" && channel !== "telegram") {
    return stopWithText("⚠️ /unfocus is only available on Discord and Telegram.");
  }

  const accountId = resolveChannelAccountId(params);
  const bindingService = getSessionBindingService();

  const conversationId = (() => {
    if (isDiscordSurface(params)) {
      const threadId = params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId) : "";
      return threadId.trim() || undefined;
    }
    if (isTelegramSurface(params)) {
      return resolveTelegramConversationId(params);
    }
    return undefined;
  })();

  if (!conversationId) {
    if (channel === "discord") {
      return stopWithText("⚠️ /unfocus must be run inside a Discord thread.");
    }
    return stopWithText(
      "⚠️ /unfocus on Telegram requires a topic context in groups, or a direct-message conversation.",
    );
  }

  const binding = bindingService.resolveByConversation({
    channel,
    accountId,
    conversationId,
  });
  if (!binding) {
    return stopWithText(
      channel === "discord"
        ? "ℹ️ This thread is not currently focused."
        : "ℹ️ This conversation is not currently focused.",
    );
  }

  const senderId = params.command.senderId?.trim() || "";
  const boundBy =
    typeof binding.metadata?.boundBy === "string" ? binding.metadata.boundBy.trim() : "";
  if (boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
    return stopWithText(
      channel === "discord"
        ? `⚠️ Only ${boundBy} can unfocus this thread.`
        : `⚠️ Only ${boundBy} can unfocus this conversation.`,
    );
  }

  await bindingService.unbind({
    bindingId: binding.bindingId,
    reason: "manual",
  });
  return stopWithText(
    channel === "discord" ? "✅ Thread unfocused." : "✅ Conversation unfocused.",
  );
}
