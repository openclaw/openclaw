/**
 * Regression coverage for surrogate-safe truncation in compact tool display
 * detail coercion (coerceDisplayValue, reached via resolveToolVerbAndDetailForArgs
 * -> resolveDetailFromKeys).
 */
import { describe, expect, it } from "vitest";
import { resolveToolVerbAndDetailForArgs } from "./tool-display-common.js";
import { formatToolDetail, formatToolSummary, resolveToolDisplay } from "./tool-display.js";

describe("tool detail separators", () => {
  it.each([
    {
      input: { name: "read", args: { path: "/notes/Project · Notes.md" } },
      expected: "from /notes/Project · Notes.md",
    },
    {
      input: { name: "web_search", args: { query: "Project · Notes" } },
      expected: 'for "Project · Notes"',
    },
    {
      input: {
        name: "image",
        args: { path: "/notes/Project · Notes.png", prompt: "Summarize A · B" },
      },
      expected: "path /notes/Project · Notes.png, prompt Summarize A · B",
    },
    {
      input: { name: "custom_tool", meta: "Project · Notes" },
      expected: "Project · Notes",
    },
    {
      input: {
        name: "exec",
        args: {
          command: 'cat "/notes/Project · Notes.md"',
          host: "node",
          node: "preview-node",
          workdir: "/app",
        },
      },
      expected:
        'show /notes/Project · Notes.md (in /app), node: preview-node, `cat "/notes/Project · Notes.md"`',
    },
    {
      input: {
        name: "exec",
        args: { command: "npm install", host: "node", node: "preview-node", workdir: "/app" },
      },
      expected: "install dependencies (in /app), node: preview-node, `npm install`",
    },
  ])("preserves literal details and formats owned separators: $expected", ({ input, expected }) => {
    expect(formatToolDetail(resolveToolDisplay(input))).toBe(expected);
  });
});

describe("bounded tool detail previews", () => {
  it("stops reading an upload batch once the preview and ellipsis are determined", () => {
    let reads = 0;
    const paths = new Proxy(
      Array.from({ length: 1_000 }, (_, index) => `/uploads/photo-${index + 1}.jpg`),
      {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) {
            reads++;
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );

    expect(resolveToolDisplay({ name: "browser", args: { action: "upload", paths } }).detail).toBe(
      "/uploads/photo-1.jpg, /uploads/photo-2.jpg, /uploads/photo-3.jpg…",
    );
    expect(reads).toBeLessThanOrEqual(4);
  });

  it.each([
    { value: [], expected: undefined, includeFalsy: false },
    { value: [null, "", false, 0], expected: undefined, includeFalsy: false },
    { value: [null, "", false, 0], expected: "false, 0", includeFalsy: true },
    { value: ["a", "b", "c", "", null], expected: "a, b, c", includeFalsy: false },
    { value: ["a", "b", "c", "", "d"], expected: "a, b, c…", includeFalsy: false },
    { value: [["a", "b", "c", "d"], [], "e"], expected: "a, b, c…, e", includeFalsy: false },
    {
      value: "\n  First line\r\nSecond line\nThird line",
      expected: "First line",
      includeFalsy: false,
    },
  ])("preserves compact detail semantics: $value", ({ value, expected, includeFalsy }) => {
    expect(
      resolveToolVerbAndDetailForArgs({
        toolKey: "custom_tool",
        args: { note: value },
        fallbackDetailKeys: ["note"],
        detailMode: "first",
        detailCoerce: { includeFalsy },
      }).detail,
    ).toBe(expected);
  });
});

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const codeUnit = value.charCodeAt(i);
    if (isHighSurrogate(codeUnit)) {
      if (i + 1 >= value.length || !isLowSurrogate(value.charCodeAt(i + 1))) {
        return true;
      }
    } else if (isLowSurrogate(codeUnit)) {
      if (i === 0 || !isHighSurrogate(value.charCodeAt(i - 1))) {
        return true;
      }
    }
  }
  return false;
}

describe("coerceDisplayValue surrogate-safe truncation", () => {
  it("does not split an emoji across the truncation boundary (default maxStringChars=160)", () => {
    // 200 UTF-16 units: 78 'a', an emoji (surrogate pair at indices 78-79), 120 'b'.
    // With maxStringChars=160, half = floor(159/2) = 79, so the naive
    // firstLine.slice(0, 79) keeps only the emoji's high surrogate at index 78.
    const detailValue = `${"a".repeat(78)}\u{1F600}${"b".repeat(120)}`;
    expect(detailValue.length).toBe(200);

    const { detail } = resolveToolVerbAndDetailForArgs({
      toolKey: "custom_tool",
      args: { note: detailValue },
      fallbackDetailKeys: ["note"],
      detailMode: "first",
    });

    expect(detail).toBeDefined();
    // The bug rendered a lone high surrogate (and possibly a lone low surrogate
    // at the tail head); the fix must drop the whole emoji at the cut.
    expect(hasLoneSurrogate(detail as string)).toBe(false);
    // Head keeps only the 78 leading 'a's (emoji dropped, not half-kept).
    expect((detail as string).split("…")[0]).toBe("a".repeat(78));
    // Tail must not begin mid-pair on a lone low surrogate.
    const tail = (detail as string).split("…")[1] ?? "";
    expect(isLowSurrogate(tail.charCodeAt(0))).toBe(false);
  });

  it("leaves plain (non-surrogate) long values truncated as before", () => {
    const detailValue = "x".repeat(300);

    const { detail } = resolveToolVerbAndDetailForArgs({
      toolKey: "custom_tool",
      args: { note: detailValue },
      fallbackDetailKeys: ["note"],
      detailMode: "first",
    });

    // Behavior-preserving for ASCII: half = 79, so 79 'x' + ellipsis + 80 'x'.
    expect(detail).toBe(`${"x".repeat(79)}…${"x".repeat(80)}`);
    expect(hasLoneSurrogate(detail as string)).toBe(false);
  });

  it("returns short values unchanged", () => {
    const { detail } = resolveToolVerbAndDetailForArgs({
      toolKey: "custom_tool",
      args: { note: "short value with no emoji" },
      fallbackDetailKeys: ["note"],
      detailMode: "first",
    });
    expect(detail).toBe("short value with no emoji");
  });
});

describe("progress card tool display", () => {
  it.each(["progress_card", "update_plan"])(
    "keeps %s card content out of generic labels",
    (name) => {
      const markdown = '<progress aria-label="private" value="1" max="2"></progress>';
      for (const detailMode of ["explain", "raw"] as const) {
        const display = resolveToolDisplay({
          name,
          args: { markdown, plan: [{ step: "private step", status: "in_progress" }] },
          meta: markdown,
          detailMode,
        });
        expect(formatToolDetail(display)).toBeUndefined();
        expect(formatToolSummary(display)).not.toContain("private");
      }
    },
  );
});
