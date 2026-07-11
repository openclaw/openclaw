// Builders for selection-driven /btw side questions (chat selection popup).
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** Cap quoted selection snippets so the /btw command stays bounded. */
export const CHAT_SELECTION_SNIPPET_MAX_CHARS = 600;

/**
 * /btw questions are single-line: command normalization keeps only the first
 * line, so newlines in the quoted selection must collapse to spaces before
 * the snippet is embedded in the command text.
 */
export function collapseChatSelectionSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return truncateUtf16Safe(collapsed, CHAT_SELECTION_SNIPPET_MAX_CHARS);
}

/** Implicit "More details" prompt sent immediately as a /btw side question. */
export function buildMoreDetailsSideCommand(selection: string): string | null {
  const snippet = collapseChatSelectionSnippet(selection);
  if (!snippet) {
    return null;
  }
  return `/btw Explain "${snippet}" from this conversation in more detail.`;
}

/** Composer draft for "Ask in side chat": user types the question after the quote. */
export function buildSideChatComposerDraft(selection: string): string | null {
  const snippet = collapseChatSelectionSnippet(selection);
  if (!snippet) {
    return null;
  }
  return `/btw Regarding "${snippet}": `;
}

/** Human-readable question for the pending side-result card (drops the /btw prefix). */
export function extractSideQuestionDisplayText(message: string): string {
  return message
    .trim()
    .replace(/^\/(?:btw|side)(?::\s*|\s+|$)/i, "")
    .trim();
}
