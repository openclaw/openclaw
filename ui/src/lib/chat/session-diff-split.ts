import type { DiffLine } from "./tool-call-diff.ts";

export type SessionSplitDiffRow =
  | { kind: "pair"; left?: DiffLine; right?: DiffLine }
  | { kind: "span"; line: DiffLine };

export type DiffChangeRange = { from: number; to: number };

// Presentation is optional: oversized runs retain positional pairing, and long
// or token-dense lines retain their whole-line color without inline decoration.
const MAX_PAIR_CELLS = 4096;
const MAX_LINE_CHARS = 2048;
const MAX_INLINE_CELLS = 65536;
const INLINE_CELL_BUDGET = 262144;

function bigrams(text: string): Map<string, number> {
  const chars = Array.from(text.trim().replace(/\s+/gu, " "));
  const counts = new Map<string, number>();
  for (let i = 0; i < chars.length; i++) {
    const pair = chars[i]! + (chars[i + 1] ?? "");
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

function alignChanges(deletions: DiffLine[], additions: DiffLine[]): SessionSplitDiffRow[] {
  const rows: SessionSplitDiffRow[] = [];
  if (
    deletions.length * additions.length > MAX_PAIR_CELLS ||
    [...deletions, ...additions].some((line) => line.text.length > MAX_LINE_CHARS)
  ) {
    for (let i = 0; i < Math.max(deletions.length, additions.length); i++) {
      rows.push({ kind: "pair", left: deletions[i], right: additions[i] });
    }
    return rows;
  }
  const oldGrams = deletions.map((line) => bigrams(line.text));
  const newGrams = additions.map((line) => bigrams(line.text));
  const weights = (grams: Map<string, number>) => [...grams.values()].reduce((a, b) => a + b, 0);
  const oldSizes = oldGrams.map(weights);
  const newSizes = newGrams.map(weights);
  const stride = additions.length + 1;
  const scores = new Float64Array((deletions.length + 1) * stride);
  const matches = new Float64Array(scores.length);
  for (let i = deletions.length - 1; i >= 0; i--) {
    for (let j = additions.length - 1; j >= 0; j--) {
      let shared = 0;
      for (const [gram, count] of oldGrams[i]!) {
        shared += Math.min(count, newGrams[j]!.get(gram) ?? 0);
      }
      const size = oldSizes[i]! + newSizes[j]!;
      // Weak similarities should not consume a better match later in the run.
      const similarity = size ? (2 * shared) / size : 1;
      const weight = similarity >= 0.5 ? similarity : 0;
      const offset = i * stride + j;
      matches[offset] = weight;
      scores[offset] = Math.max(
        scores[offset + stride]!,
        scores[offset + 1]!,
        weight ? weight + scores[offset + stride + 1]! : 0,
      );
    }
  }
  let i = 0;
  let j = 0;
  while (i < deletions.length || j < additions.length) {
    const offset = i * stride + j;
    if (
      i < deletions.length &&
      j < additions.length &&
      matches[offset]! > 0 &&
      scores[offset] === matches[offset]! + scores[offset + stride + 1]!
    ) {
      rows.push({ kind: "pair", left: deletions[i++], right: additions[j++] });
    } else if (
      i < deletions.length &&
      (j === additions.length || scores[offset + stride]! >= scores[offset + 1]!)
    ) {
      rows.push({ kind: "pair", left: deletions[i++] });
    } else {
      rows.push({ kind: "pair", right: additions[j++] });
    }
  }
  return rows;
}

/** Align adjacent changes by similarity without reordering either source side. */
export function pairSessionDiffLines(lines: readonly DiffLine[]): SessionSplitDiffRow[] {
  const rows: SessionSplitDiffRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.kind !== "add" && line.kind !== "del") {
      rows.push({ kind: "span", line });
      index++;
      continue;
    }
    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (index < lines.length) {
      const changed = lines[index]!;
      if (changed.kind === "del") {
        deletions.push(changed);
      } else if (changed.kind === "add") {
        additions.push(changed);
      } else {
        break;
      }
      index++;
    }
    rows.push(...alignChanges(deletions, additions));
  }
  return rows;
}

function appendRange(ranges: DiffChangeRange[], from: number, to: number) {
  const previous = ranges.at(-1);
  if (previous?.to === from) {
    previous.to = to;
  } else {
    ranges.push({ from, to });
  }
}

/** Inline ranges use source offsets, independently of optional syntax tokens. */
export function diffLineChangeRanges(rows: readonly SessionSplitDiffRow[]) {
  const changes = new Map<DiffLine, DiffChangeRange[]>();
  let budget = INLINE_CELL_BUDGET;
  for (const row of rows) {
    if (row.kind !== "pair" || !row.left || !row.right) {
      continue;
    }
    const left = row.left;
    const right = row.right;
    if (left.text.length > MAX_LINE_CHARS || right.text.length > MAX_LINE_CHARS) {
      continue;
    }
    const tokenize = (text: string) =>
      text.match(/\s+|[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu) ?? [];
    const oldParts = tokenize(left.text);
    const newParts = tokenize(right.text);
    let prefix = 0;
    while (prefix < oldParts.length && oldParts[prefix] === newParts[prefix]) {
      prefix++;
    }
    let oldEnd = oldParts.length;
    let newEnd = newParts.length;
    while (oldEnd > prefix && newEnd > prefix && oldParts[oldEnd - 1] === newParts[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    const oldTokens = oldParts.slice(prefix, oldEnd);
    const newTokens = newParts.slice(prefix, newEnd);
    const cells = (oldTokens.length + 1) * (newTokens.length + 1);
    if (cells > MAX_INLINE_CELLS || cells > budget) {
      continue;
    }
    budget -= cells;
    const stride = newTokens.length + 1;
    const lcs = new Uint16Array(cells);
    for (let i = oldTokens.length - 1; i >= 0; i--) {
      for (let j = newTokens.length - 1; j >= 0; j--) {
        const offset = i * stride + j;
        lcs[offset] =
          oldTokens[i] === newTokens[j]
            ? lcs[offset + stride + 1]! + 1
            : Math.max(lcs[offset + stride]!, lcs[offset + 1]!);
      }
    }
    const oldRanges: DiffChangeRange[] = [];
    const newRanges: DiffChangeRange[] = [];
    let oldOffset = oldParts.slice(0, prefix).join("").length;
    let newOffset = oldOffset;
    for (let i = 0, j = 0; i < oldTokens.length || j < newTokens.length;) {
      const oldToken = oldTokens[i];
      const newToken = newTokens[j];
      if (oldToken !== undefined && oldToken === newToken) {
        oldOffset += oldToken.length;
        newOffset += newToken!.length;
        i++;
        j++;
      } else if (
        oldToken !== undefined &&
        (newToken === undefined || lcs[(i + 1) * stride + j]! >= lcs[i * stride + j + 1]!)
      ) {
        appendRange(oldRanges, oldOffset, oldOffset + oldToken.length);
        oldOffset += oldToken.length;
        i++;
      } else if (newToken !== undefined) {
        appendRange(newRanges, newOffset, newOffset + newToken.length);
        newOffset += newToken.length;
        j++;
      }
    }
    if (oldRanges.length) {
      changes.set(left, oldRanges);
    }
    if (newRanges.length) {
      changes.set(right, newRanges);
    }
  }
  return changes;
}
