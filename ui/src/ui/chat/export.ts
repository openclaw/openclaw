import { extractTextCached } from "./message-extract.ts";

function escapeMarkdownHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function replaceControlChars(value: string): string {
  let next = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    next += code < 0x20 || code === 0x7f ? " " : char;
  }
  return next;
}

export function sanitizeFilenameComponent(value: string): string {
  const sanitized = replaceControlChars(value)
    .replace(/^[./\\]+/g, "")
    .replace(/<\//g, "-")
    .replace(/[<>]/g, "")
    .replace(/[\\/:*?"|]/g, " ")
    .replace(/[^\w\s-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || "chat";
}

export function buildChatExportFilename(assistantName: string, timestamp = Date.now()): string {
  return `chat-${sanitizeFilenameComponent(assistantName)}-${timestamp}.md`;
}

/**
 * Export chat history as markdown file.
 */
export function exportChatMarkdown(messages: unknown[], assistantName: string): void {
  const markdown = buildChatMarkdown(messages, assistantName);
  if (!markdown) {
    return;
  }
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = buildChatExportFilename(assistantName);
  link.click();
  URL.revokeObjectURL(url);
}

export function buildChatMarkdown(messages: unknown[], assistantName: string): string | null {
  const history = Array.isArray(messages) ? messages : [];
  if (history.length === 0) {
    return null;
  }
  const safeAssistantName = escapeMarkdownHtml(assistantName);
  const lines: string[] = [`# Chat with ${safeAssistantName}`, ""];
  for (const msg of history) {
    const m = msg as Record<string, unknown>;
    const role = m.role === "user" ? "You" : m.role === "assistant" ? safeAssistantName : "Tool";
    const content = escapeMarkdownHtml(extractTextCached(msg) ?? "");
    const ts = typeof m.timestamp === "number" ? new Date(m.timestamp).toISOString() : "";
    lines.push(`## ${role}${ts ? ` (${ts})` : ""}`, "", content, "");
  }
  return lines.join("\n");
}
