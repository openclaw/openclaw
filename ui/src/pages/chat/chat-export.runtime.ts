import { t } from "../../i18n/index.ts";
import { loadCompleteChatHistory } from "../../lib/chat/complete-history.ts";
import { exportChatMarkdown, type ChatExportResult } from "./export.ts";

export async function exportCapturedChat(
  target: Parameters<typeof loadCompleteChatHistory>[0] & { isCurrent: () => boolean },
  assistantName: string,
): Promise<ChatExportResult> {
  const messages = await loadCompleteChatHistory(target);
  if (!target.isCurrent()) {
    throw new Error(t("sessionsView.copyTranscriptChanged"));
  }
  return exportChatMarkdown(messages, assistantName);
}
