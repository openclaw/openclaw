// Generated settings show one sentence; the rest of a schema's help text stays on demand.

const ABBREVIATION = /(?:\b(?:e\.g|i\.e|etc|vs|cf|approx|incl|min|max|sec|no)|\.\w)\.$/i;
const DEFAULT_NOTE = /\s*\((?:default|defaults to)\b[^()]*\)/gi;
// Conservative: a sentence that might clip in its one line also gets the on-demand surface.
const ONE_LINE_CHARS = { beside: 50, full: 80 };

const plainWords = (text: string) => text.replace(/\([^()]*\)|[^\p{L}\p{N}]/gu, "").toLowerCase();

function firstSentenceEnd(text: string): number {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      quoted = !quoted;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    }
    if (depth > 0 || quoted) {
      continue;
    }
    const next = text[index + 1];
    if ((char === "." || char === "!" || char === "?") && (next === undefined || next === " ")) {
      if (char === "." && ABBREVIATION.test(text.slice(0, index + 1))) {
        continue;
      }
      return index + 1;
    }
    // "Controls provider catalog behavior: "merge" keeps built-ins ..." opens a list of values.
    if ((char === ":" || char === ";") && next === " " && index >= 16) {
      return index;
    }
  }
  return text.length;
}

export function summarizeConfigHelp(
  help: string | undefined,
  /** "beside" shares the row with the control column; "full" has the row to itself. */
  width: keyof typeof ONE_LINE_CHARS = "full",
  /** A sentence that only restates this adds nothing to the row. */
  label?: string,
): {
  summary: string;
  /** The row hides words, so the full text needs its on-demand surface. */
  clipped: boolean;
} {
  const text = (help ?? "").trim().replace(/\s+/g, " ");
  if (!text) {
    return { summary: "", clipped: false };
  }
  const end = firstSentenceEnd(text);
  const sentence = text.slice(0, end).trim();
  const summary = sentence.replace(DEFAULT_NOTE, "");
  // "Primary model (provider/model)." still has its format to offer on demand.
  if (label && plainWords(summary) === plainWords(label)) {
    return { summary: "", clipped: sentence !== text || summary.includes("(") };
  }
  return {
    summary,
    clipped: sentence !== text || summary !== sentence || summary.length > ONE_LINE_CHARS[width],
  };
}
