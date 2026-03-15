import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import type { CommandHandlerResult } from "../commands-types.js";
import {
  type SubagentsCommandContext,
  isDiscordSurface,
  isFeishuSurface,
  isTelegramSurface,
  resolveChannelAccountId,
  resolveCommandSurfaceChannel,
  resolveFeishuConversationId,
  resolveTelegramConversationId,
  stopWithText,
} from "./shared.js";

export async function handleSubagentsUnfocusAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params } = ctx;
  const channel = resolveCommandSurfaceChannel(params);
  if (channel !== "discord" && channel !== "telegram" && channel !== "feishu") {
    return stopWithText("⚠️ /unfocus is only available on Discord, Telegram, and Feishu.");
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
    if (isFeishuSurface(params)) {
      return resolveFeishuConversationId(params);
    }
    return undefined;
  })();

  if (!conversationId) {
    if (channel === "discord") {
      return stopWithText("⚠️ /unfocus must be run inside a Discord thread.");
    }
    if (channel === "feishu") {
      return stopWithText(
        "⚠️ /unfocus on Feishu requires a topic thread in groups, or a direct-message conversation.",
      );
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
