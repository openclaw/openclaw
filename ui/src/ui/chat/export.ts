/**
 * Export chat history as markdown file.
 */
export function escapeHtmlInMarkdown(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function normalizeSingleLineLabel(label: string, fallback = "Assistant"): string {
  const normalized = label.replace(/[\r\n\t]+/g, " ").trim();
  return normalized || fallback;
}

export function sanitizeFilenameComponent(input: string): string {
  const normalized = normalizeSingleLineLabel(input, "assistant").normalize("NFKC");
  const sanitized = normalized
    .replace(/[\\/]/g, "-")
    .replace(/[^a-zA-Z0-9 _.-]/g, "")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim()
    .replace(/^[.-]+/, "")
    .slice(0, 50);
  return sanitized || "assistant";
}

export function buildChatMarkdown(messages: unknown[], assistantNameRaw: string): string | null {
  const assistantName = escapeHtmlInMarkdown(normalizeSingleLineLabel(assistantNameRaw));
  const history = Array.isArray(messages) ? messages : [];
  if (history.length === 0) {
    return null;
  }
  const lines: string[] = [`# Chat with ${assistantName}`, ""];
  for (const msg of history) {
    const m = msg as Record<string, unknown>;
    const role = m.role === "user" ? "You" : m.role === "assistant" ? assistantName : "Tool";
    const content = escapeHtmlInMarkdown(
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as Array<{ type?: string; text?: string }>)
              .filter((b) => b?.type === "text" && typeof b.text === "string")
              .map((b) => b.text)
              .join("")
          : "",
    );
    const ts = typeof m.timestamp === "number" ? new Date(m.timestamp).toISOString() : "";
    lines.push(`## ${role}${ts ? ` (${ts})` : ""}`, "", content, "");
  }
  return lines.join("\n");
}

export function buildChatExportFilename(assistantNameRaw: string, now = Date.now()): string {
  return `chat-${sanitizeFilenameComponent(assistantNameRaw)}-${now}.md`;
}

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
