import type { SessionSplitDiffRow } from "./session-diff-split.ts";
import type { DiffLine } from "./tool-call-diff.ts";

/** Complete syntax ranges within one known, contiguous source side. */
export type DiffSyntaxFold = {
  start: DiffLine;
  end: DiffLine;
  side: "old" | "new";
  function: boolean;
};
export type DiffCodeFold = {
  key: DiffLine;
  from: number;
  to: number;
  function: boolean;
  count: number;
  added: number;
  removed: number;
};

/** Index once: projecting nested syntax nodes must not scan the diff per node. */
export function projectDiffCodeFolds(
  rows: readonly SessionSplitDiffRow[],
  syntax: readonly DiffSyntaxFold[],
) {
  const indices = new Map<DiffLine, number>();
  const old = [0],
    next = [0],
    additions = [0],
    deletions = [0];
  rows.forEach((row, index) => {
    const left = row.kind === "pair" ? row.left : row.line;
    const right = row.kind === "pair" ? row.right : row.line;
    if (left) {
      indices.set(left, index);
    }
    if (right) {
      indices.set(right, index);
    }
    old.push(old[index]! + Number(Boolean(left)));
    next.push(next[index]! + Number(Boolean(right)));
    additions.push(additions[index]! + Number(right?.kind === "add"));
    deletions.push(deletions[index]! + Number(left?.kind === "del"));
  });
  const candidates = new Map<string, { fold: DiffCodeFold; sides: number }>();
  for (const range of syntax) {
    const from = indices.get(range.start),
      to = indices.get(range.end);
    if (from === undefined || to === undefined || to <= from) {
      continue;
    }
    const id = from + ":" + to;
    const existing = candidates.get(id);
    const side = range.side === "old" ? 1 : 2;
    if (existing) {
      existing.sides |= side;
      existing.fold.function ||= range.function;
    } else {
      const row = rows[from]!;
      candidates.set(id, {
        sides: side,
        fold: {
          key: row.kind === "span" ? row.line : (row.right ?? row.left)!,
          from,
          to,
          function: range.function,
          count: to - from,
          added: additions[to + 1]! - additions[from + 1]!,
          removed: deletions[to + 1]! - deletions[from + 1]!,
        },
      });
    }
  }
  const folds = [...candidates.values()]
    .filter(
      ({ fold, sides }) =>
        sides === 3 ||
        (sides === 1 ? next : old)[fold.to + 1] === (sides === 1 ? next : old)[fold.from + 1],
    )
    .map(({ fold }) => fold)
    .toSorted((a, b) => a.from - b.from || b.to - a.to);
  // Crossing ranges cannot hide both sides safely. Nested ranges remain independent.
  const result: DiffCodeFold[] = [],
    stack: DiffCodeFold[] = [];
  for (const fold of folds) {
    while (stack.length && stack.at(-1)!.to < fold.from) {
      stack.pop();
    }
    if (stack.length && (fold.to > stack.at(-1)!.to || fold.from === stack.at(-1)!.from)) {
      continue;
    }
    result.push(fold);
    stack.push(fold);
  }
  return result;
}
