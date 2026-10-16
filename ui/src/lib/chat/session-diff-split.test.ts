import { describe, expect, it } from "vitest";
import {
  createDiffPairingBudget,
  diffLineChangeRanges,
  pairSessionDiffLines,
} from "./session-diff-split.ts";
import type { DiffLine } from "./tool-call-diff.ts";

function replacements(oldText: string[], newText: string[]): DiffLine[] {
  return [
    ...oldText.map((text, index): DiffLine => ({ kind: "del", lineNo: index + 1, text })),
    ...newText.map((text, index): DiffLine => ({ kind: "add", lineNo: index + 1, text })),
  ];
}

function changedText(lines: DiffLine[]) {
  const ranges = diffLineChangeRanges(pairSessionDiffLines(lines));
  return lines.map((line) =>
    (ranges.get(line) ?? []).map((range) => line.text.slice(range.from, range.to)),
  );
}

describe("pairSessionDiffLines", () => {
  it("spans context, gaps and file separators without pairing across them", () => {
    const lines: DiffLine[] = [
      { kind: "ctx", lineNo: 3, text: "before" },
      { kind: "del", lineNo: 4, text: "const first = 1;" },
      { kind: "del", lineNo: 5, text: "const second = 2;" },
      { kind: "add", lineNo: 4, text: "const first = 3;" },
      { kind: "skip", text: "8 unmodified lines" },
      { kind: "file", text: "next.ts", path: "next.ts" },
      { kind: "add", lineNo: 1, text: "new file" },
    ];
    expect(pairSessionDiffLines(lines)).toEqual([
      { kind: "span", line: lines[0] },
      { kind: "pair", left: lines[1], right: lines[3] },
      { kind: "pair", left: lines[2] },
      { kind: "span", line: lines[4] },
      { kind: "span", line: lines[5] },
      { kind: "pair", right: lines[6] },
    ]);
  });

  it.each([false, true])(
    "leaves an unmatched inserted/deleted line beside its corresponding replacements (reverse=%s)",
    (reverse) => {
      const oldText = ["const retries = 2;", "const timeout = 3000;", 'const label = "Working";'];
      const newText = [
        'const auditLabel = "session:" + owner;',
        "const retries = 3;",
        "const timeout = 5000;",
        'const label = "Running";',
      ];
      const lines = replacements(reverse ? newText : oldText, reverse ? oldText : newText);
      const rows = pairSessionDiffLines(lines);
      expect(
        rows.map((row) => (row.kind === "pair" ? [row.left?.text, row.right?.text] : null)),
      ).toEqual(
        reverse
          ? [[newText[0], undefined], ...oldText.map((text, i) => [newText[i + 1], text])]
          : [[undefined, newText[0]], ...oldText.map((text, i) => [text, newText[i + 1]])],
      );
    },
  );

  it("bounds long-line comparison work without losing fallback inline highlights", () => {
    const oldText = Array.from(
      { length: 64 },
      (_, i) => "const value" + i + ' = "' + "a".repeat(680) + '";',
    );
    const newText = oldText.map((line) => line.replace("value", "updated"));
    const lines = replacements(oldText, newText);
    const budget = createDiffPairingBudget();
    const before = budget.remaining;
    const rows = pairSessionDiffLines(lines, budget);
    expect(budget.remaining).toBe(before);
    expect(rows).toEqual(
      oldText.map((_, i) => ({ kind: "pair", left: lines[i], right: lines[64 + i] })),
    );
    expect(diffLineChangeRanges(rows).get(lines[64]!)).toEqual([{ from: 6, to: 14 }]);
  });

  it("shares comparison work across hunks and files, not just matrix dimensions", () => {
    const block = () =>
      replacements(Array(16).fill("a".repeat(160)), Array(16).fill("b".repeat(160)));
    const budget = createDiffPairingBudget();
    expect(pairSessionDiffLines(block(), budget)).toHaveLength(32);
    const hunks = Array.from({ length: 8 }, (_, i) => [
      { kind: "skip" as const, text: String(i) },
      ...block(),
    ]).flat();
    const rows = pairSessionDiffLines(hunks, budget);
    // Later hunks fall back to positional pairs after earlier files use the budget.
    expect(
      rows.filter((row) => row.kind === "pair" && row.left && row.right).length,
    ).toBeGreaterThan(0);
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
    expect(rows.flatMap((row) => (row.kind === "pair" && row.left ? [row.left] : []))).toEqual(
      hunks.filter((line) => line.kind === "del"),
    );
    expect(rows.flatMap((row) => (row.kind === "pair" && row.right ? [row.right] : []))).toEqual(
      hunks.filter((line) => line.kind === "add"),
    );
    expect(pairSessionDiffLines(block(), budget)).toHaveLength(16);
    expect(pairSessionDiffLines(block(), createDiffPairingBudget())).toHaveLength(32);
  });

  it("does not present unrelated replacements as an inline edit", () => {
    const lines = replacements(["abc"], ["XYZ"]);
    const rows = pairSessionDiffLines(lines);
    expect(rows).toEqual([
      { kind: "pair", left: lines[0] },
      { kind: "pair", right: lines[1] },
    ]);
    expect(diffLineChangeRanges(rows).size).toBe(0);
  });

  it.each([
    [
      ["first = 1", "second = 2"],
      ["second = 3", "first = 4"],
    ],
    [[], ["added", ""]],
    [["removed", ""], []],
    [
      Array.from({ length: 80 }, (_, i) => "value " + i),
      Array.from({ length: 90 }, (_, i) => "other " + i),
    ],
    [["x".repeat(10000)], ["y".repeat(10000)]],
  ])(
    "preserves every source line and its order, including bounded fallbacks",
    (oldText, newText) => {
      const lines = replacements(oldText, newText);
      const rows = pairSessionDiffLines(lines);
      expect(rows.flatMap((row) => (row.kind === "pair" && row.left ? [row.left] : []))).toEqual(
        lines.filter((line) => line.kind === "del"),
      );
      expect(rows.flatMap((row) => (row.kind === "pair" && row.right ? [row.right] : []))).toEqual(
        lines.filter((line) => line.kind === "add"),
      );
    },
  );
});

describe("diffLineChangeRanges", () => {
  it.each([
    ["const retries = 2;", "const retries = 3;", ["2"], ["3"]],
    ['const label = "Working";', 'const label = "Running";', ["Working"], ["Running"]],
    ["return { owner, label };", "return { owner, label, auditLabel };", [], [", auditLabel"]],
    ["  const café = '😀';", "\tconst café = '🚀';", ["  ", "😀"], ["\t", "🚀"]],
    ["call(a);", "call(a, b);", [], [", b"]],
    ["  ", "\t", ["  "], ["\t"]],
    ["same", "same", [], []],
  ])(
    "marks edited words, punctuation and whitespace without splitting Unicode: %s",
    (before, after, removed, added) => {
      expect(changedText(replacements([before], [after]))).toEqual([removed, added]);
    },
  );

  it("leaves minified and token-dense lines readable without expensive inline matching", () => {
    for (const [before, after] of [
      ["x".repeat(10000), "y".repeat(10000)],
      ["a;".repeat(500), ";a".repeat(500)],
    ]) {
      const lines = replacements([before!], [after!]);
      expect(diffLineChangeRanges(pairSessionDiffLines(lines)).size).toBe(0);
    }
  });
});
