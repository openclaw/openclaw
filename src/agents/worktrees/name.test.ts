import { describe, expect, it } from "vitest";
import { appendWorktreeIdSuffix, slugifyWorktreeTitle } from "./name.js";

describe("slugifyWorktreeTitle", () => {
  it.each([
    ["Fix agent selection menu", "fix-agent-selection-menu"],
    ["Crème brûlée & release prep", "creme-brulee-and-release-prep"],
    ['  Title: "Worktree names"  ', "title-worktree-names"],
  ])("slugifies %s", (title, expected) => {
    expect(slugifyWorktreeTitle(title)).toBe(expected);
  });

  it("truncates at the last complete word within the worktree contract limit", () => {
    expect(slugifyWorktreeTitle(`${"a".repeat(50)} complete unfinished`)).toBe(
      `${"a".repeat(50)}-complete`,
    );
    expect(slugifyWorktreeTitle(`${"a".repeat(63)} two`)).toBe("a".repeat(63));
  });

  it("returns undefined when a title has no ASCII slug characters", () => {
    expect(slugifyWorktreeTitle("🦞 日本語")).toBeUndefined();
  });
});

describe("appendWorktreeIdSuffix", () => {
  const id = "AB38B4C2-0000-4000-8000-000000000000";

  it("ends the name with the first six ID characters and any local ordinal", () => {
    expect(appendWorktreeIdSuffix("release-planning", id)).toBe("release-planning-ab38b4");
    expect(appendWorktreeIdSuffix("release-planning", id, 2)).toBe("release-planning-ab38b4-2");
  });

  it("shortens the readable name, not the ID, to fit the name limit", () => {
    const name = "a".repeat(64);

    expect(appendWorktreeIdSuffix(name, id)).toBe(`${"a".repeat(57)}-ab38b4`);
    expect(appendWorktreeIdSuffix(name, id, 12)).toBe(`${"a".repeat(54)}-ab38b4-12`);
  });
});
