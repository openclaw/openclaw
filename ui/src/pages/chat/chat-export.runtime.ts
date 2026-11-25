import { t } from "../../i18n/index.ts";
import { loadCompleteChatHistory } from "../../lib/chat/complete-history.ts";
import { exportChatMarkdown, isChatMarkdownTurn, type ChatExportResult } from "./export.ts";

export async function exportCapturedChat(
  target: Parameters<typeof loadCompleteChatHistory>[0],
  assistantName: string,
): Promise<ChatExportResult> {
  const messages = await loadCompleteChatHistory(target, isChatMarkdownTurn);
  if (!target.isCurrent()) {
    throw new Error(t("sessionsView.copyTranscriptChanged"));
  }
  return exportChatMarkdown(messages, assistantName);
}
