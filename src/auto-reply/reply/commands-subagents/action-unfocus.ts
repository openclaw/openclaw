import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import type { CommandHandlerResult } from "../commands-types.js";
import {
  type SubagentsCommandContext,
  isTelegramSurface,
  resolveChannelAccountId,
  resolveTelegramConversationId,
  stopWithText,
} from "./shared.js";
import { resolveCommandSurfaceChannel } from "../channel-context.js";

export async function handleSubagentsUnfocusAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params } = ctx;
  const channel = resolveCommandSurfaceChannel(params);
  if (channel !== "telegram") {
    return stopWithText("⚠️ /unfocus is only available on Telegram.");
  }

  const accountId = resolveChannelAccountId(params);
  const bindingService = getSessionBindingService();

  const conversationId = (() => {
    if (isTelegramSurface(params)) {
      return resolveTelegramConversationId(params);
    }
    return undefined;
  })();

  if (!conversationId) {
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
    return stopWithText("ℹ️ This conversation is not currently focused.");
  }

  const senderId = params.command.senderId?.trim() || "";
  const boundBy =
    typeof binding.metadata?.boundBy === "string" ? binding.metadata.boundBy.trim() : "";
  if (boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
    return stopWithText(`⚠️ Only ${boundBy} can unfocus this conversation.`);
  }

  await bindingService.unbind({
    bindingId: binding.bindingId,
    reason: "manual",
  });
  return stopWithText("✅ Conversation unfocused.");
}
