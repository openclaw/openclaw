// @vitest-environment node
import { describe, expect, it } from "vitest";
import { computeLineDiff, parseDiffDetailsString, type DiffLine } from "./tool-call-diff.ts";

const skip: DiffLine = { kind: "skip", text: "" };
const source = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}`);
const context = (texts: string[]): DiffLine[] => texts.map((text) => ({ kind: "ctx", text }));
type DiffResult = ReturnType<typeof computeLineDiff>;
const complete = (lines: DiffLine[], added = 0, removed = 0) =>
  ({ kind: "complete", lines, stat: { added, removed } }) satisfies DiffResult;
function expectUnchanged(texts: string[], lines = context(texts)) {
  const body = texts.join("\n");
  expect(computeLineDiff(body, body)).toEqual(complete(lines));
}
function changeAt(count: number, index: number, text: string) {
  const before = source(count),
    after = [...before];
  after[index] = text;
  return computeLineDiff(before.join("\n"), after.join("\n"));
}

describe("parseDiffDetailsString", () => {
  it.each(["   \n  ", " 1 only context\n 2 more context"])("returns null for %j", (diff) => {
    expect(parseDiffDetailsString(diff)).toBeNull();
  });

  it("truncates oversized diffs with a trailing skip line", () => {
    const diff = Array.from({ length: 450 }, (_, i) => `+${i + 1} line ${i + 1}`).join("\n");

    const lines = parseDiffDetailsString(diff);

    expect(lines).toMatchObject({ kind: "truncated", lines: { length: 402 } });
    expect(lines?.lines.at(-1)).toEqual(skip);
  });
});

describe("computeLineDiff", () => {
  it("retains complete statistics for wholly replaced bounded inputs", () => {
    const oldText = source(600, "old").join("\n");
    const newText = source(600, "new").join("\n");
    const result = computeLineDiff(oldText, newText);
    expect(result).toMatchObject({ kind: "complete", stat: { added: 600, removed: 600 } });
    expect([result.lines.length, result.lines.at(-1)]).toEqual([401, skip]);
  });

  it("reports an incomplete comparison when the only change is beyond the work budget", () => {
    expect(changeAt(700, 650, "outside budget")).toMatchObject({
      kind: "truncated",
      lines: [skip],
    });
  });

  it("returns exact zero statistics for a normal unchanged comparison", () => {
    expectUnchanged(["alpha", "beta"]);
    expectUnchanged(source(700), [...context(source(400)), skip]);
  });

  it("keeps a late change instead of spending the preview budget on context", () => {
    const { lines } = changeAt(500, 450, "changed late");
    expect(lines).toContainEqual({ kind: "add", text: "changed late" });
    expect(lines).toContainEqual({ kind: "del", text: "line 450" });
    expect(lines.length).toBeLessThanOrEqual(401);
  });
});
