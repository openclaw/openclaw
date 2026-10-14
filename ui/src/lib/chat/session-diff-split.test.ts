import { describe, expect, it } from "vitest";
import { diffLineChangeRanges, pairSessionDiffLines } from "./session-diff-split.ts";
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
