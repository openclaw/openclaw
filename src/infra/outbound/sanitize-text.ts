/**
 * Sanitize model output for plain-text messaging surfaces.
 *
 * LLMs occasionally produce HTML tags (`<br>`, `<b>`, `<i>`, etc.) that render
 * correctly on web but appear as literal text on WhatsApp, Signal, SMS, and IRC.
 *
 * Converts common inline HTML to lightweight-markup equivalents used by
 * WhatsApp/Signal/Telegram and strips any remaining tags.
 *
 * @see https://github.com/openclaw/openclaw/issues/31884
 * @see https://github.com/openclaw/openclaw/issues/18558
 */

/** Channels where HTML tags should be converted/stripped. */
const PLAIN_TEXT_SURFACES = new Set([
  "whatsapp",
  "signal",
  "sms",
  "irc",
  "telegram",
  "imessage",
  "googlechat",
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
 */
export function sanitizeForPlainText(text: string): string {
  const hadLeakage =
    /<\/?(?:longcat_think|longcat_tool_call|x)>/i.test(text) ||
    /<\|eot_id\|>/i.test(text) ||
    /^\s*:?\[\[\s*reply_to_current\s*\]/im.test(text) ||
    /^\s*\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{/im.test(text);

  const sanitized = text
    // Strip leaked LongCat/internal wrapper tags and stop markers.
    .replace(/<\/?(?:longcat_think|longcat_tool_call|x)>/gi, "")
    .replace(/<\|eot_id\|>/gi, "")
    // Drop malformed leaked reply tags before the normal directive parser can see them.
    .replace(/^\s*:?\[\[\s*reply_to_current\s*\](?:\s*)/i, "")
    // Drop raw tool-call JSON lines that leaked into plain text.
    .replace(/^\s*\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{.*$/gim, "")
    .replace(/^\s*<\/(?:longcat_tool_call|function)>\s*$/gim, "")
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
    .replace(/<li[^>]*>(.*?)<\/li>/gi, "• $1\n")
    // Strip remaining HTML tags (require tag-like structure: <word...>)
    .replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, "")
    // Collapse blank lines created by stripped leaked wrappers/tool-call blocks.
    .replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n")
    // Collapse 3+ consecutive newlines into 2
    .replace(/\n{3,}/g, "\n\n");

  return hadLeakage ? sanitized.replace(/\n{2,}/g, "\n").replace(/^\n+|\n+$/g, "") : sanitized;
}
