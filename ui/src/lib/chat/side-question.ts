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

/**
 * "Ask in side chat" must never discard an unsent draft: plain prose carries
 * over as the question part. Drafts that are themselves slash commands cannot
 * be embedded in a /btw question, so they are replaced instead.
 */
export function combineSideChatComposerDraft(
  selection: string,
  existingDraft: string | undefined,
): string | null {
  const prefill = buildSideChatComposerDraft(selection);
  if (!prefill) {
    return null;
  }
  // /btw sends only the first line; collapse the carried-over prose so a
  // multiline draft is not silently truncated at send time.
  const existing = existingDraft?.replace(/\s+/g, " ").trim() ?? "";
  if (!existing || existing.startsWith("/")) {
    return prefill;
  }
  return `${prefill}${existing}`;
}

/**
 * Separates carried side-chat context from the user's follow-up question in a
 * follow-up /btw command. Builder and display extractor must agree on it.
 */
const SIDE_CHAT_FOLLOW_UP_MARKER = " Follow-up: ";

/**
 * Detached side answers never enter session history, so a follow-up /btw must
 * carry its own context: the previous side answer rides along (capped) ahead
 * of the new question.
 */
export function buildSideChatFollowUpCommand(
  previousAnswer: string | null,
  question: string,
): string | null {
  // /btw sends only the first line; collapse so multiline questions are not
  // silently truncated at send time.
  const trimmed = question.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return null;
  }
  const answer = previousAnswer ? collapseChatSelectionSnippet(previousAnswer) : "";
  if (!answer) {
    return `/btw ${trimmed}`;
  }
  return `/btw Context, your previous side answer: "${answer}"${SIDE_CHAT_FOLLOW_UP_MARKER}${trimmed}`;
}

/**
 * Human-readable question for the side-chat panel: drops the /btw prefix and
 * any carried follow-up context. lastIndexOf tolerates answers that themselves
 * contain the marker text (a question containing it truncates cosmetically).
 */
export function extractSideQuestionDisplayText(message: string): string {
  const question = message
    .trim()
    .replace(/^\/(?:btw|side)(?::\s*|\s+|$)/i, "")
    .trim();
  const markerIndex = question.lastIndexOf(SIDE_CHAT_FOLLOW_UP_MARKER);
  if (markerIndex === -1) {
    return question;
  }
  return question.slice(markerIndex + SIDE_CHAT_FOLLOW_UP_MARKER.length).trim();
}
