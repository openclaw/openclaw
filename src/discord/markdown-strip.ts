import { parseFenceSpans } from "../markdown/fences.js";

// Matches lines that are markdown horizontal rules: three or more
// `-`, `*`, or `_` characters (with optional spaces between them)
// on a line by themselves. Discord renders these as literal text
// instead of horizontal rules, so we strip them.
const HR_RE = /^[ \t]*([-*_][ \t]*){3,}$/;

const HR_REPLACEMENT = "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯";

/**
 * Replace markdown horizontal rule lines with a unicode horizontal bar.
 * Only replaces rules that are outside fenced code blocks.
 */
export function stripHorizontalRules(text: string): string {
  if (!text) {
    return text;
  }

  const fenceSpans = parseFenceSpans(text);
  const lines = text.split("\n");
  const out: string[] = [];
  let offset = 0;

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;

    // Skip lines inside fenced code blocks.
    const insideFence = fenceSpans.some((s) => lineStart >= s.start && lineStart < s.end);
    if (insideFence) {
      out.push(line);
      continue;
    }

    if (HR_RE.test(line)) {
      out.push(HR_REPLACEMENT);
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}
