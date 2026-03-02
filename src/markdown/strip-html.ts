/**
 * Converts common HTML tags to their plain-text equivalents and strips
 * remaining tags. Designed for plain-text messaging surfaces like
 * WhatsApp, Signal, and IRC where HTML is not rendered.
 */
export function stripHtmlForPlainText(text: string): string {
  return (
    text
      // Line breaks → newline
      .replace(/<br\s*\/?>/gi, "\n")
      // Bold
      .replace(/<\/?(b|strong)>/gi, () => {
        // Don't emit WhatsApp markers here — let the downstream
        // markdownToWhatsApp / markdownToSignal handle bold style.
        return "";
      })
      // Italic
      .replace(/<\/?(i|em)>/gi, "")
      // Strikethrough
      .replace(/<\/?(s|strike|del)>/gi, "")
      // Paragraph breaks
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<\/?p[^>]*>/gi, "\n")
      // Block-level elements that should produce line breaks
      .replace(/<\/?(div|h[1-6]|li|tr)[^>]*>/gi, "\n")
      // Horizontal rules
      .replace(/<hr\s*\/?>/gi, "\n---\n")
      // Strip all remaining HTML tags
      .replace(/<[^>]+>/g, "")
      // Decode common HTML entities
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      // Collapse excessive newlines
      .replace(/\n{3,}/g, "\n\n")
  );
}
