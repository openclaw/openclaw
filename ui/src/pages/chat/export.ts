import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import {
  normalizeRoleForGrouping,
  resolveMessageRole,
  resolveMessageSenderLabel,
} from "../../lib/chat/message-normalizer.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
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
  for (const msg of history) {
    const content = extractTextCached(msg) ?? "";
    if (!content.trim()) {
      continue;
    }
    const m = msg as Record<string, unknown>;
    const role = normalizeRoleForGrouping(resolveMessageRole(msg));
    const speaker =
      role === "user"
        ? (resolveMessageSenderLabel(msg) ?? "You")
        : role === "assistant"
          ? (resolveMessageSenderLabel(msg) ?? assistantName)
          : "Tool";
    const ts = timestampMsToIsoString(m.timestamp) ?? "";
    lines.push(`## ${speaker}${ts ? ` (${ts})` : ""}`, "", content, "");
  }
  return lines.length > 0 ? [`# Chat with ${assistantName}`, "", ...lines].join("\n") : null;
}
