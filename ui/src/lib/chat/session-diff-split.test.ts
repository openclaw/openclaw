import { expect, it } from "vitest";
import {
  createDiffPairingBudget,
  diffLineChangeRanges,
  pairSessionDiffLines,
  type SessionSplitDiffRow,
} from "./session-diff-split.ts";
import type { DiffLine } from "./tool-call-diff.ts";

const replacements = (before: string[], after: string[]) =>
  [before, after].flatMap((texts, side) =>
    texts.map((text, i): DiffLine => ({ kind: side ? "add" : "del", lineNo: i + 1, text })),
  );

function expectPreserved(rows: SessionSplitDiffRow[], lines: DiffLine[]) {
  const pairs = rows.filter((row) => row.kind === "pair");
  expect([pairs.flatMap((row) => row.left ?? []), pairs.flatMap((row) => row.right ?? [])]).toEqual(
    [lines.filter((line) => line.kind === "del"), lines.filter((line) => line.kind === "add")],
  );
}

const numbered = (length: number, prefix: string) =>
  Array.from({ length }, (_, i) => `${prefix} ${i}`);

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

it.each([false, true])("aligns replacements beside unmatched changes (reverse=%s)", (reverse) => {
  const oldText = ["const retries = 2;", "const timeout = 3000;"];
  const newText = ["audit", "const retries = 3;", "const timeout = 5000;"];
  const lines = replacements(reverse ? newText : oldText, reverse ? oldText : newText);
  const rows = pairSessionDiffLines(lines);
  expect(
    rows.map((row) => (row.kind === "pair" ? [row.left?.text, row.right?.text] : null)),
  ).toEqual(
    reverse
      ? [[newText[0], undefined], ...oldText.map((text, i) => [newText[i + 1], text])]
      : [[undefined, newText[0]], ...oldText.map((text, i) => [text, newText[i + 1]])],
  );
});

it("bounds long-line comparison work without losing fallback inline highlights", () => {
  const oldText = Array.from({ length: 64 }, (_, i) => `const value${i} = "${"a".repeat(680)}";`);
  const newText = oldText.map((line) => line.replace("value", "updated"));
  const lines = replacements(oldText, newText);
  const budget = createDiffPairingBudget();
  const before = budget.remaining;
  const rows = pairSessionDiffLines(lines, budget);
  expect(budget.remaining).toBe(before);
  const expected = oldText.map((_, i) => ({ kind: "pair", left: lines[i], right: lines[64 + i] }));
  expect(rows).toEqual(expected);
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
  const paired = rows.filter((row) => row.kind === "pair" && row.left && row.right);
  expect(paired.length).toBeGreaterThan(0);
  expect(budget.remaining).toBeGreaterThanOrEqual(0);
  expectPreserved(rows, hunks);
  expect(pairSessionDiffLines(block(), budget)).toHaveLength(16);
  expect(pairSessionDiffLines(block(), createDiffPairingBudget())).toHaveLength(32);
});

it.each([
  { before: ["first = 1", "second = 2"], after: ["second = 3", "first = 4"] },
  { before: ["removed", ""], after: [] },
  { before: numbered(80, "value"), after: numbered(90, "other") },
])("preserves source order through pairing and fallbacks", ({ before, after }) => {
  const lines = replacements(before, after);
  expectPreserved(pairSessionDiffLines(lines), lines);
});

it.each([
  ["const retries = 2;", "const retries = 3;", ["2"], ["3"]],
  ['const label = "Working";', 'const label = "Running";', ["Working"], ["Running"]],
  ["return { owner, label };", "return { owner, label, auditLabel };", [], [", auditLabel"]],
  ["  const café = '😀';", "\tconst café = '🚀';", ["  ", "😀"], ["\t", "🚀"]],
  ["  ", "\t", ["  "], ["\t"]],
  ["same", "same", [], []],
])("marks words, punctuation, whitespace and Unicode: %s", (before, after, removed, added) => {
  const lines = replacements([before], [after]);
  const ranges = diffLineChangeRanges(pairSessionDiffLines(lines));
  expect(
    lines.map((line) => (ranges.get(line) ?? []).map(({ from, to }) => line.text.slice(from, to))),
  ).toEqual([removed, added]);
});

it.each([
  ["abc", "XYZ", false],
  ["x".repeat(10000), "y".repeat(10000), true],
  ["a;".repeat(500), ";a".repeat(500), true],
])("keeps unrelated or over-budget changes whole-line: %s", (before, after, paired) => {
  const lines = replacements([before], [after]);
  const rows = pairSessionDiffLines(lines);
  if (!paired) {
    expect(rows).toEqual(lines.map((line, i) => ({ kind: "pair", [i ? "right" : "left"]: line })));
  }
  expectPreserved(rows, lines);
  expect(diffLineChangeRanges(rows).size).toBe(0);
});
