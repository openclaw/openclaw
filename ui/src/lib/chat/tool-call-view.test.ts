// @vitest-environment node
import { expect, it } from "vitest";
import type { DiffLine } from "./tool-call-diff.ts";
import { resolveToolCallView, type ToolCallView } from "./tool-call-view.ts";

const resolve = (name: string, args?: unknown, details?: unknown) =>
  resolveToolCallView({ name, args, details });
const editArgs = { path: "/repo/a.ts", oldText: "old", newText: "new" };
const line = (kind: DiffLine["kind"], text: string, lineNo?: number): DiffLine =>
  lineNo === undefined ? { kind, text } : { kind, text, lineNo };
const file = (path: string, operation = "Update"): DiffLine => ({
  kind: "file",
  path,
  text: `${operation} ${path}`,
});
const skip = line("skip", "");
const replacementDiff = [line("del", "old"), line("add", "new")];
const patchView = (patch: string) => resolve("apply_patch", { patch });
function check(actual: ToolCallView, expected: Partial<ToolCallView>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(Reflect.get(actual, key)).toEqual(value);
  }
}

it.each([
  ["exec", undefined, "command"],
  ["apply_patch", { changes: [{ path: "file.ts", kind: "update", diff: "+line" }] }, "edit"],
  ["grep", { pattern: "line" }, "search"],
  ["web_fetch", { url: "https://example.test" }, "fetch"],
  ["run_shell", { command: "ls" }, "command"],
  ["run_shell", { command: "ls", a: 1, b: 2, c: 3 }, "generic"],
  ["str_replace_editor", { command: "rename" }, "generic"],
  ["edit", { oldText: "a", newText: "b" }, "generic"],
  ["apply_patch", {}, "generic"],
  ["fetch", {}, "generic"],
] as const)("classifies %s with args %o as %s", (name, args, kind) => {
  expect(resolve(name, args).kind).toBe(kind);
});

it("unwraps shell commands", () => {
  expect(resolve("bash", { command: "sh -lc 'echo hi'" }).command).toBe("echo hi");
});

it.each<[Record<string, unknown>, Partial<ToolCallView>, boolean]>([
  [
    { command: "view", file_path: "/repo/v.ts", view_range: [10, 20] },
    { kind: "read", target: "v.ts", targetDetail: "/repo" },
    true,
  ],
  [
    { command: "str_replace", file: "/repo/edit.ts", old_str: "old", new_str: "new" },
    { kind: "edit", target: "edit.ts", diff: replacementDiff, stat: { added: 1, removed: 1 } },
    false,
  ],
  [
    { command: "create", filepath: "/repo/new.ts", file_text: "one\ntwo\n" },
    { kind: "write", target: "new.ts", stat: { added: 2, removed: 0 } },
    false,
  ],
  [
    { command: "insert", filename: "/repo/insert.ts", insert_line: 42, insert_text: "x\ny" },
    {
      kind: "edit",
      target: "insert.ts",
      diff: [line("add", "x"), line("add", "y")],
      stat: undefined,
    },
    false,
  ],
  [
    { command: "undo_edit", path: "/repo/undo.ts", old_str: "must not", new_str: "render" },
    { kind: "edit", target: "undo.ts", targetDetail: "/repo" },
    true,
  ],
])("projects editor command %o", (args, expected, exact) => {
  const view = resolve("str_replace_editor", args);
  if (exact) {
    expect(view).toEqual(expected);
  } else {
    check(view, expected);
  }
});

it.each<[string, Partial<ToolCallView>]>([
  [
    "+12 detail new\n...(truncated)...",
    { diff: [line("add", "detail new", 12), skip], stat: undefined },
  ],
  ["raw unnumbered text", { diff: replacementDiff }],
])("uses parseable details before arg diffs: %s", (diff, expected) => {
  check(resolve("edit", editArgs, { diff }), expected);
});

it("separates multi-file patches and counts every target", () => {
  const view = patchView(
    "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old a\n+new a\n" +
      "*** Add File: src/b.ts\n+new b\n*** Delete File: src/c.ts\n*** End Patch",
  );
  check(view, {
    target: "3 files",
    targetDetail: undefined,
    stat: { added: 2, removed: 1 },
    diff: [
      file("src/a.ts"),
      line("del", "old a"),
      line("add", "new a"),
      skip,
      file("src/b.ts", "Add"),
      line("add", "new b", 1),
      skip,
      file("src/c.ts", "Delete"),
    ],
  });
});

it("splits headerless unified diffs and numbers hunks", () => {
  check(
    patchView(
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,4 @@\n" +
        " context\n-old\n+new\n+extra\n tail\n" +
        "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-before\n+after",
    ),
    {
      target: "2 files",
      stat: { added: 3, removed: 2 },
      diff: [
        file("src/a.ts"),
        line("ctx", "context", 10),
        line("del", "old", 11),
        line("add", "new", 11),
        line("add", "extra", 12),
        line("ctx", "tail", 13),
        skip,
        file("src/b.ts"),
        line("del", "before", 1),
        line("add", "after", 1),
      ],
    },
  );
});

it("caps patch rows while keeping the full diffstat", () => {
  const view = patchView(
    [
      "*** Begin Patch",
      "*** Update File: big.ts",
      ...Array.from({ length: 900 }, (_, i) => `+line ${i}`),
      "*** End Patch",
    ].join("\n"),
  );
  check(view, { kind: "edit", stat: { added: 900, removed: 0 } });
  expect([view.diff?.length, view.diff?.at(-1)?.kind]).toEqual([401, "skip"]);
});

it("caps the combined preview across multi-edit sections", () => {
  const edits = [0, 1].map((section) => ({
    oldText: `old ${section}`,
    newText: Array.from({ length: 300 }, (_, i) => `new ${section}-${i}`).join("\n"),
  }));
  edits.splice(1, 0, { oldText: "", newText: "" });
  const view = resolve("multiedit", { path: "big.ts", edits });
  expect([view.diff?.length, view.diff?.at(-1)]).toEqual([401, skip]);
  expect(view.diff?.slice(301, 303)).toEqual([skip, line("del", "old 1")]);
  expect(view.stat).toEqual({ added: 600, removed: 2 });
});

it("stops excess multi-edit pairs and omits a partial diffstat", () => {
  const edits = Array.from({ length: 20 }, (_, i) => ({
    oldText: `old ${i}`,
    newText: `new ${i}`,
  }));
  const view = resolve("multiedit", { path: "many.ts", edits });
  expect(view.diff?.at(-1)).toEqual(skip);
  expect(view.diff?.length).toBeLessThanOrEqual(401);
  expect(view.stat).toBeUndefined();
});

it("uses authoritative write details for diff and created-flag stats", () => {
  const content = Array.from({ length: 81 }, (_, i) => `line ${i + 1}`);
  const args = { path: "/repo/file.ts", content: content.join("\n") + "\n" };
  check(
    resolve("write", args, {
      created: false,
      diff: " 455 before\n-456 old line\n+456 new line\n    ...\n 460 after",
    }),
    {
      diff: [
        line("ctx", "before", 455),
        line("del", "old line", 456),
        line("add", "new line", 456),
        skip,
        line("ctx", "after", 460),
      ],
      stat: { added: 1, removed: 1 },
    },
  );
  expect(resolve("write", args, { created: true }).stat).toEqual({ added: 81, removed: 0 });
  const preview = [...content.slice(0, 80).map((text, i) => line("add", text, i + 1)), skip];
  check(resolve("write", args, { created: false }), { diff: preview, stat: undefined });
  check(resolve("write", args, { changed: true }), { diff: preview, stat: undefined });
  expect(resolve("write", args, { changed: false })).toEqual({
    kind: "write",
    target: "file.ts",
    targetDetail: "/repo",
  });
});

it("caches args until result details arrive", () => {
  const args = { path: "/repo/a.md", edits: [{ oldText: "x", newText: "y" }] };
  const before = resolve("edit", args);
  expect(resolve("edit", args)).toBe(before);
  const after = resolve("edit", args, { diff: "+12 hello", patch: "" });
  expect(before.diff?.[0]?.lineNo).toBeUndefined();
  expect(after.diff?.[0]).toMatchObject({ kind: "add", lineNo: 12, text: "hello" });
});

it("keeps tool-name presentation authoritative when calls share args", () => {
  check(resolve("read", editArgs), { kind: "read", target: "a.ts" });
  check(resolve("edit", editArgs), {
    kind: "edit",
    target: "a.ts",
    stat: { added: 1, removed: 1 },
  });
  check(resolve("write", editArgs), { kind: "write", target: "a.ts" });
  expect(resolve("READ", editArgs).kind).toBe("read");
});
