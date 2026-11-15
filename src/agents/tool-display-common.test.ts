import { describe, expect, it } from "vitest";
import { resolveToolDetailForArgs } from "./tool-display-common.js";
import { formatToolDetail, formatToolSummary, resolveToolDisplay } from "./tool-display.js";

function preview(value: unknown, includeFalsy = false) {
  return resolveToolDetailForArgs({
    toolKey: "custom_tool",
    args: { note: value },
    fallbackDetailKeys: ["note"],
    detailMode: "first",
    detailCoerce: { includeFalsy },
  });
}

function nested(depth: number) {
  let value: unknown = "x";
  for (let i = 0; i < depth; i++) {
    value = [value];
  }
  return value;
}

describe("tool detail separators", () => {
  it.each([
    [
      { name: "read", args: { path: "/notes/Project · Notes.md" } },
      "from /notes/Project · Notes.md",
    ],
    [{ name: "web_search", args: { query: "Project · Notes" } }, 'for "Project · Notes"'],
    [
      { name: "image", args: { path: "/notes/Project · Notes.png", prompt: "Summarize A · B" } },
      "path /notes/Project · Notes.png, prompt Summarize A · B",
    ],
    [{ name: "custom_tool", meta: "Project · Notes" }, "Project · Notes"],
    [
      {
        name: "exec",
        args: {
          command: 'cat "/notes/Project · Notes.md"',
          host: "node",
          node: "preview-node",
          workdir: "/app",
        },
      },
      'show /notes/Project · Notes.md (in /app), node: preview-node, `cat "/notes/Project · Notes.md"`',
    ],
    [
      {
        name: "exec",
        args: { command: "npm install", host: "node", node: "preview-node", workdir: "/app" },
      },
      "install dependencies (in /app), node: preview-node, `npm install`",
    ],
  ] satisfies Array<[Parameters<typeof resolveToolDisplay>[0], string]>)(
    "preserves literal details and formats owned separators: %j",
    (input, expected) => {
      expect(formatToolDetail(resolveToolDisplay(input))).toBe(expected);
    },
  );
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
    [[null, "", false, 0], undefined, false],
    [[null, "", false, 0], "false, 0", true],
    [["a", "b", "c", "", null], "a, b, c", false],
    [["a", "b", "c", "", "d"], "a, b, c…", false],
    [[["a", "b", "c", "d"], [], "e"], "a, b, c…, e", false],
    ["\n  First line\r\nSecond line\nThird line", "First line", false],
  ] as const)("preserves compact detail semantics: %j", (value, expected, includeFalsy) => {
    expect(preview(value, includeFalsy)).toBe(expected);
  });
});

describe("coerceDisplayValue surrogate-safe truncation", () => {
  it("does not split an emoji across the truncation boundary (default maxStringChars=160)", () => {
    // The 79-unit head would bisect the emoji at indices 78-79.
    const detailValue = `${"a".repeat(78)}\u{1F600}${"b".repeat(120)}`;
    expect(preview(detailValue)).toBe(`${"a".repeat(78)}…${"b".repeat(80)}`);
  });

  it("leaves plain (non-surrogate) long values truncated as before", () => {
    expect(preview("x".repeat(300))).toBe(`${"x".repeat(79)}…${"x".repeat(80)}`);
  });
});

describe("coerceDisplayValue deep array nesting", () => {
  it.each([
    { depth: 64, expected: "x" },
    { depth: 65, expected: undefined },
  ])("bounds the preview at depth $depth", ({ depth, expected }) => {
    expect(preview(nested(depth))).toBe(expected);
  });

  it("retains shallow siblings after an omitted deep value", () => {
    expect(preview([nested(5_000), "survivor"])).toBe("survivor");
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
