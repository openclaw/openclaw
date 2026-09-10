import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { SessionCatalogTranscriptItem } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { clampText } from "../../lib/format.ts";
import {
  CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS,
  catalogRawResult,
  catalogRawString,
} from "./chat-pane-shared.ts";

export function catalogItemMessage(
  item: SessionCatalogTranscriptItem,
): Record<string, unknown> | null {
  const timestamp = parseDateStringTimestampMs(item.timestamp) ?? null;
  const text = item.text?.trim() ? item.text : null;
  if (item.type === "userMessage") {
    return text
      ? {
          role: "user",
          // Missing source attribution must never fall back to the current viewer.
          senderLabel: item.sender?.label ?? t("sessionsView.user"),
          ...(item.sender
            ? {
                __openclaw: {
                  senderIdentity: item.sender.identity,
                  senderId: item.sender.identity.id,
                  senderName: item.sender.label,
                  senderProfileAvatarUrl: item.sender.avatarUrl,
                },
              }
            : {}),
          content: text,
          ...(timestamp == null ? {} : { timestamp }),
          messageId: item.id,
        }
      : null;
  }
  let content = text;
  let truncated = item.truncated;
  if (item.type === "reasoning") {
    content = text ? `Thinking\n\n${text}` : "Thinking";
  } else if (item.type === "toolCall") {
    const label = text ?? catalogRawString(item.raw, ["command", "name", "tool", "title", "query"]);
    content = label ? `Tool call\n\n${label}` : "Tool call";
  } else if (item.type === "toolResult") {
    const output =
      text ?? catalogRawString(item.raw, ["aggregatedOutput"]) ?? catalogRawResult(item.raw);
    // Native text and raw fallbacks share the same display limit; source data stays intact.
    const preview = output ? clampText(output, CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS) : null;
    truncated ||= Boolean(output && preview !== output);
    content = preview ? `Tool result\n\n${preview}` : "Tool result";
  }
  if (!content) {
    return null;
  }
  if (truncated) {
    content = `${content}\n\n${t("chat.catalogOutputTruncated")}`;
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    ...(timestamp == null ? {} : { timestamp }),
    messageId: item.id,
  };
}
