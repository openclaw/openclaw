/**
 * Export chat history as markdown file.
 * Shared utility to prevent code duplication between chat.ts and app.ts.
 */
export function exportChatMarkdown(messages: unknown[], assistantName: string): void {
  const history = Array.isArray(messages) ? messages : [];
  if (history.length === 0) {
    return;
  }
  const lines: string[] = [`# Chat with ${assistantName}`, ""];
  for (const msg of history) {
    const m = msg as Record<string, unknown>;
    const role = m.role === "user" ? "You" : m.role === "assistant" ? assistantName : "Tool";
    const content = typeof m.content === "string" ? m.content : "";
    const ts = typeof m.timestamp === "number" ? new Date(m.timestamp).toISOString() : "";
    lines.push(`## ${role}${ts ? ` (${ts})` : ""}`, "", content, "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `chat-${assistantName}-${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
