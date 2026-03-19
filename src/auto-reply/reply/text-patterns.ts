/**
 * Matches Markdown image syntax ![alt](url) — must NOT be treated as a bash bang.
 * Pattern breakdown:
 *   ^!\[     — opening `![`
 *   [^\n]*   — alt text (single line only, no newline crossing)
 *   \]\(     — closing `](` required to distinguish from shell tests like `![ -f x ]`
 */
export function isMarkdownImage(text: string): boolean {
  return /^!\[[^\n]*\]\(/.test(text);
}
