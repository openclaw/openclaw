import type { DiffLine } from "./tool-call-diff.ts";

/** Per-file render bound; the panel shows a truncation notice past this. */
const MAX_SESSION_DIFF_FILE_LINES = 600;

export type ParsedFilePatch = {
  lines: DiffLine[];
  truncated: boolean;
};

/**
 * Gaps between hunks become "skip" rows whose text carries the formatted
 * unmodified-line count supplied by the caller (kept out of this lib so the
 * parser stays i18n-free).
 */
export function parseSessionDiffPatch(
  patch: string,
  formatGap: (count: number) => string,
): ParsedFilePatch {
  const lines: DiffLine[] = [];
  let truncated = false;
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  // Next expected lines after the previous hunk; drive inter-hunk gap coordinates.
  let oldNext: number | undefined;
  let newNext: number | undefined;
  const rawLines = patch.replace(/\r\n/g, "\n").split("\n");
  if (rawLines.at(-1) === "") {
    rawLines.pop();
  }
  for (const raw of rawLines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      const oldStart = Number.parseInt(hunk[1] ?? "", 10);
      const newStart = Number.parseInt(hunk[2] ?? "", 10);
      const gap = oldNext === undefined ? oldStart - 1 : oldStart - oldNext;
      if (gap > 0) {
        lines.push({
          kind: "skip",
          text: formatGap(gap),
          gap: {
            oldStart: oldNext ?? oldStart - gap,
            newStart: newNext ?? newStart - gap,
            count: gap,
          },
        });
      }
      oldNo = oldStart;
      newNo = newStart;
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) {
      // Header lines before the first hunk and "\ No newline at end of file".
      continue;
    }
    if (lines.length >= MAX_SESSION_DIFF_FILE_LINES) {
      truncated = true;
      break;
    }
    const kind = raw.startsWith("+") ? "add" : raw.startsWith("-") ? "del" : "ctx";
    lines.push({ kind, lineNo: kind === "del" ? oldNo : newNo, text: raw.slice(1) });
    if (kind !== "add") {
      oldNo += 1;
    }
    if (kind !== "del") {
      newNo += 1;
    }
    oldNext = oldNo;
    newNext = newNo;
  }
  return { lines, truncated };
}
