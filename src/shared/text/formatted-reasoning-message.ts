import { stripReasoningTagsFromText } from "./reasoning-tags.js";

export function stripFormattedReasoningMessage(
  text: string,
  onRetainedBody?: (tagStripped: string, start: number, end: number) => void,
): string {
  const stripped = stripReasoningTagsFromText(text, { trim: "none" });
  // Removed tags may leave blank lines before a preamble; untouched text keeps its boundary.
  const preamble = stripped === text ? stripped : stripped.trimStart();
  const firstNewline = preamble.indexOf("\n");
  const prefix = (firstNewline === -1 ? preamble : preamble.slice(0, firstNewline)).trim();
  const thinking = /^Thinking\.{0,3}$/u.test(prefix);
  if (prefix !== "Reasoning:" && !thinking) {
    return preamble ? stripped : "";
  }

  let offset = firstNewline === -1 ? preamble.length : firstNewline + 1;
  let hasSummary = false;
  while (offset < preamble.length) {
    const newline = preamble.indexOf("\n", offset);
    const end = newline === -1 ? preamble.length : newline;
    const line = preamble.slice(offset, end).trim();
    const isSummary = line.length >= 2 && line.startsWith("_") && line.endsWith("_");
    if (line && !isSummary) {
      break;
    }
    hasSummary ||= isSummary;
    offset = newline === -1 ? end : newline + 1;
  }
  // Thinking needs an italic summary. Normalize CRLF and remove trailing newlines
  // only after a preamble; preserve the remaining body indentation.
  if (thinking && !hasSummary) {
    return stripped;
  }
  let end = preamble.length;
  while (end > offset && preamble[end - 1] === "\n") {
    end -= preamble[end - 2] === "\r" ? 2 : 1;
  }
  const preambleStart = stripped.length - preamble.length;
  onRetainedBody?.(stripped, preambleStart + offset, preambleStart + end);
  return preamble.slice(offset, end).replace(/\r\n/g, "\n");
}
