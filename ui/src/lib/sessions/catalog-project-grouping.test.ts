import { describe, expect, it } from "vitest";
import type { SessionCatalogSession } from "../../../../packages/gateway-protocol/src/index.ts";
import {
  groupCatalogSessionsByProject,
  normalizeCatalogProjectGrouping,
} from "./catalog-project-grouping.ts";

describe("normalizeCatalogProjectGrouping", () => {
  it.each([
    ["project", "project"],
    ["none", "none"],
    [undefined, "project"],
    [null, "project"],
    ["garbage", "project"],
  ] as const)("normalizes %s to %s", (raw, expected) => {
    expect(normalizeCatalogProjectGrouping(raw)).toBe(expected);
  });
});

describe("groupCatalogSessionsByProject", () => {
  it("groups distinct cwd values and preserves first-occurrence and session order", () => {
    const result = groupCatalogSessionsByProject([
      session("b-1", "/work/bravo"),
      session("a-1", "/work/alpha"),
      session("b-2", "/work/bravo"),
    ]);

    expect(result.groups.map((group) => group.key)).toEqual(["/work/bravo", "/work/alpha"]);
    expect(result.groups.map((group) => group.label)).toEqual(["bravo", "alpha"]);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual(["b-1", "b-2"]);
  });

  it("uses a custom group before the session project", () => {
    const result = groupCatalogSessionsByProject([
      { ...session("grouped", "/work/openclaw"), customGroup: "Release" },
      session("project", "/work/openclaw"),
    ]);

    expect(result.groups).toMatchObject([
      { key: "custom:Release", label: "Release", sessions: [{ threadId: "grouped" }] },
      { key: "/work/openclaw", label: "openclaw", sessions: [{ threadId: "project" }] },
    ]);
  });

  it("sorts custom groups ahead of project groups regardless of session order", () => {
    const result = groupCatalogSessionsByProject([
      session("project", "/work/openclaw"),
      { ...session("grouped", "/work/openclaw"), customGroup: "Release" },
    ]);

    expect(result.groups.map((group) => group.key)).toEqual(["custom:Release", "/work/openclaw"]);
  });

  it.each([
    ["/Users/dev/openclaw/.claude/worktrees/fix-1", "/Users/dev/openclaw"],
    ["/Users/dev/openclaw/.claude/worktrees/fix-1/ui/src", "/Users/dev/openclaw"],
    ["C:\\Users\\dev\\openclaw\\.claude\\worktrees\\fix-1", "C:\\Users\\dev\\openclaw"],
  ])("folds worktree cwd %s into %s", (worktreeCwd, expectedProject) => {
    const result = groupCatalogSessionsByProject([
      session("direct", expectedProject),
      session("worktree", worktreeCwd),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.key).toBe(expectedProject);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual(["direct", "worktree"]);
  });

  it("leaves missing and blank cwd values ungrouped", () => {
    const result = groupCatalogSessionsByProject([
      session("missing"),
      session("blank", "  "),
      session("grouped", "/work/project"),
    ]);

    expect(result.ungrouped.map((item) => item.threadId)).toEqual(["missing", "blank"]);
  });

  it("leaves Windows filesystem roots and root worktrees ungrouped", () => {
    const result = groupCatalogSessionsByProject([
      session("drive-root", "C:\\"),
      session("drive-root-worktree", "c:\\.CLAUDE\\WORKTREES\\fix-1\\src"),
      session("current-drive-root", "\\"),
      session("current-drive-root-worktree", "\\.claude\\worktrees\\fix-2\\src"),
    ]);

    expect(result.groups).toHaveLength(0);
    expect(result.ungrouped.map((item) => item.threadId)).toEqual([
      "drive-root",
      "drive-root-worktree",
      "current-drive-root",
      "current-drive-root-worktree",
    ]);
  });

  it.each([
    [" /Users/dev/openclaw/// ", "/Users/dev/openclaw", "openclaw"],
    ["C:\\Users\\dev\\openclaw\\", "C:\\Users\\dev\\openclaw", "openclaw"],
  ])("normalizes %s to key %s with label %s", (cwd, expectedKey, expectedLabel) => {
    const result = groupCatalogSessionsByProject([session("one", cwd)]);

    expect(result.groups[0]).toMatchObject({
      key: expectedKey,
      label: expectedLabel,
      title: expectedKey,
    });
  });

  it("groups equivalent Windows cwd spellings under the first display path", () => {
    const result = groupCatalogSessionsByProject([
      session("first", "C:\\Work\\Notes"),
      session("second", "c:/work/notes/"),
      session("third", "C:/WORK/NOTES"),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      key: "C:\\Work\\Notes",
      label: "Notes",
      title: "C:\\Work\\Notes",
    });
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("preserves Windows root kinds while grouping equivalent UNC paths", () => {
    const result = groupCatalogSessionsByProject([
      session("unc-first", "\\\\Server\\Share\\Project"),
      session("unc-second", "\\\\server\\share\\project"),
      session("current-drive-rooted", "\\Server\\Share\\Project"),
    ]);

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual([
      "unc-first",
      "unc-second",
    ]);
    expect(result.groups[1]?.sessions.map((item) => item.threadId)).toEqual([
      "current-drive-rooted",
    ]);
  });

  it("keeps an UNC share root groupable as a project root", () => {
    const result = groupCatalogSessionsByProject([
      session("first", "\\\\Server\\Share\\"),
      session("second", "\\\\server\\share"),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual(["first", "second"]);
    expect(result.ungrouped).toHaveLength(0);
  });

  it("folds case-varied Windows worktree paths into their origin project", () => {
    const result = groupCatalogSessionsByProject([
      session("direct", "C:\\Work\\OpenClaw"),
      session("worktree", "c:/work/openclaw/.CLAUDE/WORKTREES/fix-1/ui/src"),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.sessions.map((item) => item.threadId)).toEqual(["direct", "worktree"]);
  });

  it("keeps POSIX cwd matching case-sensitive", () => {
    const result = groupCatalogSessionsByProject([
      session("upper", "/Work/Notes"),
      session("lower", "/work/notes"),
      session("double-upper", "//mnt/Repo"),
      session("double-lower", "//mnt/repo"),
    ]);

    expect(result.groups.map((group) => group.key)).toEqual([
      "/Work/Notes",
      "/work/notes",
      "//mnt/Repo",
      "//mnt/repo",
    ]);
  });
});

function session(threadId: string, cwd?: string): SessionCatalogSession {
  return {
    threadId,
    cwd,
    status: "idle",
    archived: false,
    canContinue: true,
    canArchive: true,
  };
}
