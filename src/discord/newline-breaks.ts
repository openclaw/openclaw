/**
 * Discord renders single `\n` as a soft break (space) in bot messages,
 * making multi-line replies unreadable. Convert isolated single newlines
 * to paragraph breaks (`\n\n`) so Discord renders them as hard breaks.
 *
 * Fenced code blocks are preserved: newlines inside ``` ... ``` are left
 * untouched because Discord renders them literally.
 */

const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g;

/**
 * Replace every isolated single `\n` with `\n\n` outside of fenced code
 * blocks.  Runs of two-or-more newlines are left as-is.
 */
export function convertNewlinesForDiscord(text: string): string {
  if (!text) {
    return text;
  }

  // Split the text into alternating segments: [non-code, code, non-code, ...]
  // We only transform non-code segments.
  const parts: string[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(FENCED_CODE_BLOCK_RE)) {
    const start = match.index;
    // Push the text before this code block (to be transformed).
    parts.push(convertSingleNewlines(text.slice(lastIndex, start)));
    // Push the code block verbatim.
    parts.push(match[0]);
    lastIndex = start + match[0].length;
  }

  // Push any remaining text after the last code block.
  parts.push(convertSingleNewlines(text.slice(lastIndex)));

  return parts.join("");
}

/**
 * Replace isolated single newlines with double newlines.
 * `(?<!\n)\n(?!\n)` matches a `\n` that is not preceded or followed by
 * another `\n`, i.e. a truly single newline.
 */
function convertSingleNewlines(segment: string): string {
  return segment.replace(/(?<!\n)\n(?!\n)/g, "\n\n");
}
