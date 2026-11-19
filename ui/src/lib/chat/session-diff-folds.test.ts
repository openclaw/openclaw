import { describe, expect, it } from "vitest";
import { analyzeDiffSyntax } from "../../pages/chat/components/chat-diff-highlight.runtime.ts";
import { projectDiffCodeFolds } from "./session-diff-folds.ts";
import { pairSessionDiffLines } from "./session-diff-split.ts";
import { parseSessionDiffPatch } from "./session-diff.ts";
import type { DiffLine } from "./tool-call-diff.ts";

async function analyze(lines: DiffLine[], path = "example.ts") {
  const result = await analyzeDiffSyntax(lines, path);
  return { ...result, projected: projectDiffCodeFolds(pairSessionDiffLines(lines), result.folds) };
}
const context = (source: string): DiffLine[] =>
  source.split("\n").map((text, index) => ({ kind: "ctx", text, lineNo: index + 1 }));

describe("syntax-aware diff folding", () => {
  it("projects complete nested functions and blocks, preserving source and hidden change counts", async () => {
    const lines = parseSessionDiffPatch(
      "@@ -1,5 +1,6 @@\n function greet() {\n   if (true) {\n-    return 2;\n+    const name = '<img src=x>';\n+    return 3;\n   }\n }",
      String,
    ).lines;
    const result = await analyze(lines);
    expect(
      result.projected.map(({ from, to, function: fn, added, removed }) => ({
        from,
        to,
        fn,
        added,
        removed,
      })),
    ).toEqual([
      { from: 0, to: 5, fn: true, added: 2, removed: 1 },
      { from: 1, to: 4, fn: false, added: 2, removed: 1 },
    ]);
    for (const line of lines) {
      expect(
        result.highlighted
          .get(line)
          ?.map((token) => token.text)
          .join(""),
      ).toBe(line.text);
    }
  });
  it.each(["add", "del"] as const)("folds a complete %s-only block", async (kind) => {
    const result = await analyze(
      context("function only() {\n  return 2;\n}").map((line) => ({
        text: line.text,
        lineNo: line.lineNo,
        kind,
      })),
    );
    expect(result.projected).toHaveLength(1);
    expect(result.projected[0]).toMatchObject({ from: 0, to: 2, function: true });
  });
  it("uses language-supported Python and CSS blocks", async () => {
    expect(
      (await analyze(context("def hello():\n    print('hello')\n    return 2"), "example.py"))
        .projected,
    ).toHaveLength(1);
    expect(
      (await analyze(context(".hello {\n  color: red;\n}"), "example.css")).projected,
    ).toHaveLength(1);
  });
  it("folds Python bodies ending at a following statement's dedent", async () => {
    const result = await analyze(
      context("def hello():\n    if True:\n        return 1\n    return 2\nprint(hello())"),
      "example.py",
    );
    expect(result.projected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 0, to: 3, function: true }),
        expect.objectContaining({ from: 1, to: 2, function: false }),
      ]),
    );
    const classes = await analyze(
      context("class Greeter:\n    def hello(self):\n        return 1\nprint(Greeter())"),
      "example.py",
    );
    expect(classes.projected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 0, to: 2, function: true }),
        expect.objectContaining({ from: 1, to: 2, function: true }),
      ]),
    );
  });
  it("folds a complete function across a fully revealed retained context marker", async () => {
    const source = context("function revealed() {\n  const value = 1;\n  return value;\n}");
    const marker: DiffLine = {
      kind: "skip",
      text: "2 unmodified lines",
      gap: { oldStart: 2, newStart: 2, count: 2 },
    };
    const lines = [source[0]!, marker, ...source.slice(1)];
    const result = await analyze(lines);
    expect(result.projected).toMatchObject([{ from: 0, to: 4, function: true }]);
    for (const line of source) {
      expect(
        result.highlighted
          .get(line)
          ?.map((token) => token.text)
          .join(""),
      ).toBe(line.text);
    }
    expect(result.highlighted.has(marker)).toBe(false);
    for (const revealed of [
      [source[1]!, source[3]!],
      [source[2]!, source[1]!, source[3]!],
    ]) {
      expect((await analyze([source[0]!, marker, ...revealed])).projected).toEqual([]);
    }
  });
  it("keeps incomplete, gapped, unsupported and over-budget source expanded", async () => {
    const incomplete = context("function nope() {\n  return 2;");
    expect((await analyze(incomplete)).projected).toEqual([]);
    expect(
      (await analyze(context("function sibling() {\n  return 2;\n} doOtherWork();"))).projected,
    ).toEqual([]);
    expect(
      (await analyze([...incomplete, { kind: "skip", text: "unknown" }, ...context("}")]))
        .projected,
    ).toEqual([]);
    expect(
      (await analyze(context("function nope() {\n  return 2;\n}"), "unknown.xyz")).projected,
    ).toEqual([]);
    const result = await analyze(context("function huge() {\n//" + "x".repeat(120_000) + "\n}"));
    expect(result.projected).toEqual([]);
    expect(result.highlighted.size).toBe(0);
  });
});
