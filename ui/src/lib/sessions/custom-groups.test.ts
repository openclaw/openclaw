// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mergeSessionGroupDefaults, normalizeSessionSectionOrderTokens } from "./custom-groups.ts";

describe("session group catalog data", () => {
  it("merges defaults for catalog groups only", () => {
    const groups = [
      { name: "Client", position: 4 },
      { name: "Local", position: 1 },
    ];
    expect(
      mergeSessionGroupDefaults(groups, [
        { name: "Client", cwd: "/repos/client", worktree: true },
        { name: "Local", worktree: false },
        { name: "Missing", cwd: "/repos/missing", worktree: true },
      ]),
    ).toEqual([
      { name: "Client", position: 4, cwd: "/repos/client", worktree: true },
      { name: "Local", position: 1, worktree: false },
    ]);
  });

  it("replaces prior defaults without changing catalog metadata or inputs", () => {
    const groups = Object.freeze([
      Object.freeze({ name: "Client", position: 4, cwd: "/old/client", worktree: true }),
      Object.freeze({ name: "Local", position: 1, cwd: "/old/local", worktree: true }),
      Object.freeze({ name: "Missing", position: 8, cwd: "/old/missing", worktree: true }),
    ]);
    const payload = Object.freeze({
      defaults: Object.freeze([
        Object.freeze({ name: "Client", position: 99, worktree: false }),
        Object.freeze({ name: "Local", cwd: "/repos/local" }),
      ]),
    });

    expect(mergeSessionGroupDefaults(groups, payload.defaults)).toStrictEqual([
      { name: "Client", position: 4, worktree: false },
      { name: "Local", position: 1, cwd: "/repos/local" },
      { name: "Missing", position: 8 },
    ]);
  });

  it("normalizes stored section order", () => {
    expect(
      normalizeSessionSectionOrderTokens([
        " work ",
        "",
        42,
        "work",
        "category: Alpha ",
        " catalog: codex ",
        "catalog:",
      ]),
    ).toEqual(["work", "category:Alpha", "catalog:codex"]);
    expect(normalizeSessionSectionOrderTokens(undefined)).toBeNull();
  });
});
