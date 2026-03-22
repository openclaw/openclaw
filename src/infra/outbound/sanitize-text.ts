/**
 * Sanitize model output for plain-text messaging surfaces.
 *
 * LLMs occasionally produce HTML tags (`<br>`, `<b>`, `<i>`, etc.) that render
 * correctly on web but appear as literal text on some channels.
 *
 * Converts common inline HTML to lightweight-markup equivalents used by
 * Telegram and strips any remaining tags.
 *
 * @see https://github.com/openclaw/openclaw/issues/31884
 * @see https://github.com/openclaw/openclaw/issues/18558
 */

/** Channels where HTML tags should be converted/stripped. */
const PLAIN_TEXT_SURFACES = new Set([
  "telegram",
]);

/** Returns `true` when the channel cannot render raw HTML. */
export function isPlainTextSurface(channelId: string): boolean {
  return PLAIN_TEXT_SURFACES.has(channelId.toLowerCase());
}

/**
 * Convert common HTML tags to their plain-text/lightweight-markup equivalents
 * and strip anything that remains.
 *
 * The function is intentionally conservative — it only targets tags that models
 * are known to produce and avoids false positives on angle brackets in normal
 * prose (e.g. `a < b`).
 *
 * Markdown markup conventions used:
 * - Bold: `*text*`
 * - Italic: `_text_`
 * - Strikethrough: `~text~`
 * - Inline code: `` `text` ``
 */
export function sanitizeForPlainText(text: string): string {
  return (
    text
      // Preserve angle-bracket autolinks as plain URLs before tag stripping.
      .replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/gi, "$1")
      // Line breaks
      .replace(/<br\s*\/?>/gi, "\n")
      // Block elements → newlines
      .replace(/<\/?(p|div)>/gi, "\n")
      // Bold → markdown bold
      .replace(/<(b|strong)>(.*?)<\/\1>/gi, "*$2*")
      // Italic → markdown italic
      .replace(/<(i|em)>(.*?)<\/\1>/gi, "_$2_")
      // Strikethrough → markdown strikethrough
      .replace(/<(s|strike|del)>(.*?)<\/\1>/gi, "~$2~")
      // Inline code
      .replace(/<code>(.*?)<\/code>/gi, "`$1`")
      // Headings → bold text with newline
      .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n*$1*\n")
      // List items → bullet points
      .replace(/<li[^>]*>(.*?)<\/li>/gi, "• $1\n")
      // Strip remaining HTML tags (require tag-like structure: <word...>)
      .replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, "")
      // Collapse 3+ consecutive newlines into 2
      .replace(/\n{3,}/g, "\n\n")
  );
}
