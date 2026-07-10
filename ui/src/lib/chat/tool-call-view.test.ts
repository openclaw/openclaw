// Control UI tests cover tool-call classification and view-model resolution.
import { describe, expect, it } from "vitest";
import {
  resolveToolCallKind,
  resolveToolCallView,
  splitPathForDisplay,
  unwrapShellWrapperCommand,
} from "./tool-call-view.ts";

describe("resolveToolCallKind", () => {
  it.each([
    ["bash", undefined, "command"],
    ["exec", undefined, "command"],
    ["Read", undefined, "read"],
    ["read_file", undefined, "read"],
    ["edit", undefined, "edit"],
    ["str_replace_editor", undefined, "edit"],
    ["apply_patch", undefined, "edit"],
    ["write", undefined, "write"],
    ["create_file", undefined, "write"],
    ["grep", undefined, "search"],
    ["glob", undefined, "search"],
    ["web_fetch", undefined, "fetch"],
    ["mcp__linear__create_issue", undefined, "generic"],
    // Arg-shape fallback: unknown tool with a small command payload is a command.
    ["run_shell", { command: "ls" }, "command"],
    ["run_shell", { command: "ls", a: 1, b: 2, c: 3 }, "generic"],
  ])("classifies %s with args %o as %s", (name, args, expected) => {
    expect(resolveToolCallKind(name, args)).toBe(expected);
  });
});

describe("splitPathForDisplay", () => {
  it.each([
    ["/repo/src/index.ts", { base: "index.ts", dir: "/repo/src" }],
    ["index.ts", { base: "index.ts" }],
    ["C:\\repo\\file.ts", { base: "file.ts", dir: "C:/repo" }],
    ["/repo/dir/", { base: "dir", dir: "/repo" }],
  ])("splits %s", (path, expected) => {
    expect(splitPathForDisplay(path)).toEqual(expected);
  });
});

describe("unwrapShellWrapperCommand", () => {
  it.each([
    ["/bin/zsh -lc 'pnpm test ui'", "pnpm test ui"],
    ['/bin/bash -c "git status"', "git status"],
    ["sh -lc 'echo hi'", "echo hi"],
    ["pnpm test ui", "pnpm test ui"],
    ["/bin/zsh -lc unquoted", "/bin/zsh -lc unquoted"],
  ])("unwraps %s", (wrapped, expected) => {
    expect(unwrapShellWrapperCommand(wrapped)).toBe(expected);
  });

  it("unwraps the shell wrapper in command views", () => {
    expect(
      resolveToolCallView({ name: "bash", args: { command: "/bin/zsh -lc 'node --version'" } }),
    ).toEqual({ kind: "command", command: "node --version" });
  });
});

describe("resolveToolCallView", () => {
  it("returns the command text for command rows", () => {
    expect(resolveToolCallView({ name: "bash", args: { command: "git status" } })).toEqual({
      kind: "command",
      command: "git status",
    });
  });

  it("resolves read targets across path spellings", () => {
    for (const args of [
      { path: "/repo/src/main.ts" },
      { file_path: "/repo/src/main.ts" },
      { filePath: "/repo/src/main.ts" },
    ]) {
      expect(resolveToolCallView({ name: "read", args })).toEqual({
        kind: "read",
        target: "main.ts",
        targetDetail: "/repo/src",
      });
    }
  });

  it("computes an edit diff from openclaw-style oldText/newText args", () => {
    const view = resolveToolCallView({
      name: "edit",
      args: { path: "/repo/a.ts", oldText: "old line", newText: "new line" },
    });

    expect(view.kind).toBe("edit");
    expect(view.target).toBe("a.ts");
    expect(view.targetDetail).toBe("/repo");
    expect(view.diff).toEqual([
      { kind: "del", text: "old line" },
      { kind: "add", text: "new line" },
    ]);
    expect(view.stat).toEqual({ added: 1, removed: 1 });
  });

  it("computes an edit diff from Claude-style old_string/new_string args", () => {
    const view = resolveToolCallView({
      name: "edit",
      args: { file_path: "/repo/a.ts", old_string: "before", new_string: "after" },
    });

    expect(view.diff).toEqual([
      { kind: "del", text: "before" },
      { kind: "add", text: "after" },
    ]);
  });

  it("joins multi-edit diffs with skip separators", () => {
    const view = resolveToolCallView({
      name: "multiedit",
      args: {
        path: "/repo/a.ts",
        edits: [
          { oldText: "one", newText: "uno" },
          { oldText: "two", newText: "dos" },
        ],
      },
    });

    expect(view.diff).toEqual([
      { kind: "del", text: "one" },
      { kind: "add", text: "uno" },
      { kind: "skip", text: "" },
      { kind: "del", text: "two" },
      { kind: "add", text: "dos" },
    ]);
    expect(view.stat).toEqual({ added: 2, removed: 2 });
  });

  it("prefers the numbered details diff over locally computed arg diffs", () => {
    const view = resolveToolCallView({
      name: "edit",
      args: { path: "/repo/a.ts", oldText: "arg old", newText: "arg new" },
      details: { diff: "-12 detail old\n+12 detail new" },
    });

    expect(view.diff).toEqual([
      { kind: "del", lineNo: 12, text: "detail old" },
      { kind: "add", lineNo: 12, text: "detail new" },
    ]);
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

  it("renders Codex apply_patch calls as edits with a target path", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/lib/util.ts",
      "@@",
      " context line",
      "-removed line",
      "+added line",
      "*** End Patch",
    ].join("\n");

    const view = resolveToolCallView({ name: "apply_patch", args: { patch } });

    expect(view.kind).toBe("edit");
    expect(view.target).toBe("util.ts");
    expect(view.targetDetail).toBe("src/lib");
    expect(view.diff).toContainEqual({ kind: "del", text: "removed line" });
    expect(view.diff).toContainEqual({ kind: "add", text: "added line" });
    expect(view.stat).toEqual({ added: 1, removed: 1 });
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

  it("accepts the Codex input spelling for patch text", () => {
    const view = resolveToolCallView({
      name: "apply_patch",
      args: { input: "*** Add File: notes.md\n+hello" },
    });

    expect(view.kind).toBe("edit");
    expect(view.target).toBe("notes.md");
    expect(view.stat).toEqual({ added: 1, removed: 0 });
  });

  it("builds an all-added preview for write calls with content", () => {
    const view = resolveToolCallView({
      name: "write",
      args: { path: "/repo/new.ts", content: "line 1\nline 2\n" },
    });

    expect(view).toEqual({
      kind: "write",
      target: "new.ts",
      targetDetail: "/repo",
      diff: [
        { kind: "add", lineNo: 1, text: "line 1" },
        { kind: "add", lineNo: 2, text: "line 2" },
      ],
      stat: { added: 2, removed: 0 },
    });
  });

  it("resolves search views from pattern plus path scope", () => {
    expect(resolveToolCallView({ name: "grep", args: { pattern: "TODO", path: "src" } })).toEqual({
      kind: "search",
      target: "TODO",
      targetDetail: "src",
    });
  });

  it("resolves fetch views from the url arg", () => {
    expect(resolveToolCallView({ name: "web_fetch", args: { url: "https://x.dev/a" } })).toEqual({
      kind: "fetch",
      target: "https://x.dev/a",
    });
  });

  it.each([
    ["read without a path", { name: "read", args: {} }],
    ["edit without a path", { name: "edit", args: { oldText: "a", newText: "b" } }],
    ["patch without patch text", { name: "apply_patch", args: {} }],
    ["fetch without a url", { name: "fetch", args: {} }],
    ["unknown tool", { name: "mcp__thing", args: { foo: "bar" } }],
  ])("degrades to generic for %s", (_label, source) => {
    expect(resolveToolCallView(source).kind).toBe("generic");
  });

  it("renders pure deletions without a phantom blank added line", () => {
    const view = resolveToolCallView({
      name: "edit",
      args: { path: "/repo/a.ts", oldText: "gone-line", newText: "" },
    });

    expect(view.stat).toEqual({ added: 0, removed: 1 });
    expect(view.diff).toEqual([{ kind: "del", text: "gone-line" }]);
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
});
