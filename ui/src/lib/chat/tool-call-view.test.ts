// @vitest-environment node
// Control UI tests cover tool-call classification and view-model resolution.
import { describe, expect, it } from "vitest";
import { resolveToolCallView } from "./tool-call-view.ts";

describe("tool detail kinds", () => {
  it.each([
    ["exec", undefined, "command"],
    ["edit_file", { path: "file.ts" }, "edit"],
    ["apply_patch", { changes: [{ path: "file.ts", kind: "update", diff: "+line" }] }, "edit"],
    ["grep", { pattern: "line" }, "search"],
    ["web_fetch", { url: "https://example.test" }, "fetch"],
    ["run_shell", { command: "ls" }, "command"],
    ["run_shell", { command: "ls", a: 1, b: 2, c: 3 }, "generic"],
  ] as const)("classifies %s with args %o as %s", (name, args, expected) => {
    expect(resolveToolCallView({ name, args }).kind).toBe(expected);
  });

  it.each(["str_replace_editor"])("keeps unsupported %s editor commands generic", (name) => {
    for (const args of [{}, { command: "rename" }]) {
      expect(resolveToolCallView({ name, args }).kind).toBe("generic");
    }
  });
});

describe("shell command views", () => {
  it.each([["sh -lc 'echo hi'", "echo hi"]])("unwraps %s", (wrapped, expected) => {
    expect(resolveToolCallView({ name: "bash", args: { command: wrapped } }).command).toBe(
      expected,
    );
  });
});

describe("resolveToolCallView", () => {
  it.each(["str_replace_editor"])("resolves %s command-specific views", (name) => {
    expect(
      resolveToolCallView({
        name,
        args: { command: "view", file_path: "/repo/view.ts", view_range: [10, 20] },
      }),
    ).toEqual({ kind: "read", target: "view.ts", targetDetail: "/repo" });

    expect(
      resolveToolCallView({
        name,
        args: {
          command: "str_replace",
          file: "/repo/edit.ts",
          old_str: "before",
          new_str: "after",
        },
      }),
    ).toMatchObject({
      kind: "edit",
      target: "edit.ts",
      diff: [
        { kind: "del", text: "before" },
        { kind: "add", text: "after" },
      ],
      stat: { added: 1, removed: 1 },
    });

    expect(
      resolveToolCallView({
        name,
        args: { command: "create", filepath: "/repo/new.ts", file_text: "one\ntwo\n" },
      }),
    ).toMatchObject({
      kind: "write",
      target: "new.ts",
      stat: { added: 2, removed: 0 },
    });

    const insertion = resolveToolCallView({
      name,
      args: {
        command: "insert",
        filename: "/repo/insert.ts",
        insert_line: 42,
        insert_text: "x\ny",
      },
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
      resolveToolCallView({
        name,
        args: {
          command: "undo_edit",
          path: "/repo/undo.ts",
          old_str: "must not",
          new_str: "render",
        },
      }),
    ).toEqual({ kind: "edit", target: "undo.ts", targetDetail: "/repo" });
  });

  it("omits exact stats for truncated persisted details diffs", () => {
    const view = resolveToolCallView({
      name: "edit",
      args: { path: "/repo/a.ts", oldText: "old", newText: "new" },
      details: { diff: "+12 detail new\n...(truncated)..." },
    });

    expect(view.diff).toEqual([
      { kind: "add", lineNo: 12, text: "detail new" },
      { kind: "skip", text: "" },
    ]);
    expect(view.stat).toBeUndefined();
  });

  it("falls back to arg diffs when the details diff is unparseable", () => {
    const view = resolveToolCallView({
      name: "edit",
      args: { path: "/repo/a.ts", oldText: "old", newText: "new" },
      details: { diff: "raw unnumbered text" },
    });

    expect(view.diff).toEqual([
      { kind: "del", text: "old" },
      { kind: "add", text: "new" },
    ]);
  });

  it("keeps multi-file Codex patches separated and counts every target", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old a",
      "+new a",
      "*** Add File: src/b.ts",
      "+new b",
      "*** Delete File: src/c.ts",
      "*** End Patch",
    ].join("\n");

    const view = resolveToolCallView({ name: "apply_patch", args: { patch } });

    expect(view.target).toBe("3 files");
    expect(view.targetDetail).toBeUndefined();
    expect(view.stat).toEqual({ added: 2, removed: 1 });
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
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    const view = resolveToolCallView({ name: "apply_patch", args: { patch } });

    expect(view.target).toBe("old.ts → new.ts");
    expect(view.targetDetail).toBe("src");
  });

  it("splits headerless multi-file unified diffs and numbers hunks", () => {
    const patch = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,3 +10,4 @@",
      " context",
      "-old",
      "+new",
      "+extra",
      " tail",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n");

    const view = resolveToolCallView({ name: "apply_patch", args: { patch } });

    expect(view.target).toBe("2 files");
    expect(view.stat).toEqual({ added: 3, removed: 2 });
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
    const view = resolveToolCallView({
      name: "apply_patch",
      args: {
        changes: [
          {
            path: "src/a.ts",
            kind: { type: "update", move_path: null },
            diff: "@@\n-old a\n+new a",
          },
          { path: "src/b.ts", kind: { type: "add" }, diff: "new b\n" },
        ],
      },
    });

    expect(view.target).toBe("2 files");
    expect(view.fileOperations).toEqual([
      { operation: "update", path: "src/a.ts" },
      { operation: "add", path: "src/b.ts" },
    ]);
    expect(view.stat).toEqual({ added: 2, removed: 1 });
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

    const view = resolveToolCallView({ name: "apply_patch", args: { patch: bigPatch } });

    expect(view.kind).toBe("edit");
    expect(view.stat).toEqual({ added: 900, removed: 0 });
    expect(view.diff?.length).toBe(401);
    expect(view.diff?.at(-1)?.kind).toBe("skip");
  });

  it("caps the combined preview across multi-edit sections", () => {
    const edits = [0, 1].map((section) => ({
      oldText: `old ${section}`,
      newText: Array.from({ length: 300 }, (_, index) => `new ${section}-${index}`).join("\n"),
    }));

    const view = resolveToolCallView({ name: "multiedit", args: { path: "big.ts", edits } });

    expect(view.diff).toHaveLength(401);
    expect(view.diff?.at(-1)).toEqual({ kind: "skip", text: "" });
    expect(view.stat).toEqual({ added: 600, removed: 2 });
  });

  it("stops processing excess multi-edit pairs and omits a partial diffstat", () => {
    const edits = Array.from({ length: 20 }, (_, index) => ({
      oldText: `old ${index}`,
      newText: `new ${index}`,
    }));

    const view = resolveToolCallView({ name: "multiedit", args: { path: "many.ts", edits } });

    expect(view.diff?.at(-1)).toEqual({ kind: "skip", text: "" });
    expect(view.diff?.length).toBeLessThanOrEqual(401);
    expect(view.stat).toBeUndefined();
  });

  it("uses authoritative write details for diff and created-flag stats", () => {
    const args = { path: "/repo/file.ts", content: "line 1\nline 2\n" };

    expect(
      resolveToolCallView({
        name: "write",
        args,
        details: { created: false, diff: "-4 old\n+4 replacement" },
      }),
    ).toMatchObject({
      diff: [
        { kind: "del", lineNo: 4, text: "old" },
        { kind: "add", lineNo: 4, text: "replacement" },
      ],
      stat: { added: 1, removed: 1 },
    });

    const created = resolveToolCallView({ name: "write", args, details: { created: true } });
    expect(created.stat).toEqual({ added: 2, removed: 0 });

    const overwrite = resolveToolCallView({ name: "write", args, details: { created: false } });
    expect(overwrite.diff).toEqual([
      { kind: "add", lineNo: 1, text: "line 1" },
      { kind: "add", lineNo: 2, text: "line 2" },
    ]);
    expect(overwrite.stat).toBeUndefined();

    const unknown = resolveToolCallView({ name: "write", args, details: { changed: true } });
    expect(unknown.diff).toEqual(overwrite.diff);
    expect(unknown.stat).toBeUndefined();

    expect(resolveToolCallView({ name: "write", args, details: { changed: false } })).toEqual({
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

    const before = resolveToolCallView({ name: "edit", args });
    const after = resolveToolCallView({
      name: "edit",
      args,
      details: { diff: "+12 hello", patch: "" },
    });

    expect(before.diff?.[0]?.lineNo).toBeUndefined();
    expect(after.diff?.[0]).toMatchObject({ kind: "add", lineNo: 12, text: "hello" });
  });

  it("caches views per args object identity", () => {
    const source = { name: "edit", args: { path: "/repo/a.ts", oldText: "x", newText: "y" } };

    expect(resolveToolCallView(source)).toBe(resolveToolCallView(source));
  });

  it("keeps tool-name presentation authoritative when different calls share args", () => {
    const args = { path: "/repo/a.ts", oldText: "before", newText: "after" };

    expect(resolveToolCallView({ name: "read", args })).toMatchObject({
      kind: "read",
      target: "a.ts",
    });
    expect(resolveToolCallView({ name: "edit", args })).toMatchObject({
      kind: "edit",
      target: "a.ts",
      stat: { added: 1, removed: 1 },
    });
    expect(resolveToolCallView({ name: "write", args })).toMatchObject({
      kind: "write",
      target: "a.ts",
    });
    expect(resolveToolCallView({ name: "READ", args }).kind).toBe("read");
  });
});
