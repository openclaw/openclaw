import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { unwrapToolCallForDisplay } from "../agents/tool-display-call.js";
import { isToolCallContentType, resolveToolBlockArgs } from "../chat/tool-content.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { collectPublicSessionAttachments } from "./control-ui-public-session-attachments.js";
import {
  publicSessionMessageEntry,
  publicSessionMessageText,
} from "./control-ui-public-session-message.js";

export type PublicSessionItem =
  | {
      kind: "message";
      role: "user" | "assistant";
      text: string;
      message: unknown;
      sourceIndex: number;
    }
  | { kind: "tools"; calls: { name: string; summary: string }[]; sourceIndex: number };

function toolSummary(args: unknown): string {
  const record = asOptionalRecord(args);
  // Publish a useful argument only, never the entire tool payload or result body.
  const selected = record
    ? ["command", "cmd", "path", "file_path", "query", "q", "url"]
        .map((key) => record[key])
        .find((value) => typeof value === "string")
    : typeof args === "string"
      ? args
      : undefined;
  return typeof selected === "string"
    ? truncateUtf16Safe(redactToolPayloadText(selected).replace(/\s+/gu, " ").trim(), 160)
    : "";
}

/** Same visible-content boundary as chat: narration separates adjacent tool activity. */
export function projectPublicSessionItems(messages: unknown[]): PublicSessionItem[] {
  const items: PublicSessionItem[] = [];
  for (const [sourceIndex, message] of messages.entries()) {
    const entry = publicSessionMessageEntry(message);
    if (!entry) {
      continue;
    }
    const text = publicSessionMessageText(entry);
    const attachments = collectPublicSessionAttachments(entry);
    if (text || attachments.length > 0) {
      items.push({
        kind: "message",
        role: entry.role === "user" ? "user" : "assistant",
        text,
        message,
        sourceIndex,
      });
    }
    if (entry.role !== "assistant" || !Array.isArray(entry.content)) {
      continue;
    }
    for (const value of entry.content) {
      const block = asOptionalRecord(value);
      if (!block || !isToolCallContentType(block.type)) {
        continue;
      }
      const call = unwrapToolCallForDisplay({
        name: typeof block.name === "string" ? block.name : "tool",
        args: resolveToolBlockArgs(block),
      });
      const name = truncateUtf16Safe(redactToolPayloadText(call.name), 80);
      const summary = toolSummary(call.args);
      const previous = items.at(-1);
      if (previous?.kind === "tools") {
        previous.calls.push({ name, summary });
      } else {
        items.push({ kind: "tools", calls: [{ name, summary }], sourceIndex });
      }
    }
  }
  return items;
}
