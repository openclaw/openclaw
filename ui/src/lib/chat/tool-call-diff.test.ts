// @vitest-environment node
// Control UI tests cover inline diff parsing and computation for tool-call rows.
import { describe, expect, it } from "vitest";
import {
  buildWriteDiffLines,
  computeLineDiff,
  joinDiffSections,
  parseDiffDetailsString,
  type DiffLine,
} from "./tool-call-diff.ts";

describe("parseDiffDetailsString", () => {
  it("parses numbered add/del/ctx lines and skip markers", () => {
    const diff = [" 455 before", "-456 old line", "+456 new line", "    ...", " 460 after"].join(
      "\n",
    );

    expect(parseDiffDetailsString(diff)).toEqual({
      kind: "complete",
      lines: [
        { kind: "ctx", lineNo: 455, text: "before" },
        { kind: "del", lineNo: 456, text: "old line" },
        { kind: "add", lineNo: 456, text: "new line" },
        { kind: "skip", text: "" },
        { kind: "ctx", lineNo: 460, text: "after" },
      ],
      stat: { added: 1, removed: 1 },
    });
  });

  it.each([
    ["whitespace-only input", "   \n  "],
    ["no added or removed lines", " 1 only context\n 2 more context"],
  ])("returns null for %s", (_label, diff) => {
    expect(parseDiffDetailsString(diff)).toBeNull();
  });

  it("truncates oversized diffs with a trailing skip line", () => {
    const diff = Array.from({ length: 450 }, (_, i) => `+${i + 1} line ${i + 1}`).join("\n");

    const lines = parseDiffDetailsString(diff);

    expect(lines).toMatchObject({ kind: "truncated" });
    expect(lines?.lines).toHaveLength(402);
    expect(lines?.lines.at(-1)).toEqual({ kind: "skip", text: "" });
  });
});

describe("computeLineDiff", () => {
  it("retains complete statistics for wholly replaced bounded inputs", () => {
    const oldText = Array.from({ length: 600 }, (_, index) => `old ${index}`).join("\n");
    const newText = Array.from({ length: 600 }, (_, index) => `new ${index}`).join("\n");
    const result = computeLineDiff(oldText, newText);
    expect(result).toMatchObject({ kind: "complete", stat: { added: 600, removed: 600 } });
    expect(result.lines).toHaveLength(401);
    expect(result.lines.at(-1)).toEqual({ kind: "skip", text: "" });
  });

  it("reports an incomplete comparison when the only change is beyond the work budget", () => {
    const oldLines = Array.from({ length: 700 }, (_, index) => `line ${index}`);
    const newLines = [...oldLines];
    newLines[650] = "outside budget";

    expect(computeLineDiff(oldLines.join("\n"), newLines.join("\n"))).toMatchObject({
      kind: "truncated",
      lines: [{ kind: "skip", text: "" }],
    });
  });

  it("returns exact zero statistics for a normal unchanged comparison", () => {
    expect(computeLineDiff("alpha\nbeta", "alpha\nbeta")).toEqual({
      kind: "complete",
      lines: [
        { kind: "ctx", text: "alpha" },
        { kind: "ctx", text: "beta" },
      ],
      stat: { added: 0, removed: 0 },
    });

    const longBody = Array.from({ length: 700 }, (_, index) => `line ${index}`).join("\n");
    expect(computeLineDiff(longBody, longBody)).toEqual({
      kind: "complete",
      lines: [
        ...Array.from({ length: 400 }, (_, index) => ({ kind: "ctx", text: `line ${index}` })),
        { kind: "skip", text: "" },
      ],
      stat: { added: 0, removed: 0 },
    });
  });

  it("keeps a late change instead of spending the preview budget on context", () => {
    const oldLines = Array.from({ length: 500 }, (_, index) => `line ${index}`);
    const newLines = [...oldLines];
    newLines[450] = "changed late";

    const lines = computeLineDiff(oldLines.join("\n"), newLines.join("\n")).lines;

    expect(lines).toContainEqual({ kind: "add", text: "changed late" });
    expect(lines).toContainEqual({ kind: "del", text: "line 450" });
    expect(lines.length).toBeLessThanOrEqual(401);
  });
});

describe("buildWriteDiffLines", () => {
  it("truncates past 80 lines with a skip marker", () => {
    const content = Array.from({ length: 81 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = buildWriteDiffLines(content);
    expect(lines).toHaveLength(81);
    expect(lines[0]).toEqual({ kind: "add", lineNo: 1, text: "line 1" });
    expect(lines[79]).toEqual({ kind: "add", lineNo: 80, text: "line 80" });
    expect(lines[80]).toEqual({ kind: "skip", text: "" });
  });
});

describe("joinDiffSections", () => {
  it("separates non-empty sections with skip lines and drops empty ones", () => {
    const first: DiffLine[] = [{ kind: "del", text: "old" }];
    const second: DiffLine[] = [{ kind: "add", text: "new" }];

    expect(
      joinDiffSections([
        { kind: "complete", lines: first, stat: { added: 0, removed: 1 } },
        { kind: "complete", lines: [], stat: { added: 0, removed: 0 } },
        { kind: "complete", lines: second, stat: { added: 1, removed: 0 } },
      ]),
    ).toEqual({
      kind: "complete",
      lines: [
        { kind: "del", text: "old" },
        { kind: "skip", text: "" },
        { kind: "add", text: "new" },
      ],
      stat: { added: 1, removed: 1 },
    });
  });
});
