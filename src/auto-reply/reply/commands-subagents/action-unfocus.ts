import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import type { CommandHandlerResult } from "../commands-types.js";
import {
  type SubagentsCommandContext,
  isDiscordSurface,
  isMatrixSurface,
  isTelegramSurface,
  resolveChannelAccountId,
  resolveCommandSurfaceChannel,
  resolveMatrixConversationId,
  resolveMatrixParentConversationId,
  resolveTelegramConversationId,
  stopWithText,
} from "./shared.js";

export async function handleSubagentsUnfocusAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params } = ctx;
  const channel = resolveCommandSurfaceChannel(params);
  if (channel !== "discord" && channel !== "telegram" && channel !== "matrix") {
    return stopWithText("⚠️ /unfocus is only available on Discord, Matrix, and Telegram.");
  }

  const accountId = resolveChannelAccountId(params);
  const bindingService = getSessionBindingService();

  const conversationId = (() => {
    if (isDiscordSurface(params)) {
      const threadId = params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId) : "";
      return threadId.trim() || undefined;
    }
    if (isMatrixSurface(params)) {
      return resolveMatrixConversationId({
        ctx: {
          MessageThreadId: params.ctx.MessageThreadId,
          OriginatingTo: params.ctx.OriginatingTo,
          To: params.ctx.To,
        },
        command: {
          to: params.command.to,
        },
      });
    }
    if (isTelegramSurface(params)) {
      return resolveTelegramConversationId(params);
    }
    return undefined;
  })();
  const parentConversationId = isMatrixSurface(params)
    ? resolveMatrixParentConversationId({
        ctx: {
          MessageThreadId: params.ctx.MessageThreadId,
          OriginatingTo: params.ctx.OriginatingTo,
          To: params.ctx.To,
        },
        command: {
          to: params.command.to,
        },
      })
    : undefined;

  if (!conversationId) {
    if (channel === "discord") {
      return stopWithText("⚠️ /unfocus must be run inside a Discord thread.");
    }
    if (channel === "matrix") {
      return stopWithText("⚠️ /unfocus must be run inside a focused Matrix thread.");
    }
    return stopWithText(
      "⚠️ /unfocus on Telegram requires a topic context in groups, or a direct-message conversation.",
    );
  }

  const binding = bindingService.resolveByConversation({
    channel,
    accountId,
    conversationId,
    ...(parentConversationId ? { parentConversationId } : {}),
  });
  if (!binding) {
    return stopWithText(
      channel === "discord"
        ? "ℹ️ This thread is not currently focused."
        : channel === "matrix"
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
        : channel === "matrix"
          ? `⚠️ Only ${boundBy} can unfocus this thread.`
          : `⚠️ Only ${boundBy} can unfocus this conversation.`,
    );
  }

  await bindingService.unbind({
    bindingId: binding.bindingId,
    reason: "manual",
  });
  return stopWithText(
    channel === "discord" || channel === "matrix"
      ? "✅ Thread unfocused."
      : "✅ Conversation unfocused.",
  );
}
