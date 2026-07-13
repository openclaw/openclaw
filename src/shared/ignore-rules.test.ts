import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { addIgnoreRules } from "./ignore-rules.js";

function writeIgnoreTree(root: string, rules: string, dir = root) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), rules);
}

function buildMatcher(root: string, dir: string) {
  const ig = ignore();
  addIgnoreRules(ig, join(root, dir), root);
  return ig;
}

describe("addIgnoreRules", () => {
  it("ignores nested slash-free patterns at any depth", () => {
    const root = join(tmpdir(), "ignore-rules-test-1");
    writeIgnoreTree(root, "*.log\n", join(root, "sub"));
    writeFileSync(join(root, "sub", "y.log"), "");
    mkdirSync(join(root, "sub", "deep"), { recursive: true });
    writeFileSync(join(root, "sub", "deep", "x.log"), "");

    const ig = buildMatcher(root, "sub");

    expect(ig.ignores("sub/y.log")).toBe(true);
    expect(ig.ignores("sub/deep/x.log")).toBe(true);
  });

  it("keeps anchored patterns relative to the ignore file directory", () => {
    const root = join(tmpdir(), "ignore-rules-test-2");
    writeIgnoreTree(root, "dir/*.log\n", join(root, "sub"));
    mkdirSync(join(root, "sub", "dir"), { recursive: true });
    writeFileSync(join(root, "sub", "dir", "x.log"), "");
    mkdirSync(join(root, "sub", "other"), { recursive: true });
    writeFileSync(join(root, "sub", "other", "x.log"), "");

    const ig = buildMatcher(root, "sub");

    expect(ig.ignores("sub/dir/x.log")).toBe(true);
    expect(ig.ignores("sub/other/x.log")).toBe(false);
  });

  it("keeps leading-slash patterns relative to the ignore file directory", () => {
    const root = join(tmpdir(), "ignore-rules-test-3");
    writeIgnoreTree(root, "/dir/*.log\n", join(root, "sub"));
    mkdirSync(join(root, "sub", "dir"), { recursive: true });
    writeFileSync(join(root, "sub", "dir", "x.log"), "");

    const ig = buildMatcher(root, "sub");

    expect(ig.ignores("sub/dir/x.log")).toBe(true);
  });

  it("treats trailing-slash directory patterns as unanchored", () => {
    const root = join(tmpdir(), "ignore-rules-test-4");
    writeIgnoreTree(root, "node_modules/\n", join(root, "sub"));
    mkdirSync(join(root, "sub", "node_modules"), { recursive: true });
    mkdirSync(join(root, "sub", "deep", "node_modules"), { recursive: true });

    const ig = buildMatcher(root, "sub");

    expect(ig.ignores("sub/node_modules/file.js")).toBe(true);
    expect(ig.ignores("sub/deep/node_modules/file.js")).toBe(true);
  });

  it("does not corrupt escaped ! patterns at the root", () => {
    const root = join(tmpdir(), "ignore-rules-test-5");
    writeIgnoreTree(root, "*.txt\n\\!keep.txt\n");
    writeFileSync(join(root, "keep.txt"), "");
    writeFileSync(join(root, "!keep.txt"), "");
    writeFileSync(join(root, "drop.txt"), "");

    const ig = buildMatcher(root, "");

    expect(ig.ignores("keep.txt")).toBe(true);
    expect(ig.ignores("!keep.txt")).toBe(true);
    expect(ig.ignores("drop.txt")).toBe(true);
  });

  it("does not corrupt escaped ! patterns in nested directories", () => {
    const root = join(tmpdir(), "ignore-rules-test-6");
    writeIgnoreTree(root, "*.txt\n\\!keep.txt\n", join(root, "sub"));
    writeFileSync(join(root, "sub", "keep.txt"), "");
    writeFileSync(join(root, "sub", "!keep.txt"), "");
    writeFileSync(join(root, "sub", "drop.txt"), "");

    const ig = buildMatcher(root, "sub");

    expect(ig.ignores("sub/keep.txt")).toBe(true);
    expect(ig.ignores("sub/!keep.txt")).toBe(true);
    expect(ig.ignores("sub/drop.txt")).toBe(true);
  });
});
