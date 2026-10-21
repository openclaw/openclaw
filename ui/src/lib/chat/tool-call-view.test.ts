// @vitest-environment node
import { expect, it } from "vitest";
import { resolveToolCallView } from "./tool-call-view.ts";

const resolve = (name: string, args?: unknown, details?: unknown) =>
  resolveToolCallView({ name, args, details });
const editArgs = { path: "/repo/a.ts", oldText: "old", newText: "new" };
const replacementDiff = [
  { kind: "del", text: "old" },
  { kind: "add", text: "new" },
];
const editor = (args: unknown) => resolve("str_replace_editor", args);
const patchView = (patch: string) => resolve("apply_patch", { patch });

it.each([
  ["exec", undefined, "command"],
  ["edit_file", { path: "file.ts" }, "edit"],
  ["apply_patch", { changes: [{ path: "file.ts", kind: "update", diff: "+line" }] }, "edit"],
  ["grep", { pattern: "line" }, "search"],
  ["web_fetch", { url: "https://example.test" }, "fetch"],
  ["run_shell", { command: "ls" }, "command"],
  ["run_shell", { command: "ls", a: 1, b: 2, c: 3 }, "generic"],
] as const)("classifies %s with args %o as %s", (name, args, expected) => {
  expect(resolve(name, args).kind).toBe(expected);
});

it.each([{}, { command: "rename" }])("keeps unsupported editor command %o generic", (args) => {
  expect(editor(args).kind).toBe("generic");
});
it("unwraps shell commands", () => {
  expect(resolve("bash", { command: "sh -lc 'echo hi'" }).command).toBe("echo hi");
});
it("resolves editor command-specific views", () => {
  expect(editor({ command: "view", file_path: "/repo/v.ts", view_range: [10, 20] })).toEqual({
    kind: "read",
    target: "v.ts",
    targetDetail: "/repo",
  });
  expect(
    editor({
      command: "str_replace",
      file: "/repo/edit.ts",
      old_str: "old",
      new_str: "new",
    }),
  ).toMatchObject({
    kind: "edit",
    target: "edit.ts",
    diff: replacementDiff,
    stat: { added: 1, removed: 1 },
  });

  expect(
    editor({ command: "create", filepath: "/repo/new.ts", file_text: "one\ntwo\n" }),
  ).toMatchObject({ kind: "write", target: "new.ts", stat: { added: 2, removed: 0 } });

  const insertion = editor({
    command: "insert",
    filename: "/repo/insert.ts",
    insert_line: 42,
    insert_text: "x\ny",
  });
  expect(insertion).toMatchObject({
    kind: "edit",
    target: "insert.ts",
    diff: [
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ],
  });
  expect(insertion.stat).toBeUndefined();

  expect(
    editor({
      command: "undo_edit",
      path: "/repo/undo.ts",
      old_str: "must not",
      new_str: "render",
    }),
  ).toEqual({ kind: "edit", target: "undo.ts", targetDetail: "/repo" });
});

it("omits exact stats for truncated persisted details diffs", () => {
  const result = resolve("edit", editArgs, { diff: "+12 detail new\n...(truncated)..." });

  expect(result.diff).toEqual([
    { kind: "add", lineNo: 12, text: "detail new" },
    { kind: "skip", text: "" },
  ]);
  expect(result.stat).toBeUndefined();
});

it("falls back to arg diffs when the details diff is unparseable", () => {
  const result = resolve("edit", editArgs, { diff: "raw unnumbered text" });

  expect(result.diff).toEqual(replacementDiff);
});

it("keeps multi-file Codex patches separated and counts every target", () => {
  const patch =
    "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old a\n+new a\n" +
    "*** Add File: src/b.ts\n+new b\n*** Delete File: src/c.ts\n*** End Patch";

  const view = patchView(patch);
  expect(view).toMatchObject({ target: "3 files", stat: { added: 2, removed: 1 } });
  expect(view.targetDetail).toBeUndefined();
  expect(view.diff).toEqual([
    { kind: "file", path: "src/a.ts", text: "Update src/a.ts" },
    { kind: "del", text: "old a" },
    { kind: "add", text: "new a" },
    { kind: "skip", text: "" },
    { kind: "file", path: "src/b.ts", text: "Add src/b.ts" },
    { kind: "add", lineNo: 1, text: "new b" },
    { kind: "skip", text: "" },
    { kind: "file", path: "src/c.ts", text: "Delete src/c.ts" },
  ]);
});

it("retains source context for Codex moves", () => {
  const patch =
    "*** Begin Patch\n*** Update File: src/old.ts\n" +
    "*** Move to: src/new.ts\n@@\n-old\n+new\n*** End Patch";

  expect(patchView(patch)).toMatchObject({ target: "old.ts → new.ts", targetDetail: "src" });
});

it("splits headerless multi-file unified diffs and numbers hunks", () => {
  const patch =
    "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,4 @@\n" +
    " context\n-old\n+new\n+extra\n tail\n" +
    "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-before\n+after";

  const view = patchView(patch);
  expect(view).toMatchObject({ target: "2 files", stat: { added: 3, removed: 2 } });
  expect(view.diff).toEqual([
    { kind: "file", path: "src/a.ts", text: "Update src/a.ts" },
    { kind: "ctx", lineNo: 10, text: "context" },
    { kind: "del", lineNo: 11, text: "old" },
    { kind: "add", lineNo: 11, text: "new" },
    { kind: "add", lineNo: 12, text: "extra" },
    { kind: "ctx", lineNo: 13, text: "tail" },
    { kind: "skip", text: "" },
    { kind: "file", path: "src/b.ts", text: "Update src/b.ts" },
    { kind: "del", lineNo: 1, text: "before" },
    { kind: "add", lineNo: 1, text: "after" },
  ]);
});

it("renders structured Codex file changes per file", () => {
  const view = resolve("apply_patch", {
    changes: [
      { path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "@@\n-old a\n+new a" },
      { path: "src/b.ts", kind: { type: "add" }, diff: "new b\n" },
    ],
  });
  expect(view).toMatchObject({ target: "2 files", stat: { added: 2, removed: 1 } });
  expect(view.fileOperations).toEqual([
    { operation: "update", path: "src/a.ts" },
    { operation: "add", path: "src/b.ts" },
  ]);
  expect(view.diff).toContainEqual({ kind: "file", path: "src/a.ts", text: "Update src/a.ts" });
  expect(view.diff).toContainEqual({ kind: "file", path: "src/b.ts", text: "Add src/b.ts" });
});

it("caps apply_patch rows while keeping the full diffstat", () => {
  const bigPatch = [
    "*** Begin Patch",
    "*** Update File: big.ts",
    ...Array.from({ length: 900 }, (_, index) => `+line ${index}`),
    "*** End Patch",
  ].join("\n");

  const view = patchView(bigPatch);
  expect(view).toMatchObject({ kind: "edit", stat: { added: 900, removed: 0 } });
  expect(view.diff?.length).toBe(401);
  expect(view.diff?.at(-1)?.kind).toBe("skip");
});

it("caps the combined preview across multi-edit sections", () => {
  const edits = [0, 1].map((section) => ({
    oldText: `old ${section}`,
    newText: Array.from({ length: 300 }, (_, index) => `new ${section}-${index}`).join("\n"),
  }));

  const view = resolve("multiedit", { path: "big.ts", edits });

  expect(view.diff).toHaveLength(401);
  expect(view.diff?.at(-1)).toEqual({ kind: "skip", text: "" });
  expect(view.stat).toEqual({ added: 600, removed: 2 });
});

it("stops processing excess multi-edit pairs and omits a partial diffstat", () => {
  const edits = Array.from({ length: 20 }, (_, index) => ({
    oldText: `old ${index}`,
    newText: `new ${index}`,
  }));

  const view = resolve("multiedit", { path: "many.ts", edits });

  expect(view.diff?.at(-1)).toEqual({ kind: "skip", text: "" });
  expect(view.diff?.length).toBeLessThanOrEqual(401);
  expect(view.stat).toBeUndefined();
});

it("uses authoritative write details for diff and created-flag stats", () => {
  const args = { path: "/repo/file.ts", content: "line 1\nline 2\n" };

  expect(resolve("write", args, { created: false, diff: "-4 old\n+4 replacement" })).toMatchObject({
    diff: [
      { kind: "del", lineNo: 4, text: "old" },
      { kind: "add", lineNo: 4, text: "replacement" },
    ],
    stat: { added: 1, removed: 1 },
  });

  expect(resolve("write", args, { created: true }).stat).toEqual({ added: 2, removed: 0 });

  const overwrite = resolve("write", args, { created: false });
  expect(overwrite.diff).toEqual([
    { kind: "add", lineNo: 1, text: "line 1" },
    { kind: "add", lineNo: 2, text: "line 2" },
  ]);
  expect(overwrite.stat).toBeUndefined();

  const unknown = resolve("write", args, { changed: true });
  expect(unknown.diff).toEqual(overwrite.diff);
  expect(unknown.stat).toBeUndefined();

  expect(resolve("write", args, { changed: false })).toEqual({
    kind: "write",
    target: "file.ts",
    targetDetail: "/repo",
  });
});

it.each([
  ["edit without a path", { name: "edit", args: { oldText: "a", newText: "b" } }],
  ["patch without patch text", { name: "apply_patch", args: {} }],
  ["fetch without a url", { name: "fetch", args: {} }],
])("degrades to generic for %s", (_label, source) => {
  expect(resolveToolCallView(source).kind).toBe("generic");
});

it("rebuilds the cached view when result details arrive on the same args", () => {
  const args = { path: "/repo/a.md", edits: [{ oldText: "x", newText: "y" }] };

  const before = resolve("edit", args);
  const after = resolve("edit", args, { diff: "+12 hello", patch: "" });

  expect(before.diff?.[0]?.lineNo).toBeUndefined();
  expect(after.diff?.[0]).toMatchObject({ kind: "add", lineNo: 12, text: "hello" });
});

it("caches views per args object identity", () => {
  const source = { name: "edit", args: editArgs };
  expect(resolveToolCallView(source)).toBe(resolveToolCallView(source));
});

it("keeps tool-name presentation authoritative when different calls share args", () => {
  const args = editArgs;

  expect(resolve("read", args)).toMatchObject({ kind: "read", target: "a.ts" });
  expect(resolve("edit", args)).toMatchObject({
    kind: "edit",
    target: "a.ts",
    stat: { added: 1, removed: 1 },
  });
  expect(resolve("write", args)).toMatchObject({ kind: "write", target: "a.ts" });
  expect(resolve("READ", args).kind).toBe("read");
});
