// Shared ignore-rules tests cover workspace ignore-file scanning.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ignore from "ignore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("parses a large ignore file under the byte cap", () => {
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

  it("keeps the subtree excluded when a later ignore file negates it", () => {
    const oversized = "ignored-file\n".repeat(1_000_000); // ~13 MB, over 4 MB cap
    fs.writeFileSync(path.join(tempDir, ".gitignore"), oversized, "utf-8");
    // A later .ignore could reopen the subtree if the oversized-file exclusion
    // were not terminal for this directory.
    fs.writeFileSync(path.join(tempDir, ".ignore"), "!ignored-file\n!secret.txt\n", "utf-8");

    const ig = ignore();
    addIgnoreRules(tempDir, tempDir, ig);

    expect(ig.ignores("ignored-file")).toBe(true);
    expect(ig.ignores("secret.txt")).toBe(true);
  });

  it("treats fail-closed subtree paths literally", () => {
    const oversized = "ignored-file\n".repeat(1_000_000); // ~13 MB, over 4 MB cap
    const unusualNames = ["#private", "!private", "[private]", "private?docs", "private*docs"];
    let ig = ignore();

    for (const name of unusualNames) {
      const nestedDir = path.join(tempDir, name);
      fs.mkdirSync(nestedDir);
      fs.writeFileSync(path.join(nestedDir, ".gitignore"), oversized, "utf-8");
      ig = addIgnoreRules(nestedDir, tempDir, ig);

      expect(ig.ignores(`${name}/secret.txt`)).toBe(true);
    }

    expect(ig.ignores("public/secret.txt")).toBe(false);
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
