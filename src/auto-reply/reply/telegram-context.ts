import { parseExplicitTargetForChannel } from "../../channels/plugins/target-parsing.js";

type TelegramConversationParams = {
  ctx: {
    MessageThreadId?: string | number | null;
    OriginatingTo?: string;
    To?: string;
  };
  command: {
    to?: string;
  };
};

export function resolveTelegramConversationId(
  params: TelegramConversationParams,
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
    .map((candidate) => parseExplicitTargetForChannel("telegram", candidate)?.to.trim() ?? "")
    .find((candidate) => candidate.length > 0);
  if (!chatId) {
    return undefined;
  }
  if (threadId) {
    return `${chatId}:topic:${threadId}`;
  }
  // Non-topic groups should not become globally focused conversations.
  if (chatId.startsWith("-")) {
    return undefined;
  }
  return chatId;
}
