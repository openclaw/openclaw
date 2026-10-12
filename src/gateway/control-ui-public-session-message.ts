import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isHeartbeatOkResponse, isHeartbeatUserMessage } from "../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { stripInternalMetadataForDisplay } from "../auto-reply/reply/display-text-sanitize.js";
import { stripUserEnvelopeForDisplay } from "../auto-reply/reply/user-envelope-display.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { splitMediaOutput } from "../media/parse-output.js";
import { INTER_SESSION_PROMPT_PREFIX_BASE } from "../sessions/input-provenance.js";
import { extractAssistantTranscriptSourceText } from "../shared/chat-message-content.js";
import { sanitizeAssistantVisibleTextWithProfile } from "../shared/text/assistant-visible-text.js";
import { stripSuppressedControlReplyToken } from "./control-reply-text.js";

/** Publication excludes private runtime input, including its attachments and tool activity. */
export function publicSessionMessageEntry(message: unknown): Record<string, unknown> | undefined {
  const entry = asOptionalRecord(message);
  if (
    !entry ||
    !["user", "assistant", "toolResult", "tool"].includes(String(entry.role)) ||
    entry.display === false ||
    entry.customType !== undefined ||
    entry.senderSession !== undefined
  ) {
    return undefined;
  }
  if (
    (entry.role === "user" || entry.role === "assistant") &&
    (entry.toolCallId !== undefined || entry.tool_call_id !== undefined)
  ) {
    return undefined;
  }
  const provenance = asOptionalRecord(entry.provenance);
  if (entry.provenance !== undefined && provenance?.kind !== "external_user") {
    return undefined;
  }
  const raw = rawMessageText(entry);
  if (raw?.includes(INTER_SESSION_PROMPT_PREFIX_BASE)) {
    return undefined;
  }
  const roleContent = { role: String(entry.role), content: raw ?? "" };
  if (
    raw &&
    (isHeartbeatUserMessage(roleContent, HEARTBEAT_PROMPT) || isHeartbeatOkResponse(roleContent))
  ) {
    return undefined;
  }
  return entry;
}

function rawMessageText(entry: Record<string, unknown>): string | undefined {
  let text: string | undefined;
  if (entry.role === "assistant") {
    text = extractAssistantTranscriptSourceText(entry);
  } else if (typeof entry.content === "string") {
    text = entry.content;
  } else if (Array.isArray(entry.content)) {
    text = entry.content
      .flatMap((value) => {
        const block = asOptionalRecord(value);
        return (block?.type === "text" || block?.type === "input_text") &&
          typeof block.text === "string"
          ? [block.text]
          : [];
      })
      .join("\n\n");
  } else if (typeof entry.text === "string") {
    text = entry.text;
  }
  return text;
}

export function publicSessionMessageText(entry: Record<string, unknown>): string {
  if (entry.role !== "user" && entry.role !== "assistant") {
    return "";
  }
  let text = rawMessageText(entry);
  if (!text) {
    return "";
  }
  text =
    entry.role === "user"
      ? stripUserEnvelopeForDisplay(text)
      : stripInternalMetadataForDisplay(text);
  if (entry.role === "assistant") {
    // An incomplete reasoning tag must never become public prose during live refresh.
    text = sanitizeAssistantVisibleTextWithProfile(text, "history", true);
  }
  const roleContent = { role: entry.role, content: text };
  if (isHeartbeatUserMessage(roleContent, HEARTBEAT_PROMPT) || isHeartbeatOkResponse(roleContent)) {
    return "";
  }
  if (entry.role === "assistant") {
    text = stripSuppressedControlReplyToken(text);
  }
  return redactToolPayloadText(
    splitMediaOutput(text, { extractAudioDirectives: false }).text,
  ).trim();
}
