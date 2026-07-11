// Plain-text sanitization strips internal runtime scaffolding and converts a
// conservative subset of model-produced HTML into channel-friendly text.
import { stripInternalRuntimeScaffolding } from "./protocol-scaffolding.js";

// Retained for the deprecated plugin-sdk/infra-runtime compatibility barrel.
export { stripInternalRuntimeScaffolding };

const HTML_TAG_RE = /<\/?[a-z][a-z0-9_-]*\b[^>]*>/gi;

function stripRemainingHtmlTags(text: string): string {
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(HTML_TAG_RE, "");
  } while (current !== previous);
  return current;
}

/**
 * Convert common HTML tags to their plain-text/lightweight-markup equivalents
 * and strip anything that remains.
 *
 * The function is intentionally conservative — it only targets tags that models
 * are known to produce and avoids false positives on angle brackets in normal
 * prose (e.g. `a < b`).
 */
export function sanitizeForPlainText(text: string): string {
  const converted = stripInternalRuntimeScaffolding(text)
    // Preserve angle-bracket autolinks as plain URLs before tag stripping.
    .replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/gi, "$1")
    // Line breaks
    .replace(/<br\s*\/?>/gi, "\n")
    // Block elements → newlines
    .replace(/<\/?(p|div)>/gi, "\n")
    // Bold → WhatsApp/Signal bold
    .replace(/<(b|strong)>(.*?)<\/\1>/gi, "*$2*")
    // Italic → WhatsApp/Signal italic
    .replace(/<(i|em)>(.*?)<\/\1>/gi, "_$2_")
    // Strikethrough → WhatsApp/Signal strikethrough
    .replace(/<(s|strike|del)>(.*?)<\/\1>/gi, "~$2~")
    // Inline code
    .replace(/<code>(.*?)<\/code>/gi, "`$1`")
    // Headings → bold text with newline
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n*$1*\n")
    // List items → bullet points
    .replace(/<li[^>]*>(.*?)<\/li>/gi, "• $1\n");

  return stripRemainingHtmlTags(converted).replace(/\n{3,}/g, "\n\n");
}
