import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { t } from "../../i18n/index.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import {
  isStandaloneToolMessageForDisplay,
  normalizeRoleForGrouping,
} from "../../lib/chat/message-normalizer.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import { pluginInlineViewItems } from "../../lib/chat/plugin-inline-views.ts";
import { resolveMessageSenderLabel } from "../../lib/chat/sender-label.ts";
import { downloadTextFile } from "../../lib/download.ts";

export type ChatExportResult = "downloaded" | "empty";

export function exportChatMarkdown(messages: unknown[], assistantName: string): ChatExportResult {
  const markdown = buildChatMarkdown(messages, assistantName);
  if (!markdown) {
    return "empty";
  }
  downloadTextFile(`chat-${assistantName}-${Date.now()}.md`, markdown, "text/markdown");
  return "downloaded";
}

export function buildChatMarkdown(messages: unknown[], assistantName: string): string | null {
  const history = visibleChatHistoryMessages(messages);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [index, msg] of history.entries()) {
    const m = msg as Record<string, unknown>;
    // The export is the readable conversation: user and assistant turns only.
    // Tool calls, tool results, and system traffic are activity, not turns.
    const role = normalizeRoleForGrouping(typeof m.role === "string" ? m.role : "unknown");
    if ((role !== "user" && role !== "assistant") || isStandaloneToolMessageForDisplay(msg)) {
      continue;
    }
    const text = extractTextCached(msg) ?? "";
    const views = pluginInlineViewItems(
      { kind: "message", key: "export:" + index, message: msg },
      seen,
    );
    const summaries = views
      .map((view) => extractTextCached(view.message) ?? "")
      .filter((summary) => summary !== text.trim());
    const content = summaries.length ? [text, ...summaries].filter(Boolean).join("\n\n") : text;
    if (!content.trim()) {
      continue;
    }
    const speaker =
      role === "user"
        ? (resolveMessageSenderLabel(msg) ?? t("chat.messages.unattributedSender"))
        : (resolveMessageSenderLabel(msg) ?? assistantName);
    const ts = timestampMsToIsoString(m.timestamp) ?? "";
    lines.push(`## ${speaker}${ts ? ` (${ts})` : ""}`, "", content, "");
  }
  return lines.length > 0 ? [`# Chat with ${assistantName}`, "", ...lines].join("\n") : null;
}
