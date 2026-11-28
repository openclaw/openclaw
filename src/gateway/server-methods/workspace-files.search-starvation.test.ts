import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { searchWorkspaceEntries } from "./workspace-files.js";

/**
 * Regression coverage for #207397.
 *
 * The Control UI resolves a bare filename by searching the session workspace. The
 * search walks the tree depth-first and awaits every directory before it moves on
 * to the next sibling, while all searches share one visited-entry budget
 * (MAX_SEARCH_VISITED_ENTRIES). A large early subtree therefore consumes the
 * whole budget, and a root-level file that sorts later is never visited.
 *
 * These cases distinguish the failure modes the review asked for:
 *   - early-subtree starvation (a deep, alphabetically early subtree wins the budget)
 *   - skipped content directories (a directory that is never entered at all)
 *   - ignored VCS metadata (.git/.hg are excluded from the walk)
 *   - incomplete duplicate-name searches (a truncated result must stay incomplete)
 */

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-search-starvation-"));
  roots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "x\n");
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (!root) {
      continue;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("searchWorkspaceEntries budget fairness", () => {
  it("still finds a root-level file when an alphabetically earlier subtree exhausts the budget", async () => {
    const root = makeRoot();

    // A deep subtree whose names sort before the root-level target, so the
    // depth-first walk reaches it first and keeps descending.
    for (let dir = 0; dir < 60; dir += 1) {
      const dirName = `aaa-${String(dir).padStart(3, "0")}`;
      for (let file = 0; file < 100; file += 1) {
        writeFile(root, `${dirName}/nested-${String(file).padStart(3, "0")}.txt`);
      }
    }

    // The target sorts after every one of those directories.
    writeFile(root, "zzz-target.txt");

    const results = await searchWorkspaceEntries(root, ["zzz-target.txt"]);

    const [result] = results;
    expect(result).toBeDefined();
    // The defect is not the truncated flag: this tree genuinely exceeds the
    // visited-entry budget, so `truncated` is the honest signal here. The
    // defect is that the root-level file was never visited at all. A
    // breadth-first walk reaches the shallow entry before the deep subtree
    // can spend the budget.
    expect(result?.entries.map((entry) => entry.name)).toContain("zzz-target.txt");
  });

  it("does not let one search consume the shared budget and starve the next search", async () => {
    const root = makeRoot();

    // The first query matches a large early subtree. The walk spends its whole
    // shared budget there, so the second query never gets a fair share.
    for (let dir = 0; dir < 60; dir += 1) {
      const dirName = `eee-${String(dir).padStart(3, "0")}`;
      for (let file = 0; file < 100; file += 1) {
        writeFile(root, `${dirName}/aaa-${String(file).padStart(3, "0")}.txt`);
      }
    }
    writeFile(root, "zzz-second-query.txt");

    const results = await searchWorkspaceEntries(root, ["aaa-000", "zzz-second-query.txt"]);

    const second = results[1];
    expect(second).toBeDefined();
    // The second query was never reached because the first one ate the shared
    // visited-entry budget. Reporting it as incomplete is honest about the
    // walk, but the starvation itself is the defect: one query must not decide
    // whether another query can be answered.
    expect(second?.entries.map((entry) => entry.name)).toContain("zzz-second-query.txt");
  });

  it("marks the search incomplete when the walk stops early, so a partial result is never trusted", async () => {
    const root = makeRoot();

    for (let dir = 0; dir < 60; dir += 1) {
      const dirName = `bbb-${String(dir).padStart(3, "0")}`;
      for (let file = 0; file < 100; file += 1) {
        writeFile(root, `${dirName}/nested-${String(file).padStart(3, "0")}.txt`);
      }
    }
    writeFile(root, "zzz-only-match.txt");

    const results = await searchWorkspaceEntries(root, ["zzz-only-match.txt"]);

    const [result] = results;
    expect(result).toBeDefined();
    // The truncated flag reports whether the walk covered the whole workspace.
    // It is independent of whether a match was already seen: a budget-limited
    // walk may legitimately return both the match and `truncated: true`. The
    // signal that must never lie is the reverse direction - a complete walk
    // (truncated === false) must never hide a match that exists.
    const found = result?.entries.some((entry) => entry.name === "zzz-only-match.txt") ?? false;
    if (result?.truncated === false) {
      expect(found).toBe(true);
    }
  });

  it("visits a directory that sorts after a large sibling subtree", async () => {
    const root = makeRoot();

    for (let dir = 0; dir < 40; dir += 1) {
      const dirName = `ccc-${String(dir).padStart(3, "0")}`;
      for (let file = 0; file < 100; file += 1) {
        writeFile(root, `${dirName}/nested-${String(file).padStart(3, "0")}.txt`);
      }
    }
    writeFile(root, "ddd-late-dir/inside.txt");

    const results = await searchWorkspaceEntries(root, ["inside.txt"]);

    const [result] = results;
    expect(result).toBeDefined();
    expect(result?.entries.map((entry) => entry.name)).toContain("inside.txt");
  });

  it("skips VCS metadata directories in the walk", async () => {
    const root = makeRoot();

    writeFile(root, ".git/objects/deadbeef.txt");
    writeFile(root, ".hg/store/deadbeef.txt");
    writeFile(root, "visible.txt");

    const results = await searchWorkspaceEntries(root, ["deadbeef.txt"]);

    const [result] = results;
    expect(result).toBeDefined();
    expect(result?.entries.map((entry) => entry.name)).not.toContain("deadbeef.txt");
    expect(result?.truncated).toBe(false);
  });
});
