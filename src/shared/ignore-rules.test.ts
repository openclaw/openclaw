// Shared ignore-rules tests cover workspace ignore-file scanning.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ignore from "ignore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillsFromDir } from "../skills/loading/session.js";
import { addIgnoreRules } from "./ignore-rules.js";

describe("addIgnoreRules", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ignore-rules-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("loads patterns from a .gitignore file", () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "node_modules/\ndist/\n", "utf-8");

    const ig = ignore();
    addIgnoreRules(tempDir, tempDir, ig);

    expect(ig.ignores("node_modules/foo")).toBe(true);
    expect(ig.ignores("dist/bar.js")).toBe(true);
    expect(ig.ignores("src/main.ts")).toBe(false);
  });

  it("silently skips an oversized ignore file instead of buffering it", () => {
    const huge = "ignored-file\n".repeat(200_000); // ~2.4 MB, under 4 MB cap
    fs.writeFileSync(path.join(tempDir, ".gitignore"), huge, "utf-8");

    const ig = ignore();
    addIgnoreRules(tempDir, tempDir, ig);

    expect(ig.ignores("ignored-file")).toBe(true);
  });

  it("fails closed and excludes the subtree when an ignore file exceeds the byte cap", () => {
    const oversized = "ignored-file\n".repeat(1_000_000); // ~13 MB, over 4 MB cap
    fs.writeFileSync(path.join(tempDir, ".gitignore"), oversized, "utf-8");

    const ig = ignore();
    addIgnoreRules(tempDir, tempDir, ig);

    expect(ig.ignores("ignored-file")).toBe(true);
  });

  it("does not discover a skill when an oversized .gitignore cannot be parsed", () => {
    const skillDir = path.join(tempDir, "ignored-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: ignored-skill\ndescription: hidden by gitignore\n---\n# Body\n",
      "utf-8",
    );
    const oversized = "ignored-skill/\n".repeat(400_000); // ~5.6 MB, over 4 MB cap
    fs.writeFileSync(path.join(tempDir, ".gitignore"), oversized, "utf-8");

    const result = loadSkillsFromDir({ dir: tempDir, source: "test" });

    expect(result.skills).toEqual([]);
  });

  it("follows a symlinked .gitignore to a regular file", () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ignore-rules-real-"));
    try {
      fs.writeFileSync(path.join(realDir, "real.gitignore"), "node_modules/\n", "utf-8");
      fs.symlinkSync(path.join(realDir, "real.gitignore"), path.join(tempDir, ".gitignore"));

      const ig = ignore();
      addIgnoreRules(tempDir, tempDir, ig);

      expect(ig.ignores("node_modules/foo")).toBe(true);
    } finally {
      fs.rmSync(realDir, { force: true, recursive: true });
    }
  });

  it("follows a chain of symlinks to the final regular .gitignore", () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ignore-rules-real-"));
    try {
      fs.writeFileSync(path.join(realDir, "real.gitignore"), "node_modules/\n", "utf-8");
      const linkA = path.join(realDir, "link-a");
      const linkB = path.join(realDir, "link-b");
      fs.symlinkSync(path.join(realDir, "real.gitignore"), linkA);
      fs.symlinkSync(linkA, linkB);
      fs.symlinkSync(linkB, path.join(tempDir, ".gitignore"));

      const ig = ignore();
      addIgnoreRules(tempDir, tempDir, ig);

      expect(ig.ignores("node_modules/foo")).toBe(true);
    } finally {
      fs.rmSync(realDir, { force: true, recursive: true });
    }
  });
});
