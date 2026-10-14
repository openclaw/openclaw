import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const CHAT_SELECTION_SNIPPET_MAX_CHARS = 300;

export function buildCompanionQuestionPrefill(selection: string): string | null {
  const snippet = truncateUtf16Safe(
    selection.replace(/\s+/g, " ").trim(),
    CHAT_SELECTION_SNIPPET_MAX_CHARS,
  );
  return snippet ? `Regarding "${snippet}": ` : null;
}

export function extractCompanionCommandQuestion(message: string): string {
  return message
    .trim()
    .replace(/^\/(?:btw|side)(?::\s*|\s+|$)/i, "")
    .trim();
}
