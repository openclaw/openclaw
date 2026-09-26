/** Encodes prepared text as literal CommonMark, including URL and HTML punctuation. */
export function escapeMarkdownText(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, "\\$&");
}
