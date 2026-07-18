// Shared ignore-rules tests cover workspace ignore-file scanning.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("node_modules/foo")).toBe(true);
    expect(ig.ignores("dist/bar.js")).toBe(true);
    expect(ig.ignores("src/main.ts")).toBe(false);
  });

  it("parses a large ignore file under the byte cap", () => {
    const huge = "ignored-file\n".repeat(200_000); // ~2.4 MB, under 4 MB cap
    fs.writeFileSync(path.join(tempDir, ".gitignore"), huge, "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("ignored-file")).toBe(true);
  });

  it("fails closed and excludes the subtree when an ignore file exceeds the byte cap", () => {
    const oversized = "ignored-file\n".repeat(1_000_000); // ~13 MB, over 4 MB cap
    fs.writeFileSync(path.join(tempDir, ".gitignore"), oversized, "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("ignored-file")).toBe(true);
  });

  it("fails closed before an under-cap file can amplify into too many rules", () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "a\n".repeat(20_001), "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("unrelated-file")).toBe(true);
  });

  it("enforces the rule-count budget across ignore files", () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "a\n".repeat(10_000), "utf-8");
    fs.writeFileSync(path.join(tempDir, ".ignore"), "b\n".repeat(10_001), "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("unrelated-file")).toBe(true);
  });

  it("fails closed before compiling an excessively long pattern", () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "a".repeat(16 * 1024 + 1), "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("unrelated-file")).toBe(true);
  });

  it("counts directory prefixes toward the compiled-pattern budget", () => {
    const first = "a".repeat(150);
    const second = "b".repeat(150);
    const nestedDir = path.join(tempDir, first, second);
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, ".gitignore"), "x\n".repeat(20_000), "utf-8");

    const ig = addIgnoreRules(nestedDir, tempDir);

    expect(ig.ignores(`${first}/${second}`)).toBe(true);
    expect(ig.ignores(`${first}/${second}/secret.txt`)).toBe(true);
  });

  it("keeps the subtree excluded when a later ignore file negates it", () => {
    const oversized = "ignored-file\n".repeat(1_000_000); // ~13 MB, over 4 MB cap
    fs.writeFileSync(path.join(tempDir, ".gitignore"), oversized, "utf-8");
    // A later .ignore could reopen the subtree if the oversized-file exclusion
    // were not terminal for this directory.
    fs.writeFileSync(path.join(tempDir, ".ignore"), "!ignored-file\n!secret.txt\n", "utf-8");

    const ig = addIgnoreRules(tempDir, tempDir);

    expect(ig.ignores("ignored-file")).toBe(true);
    expect(ig.ignores("secret.txt")).toBe(true);
  });

  it("treats fail-closed subtree paths literally", () => {
    const oversized = "ignored-file\n".repeat(1_000_000); // ~13 MB, over 4 MB cap
    const unusualNames = [
      "#private",
      "!private",
      "[private]",
      ...(process.platform === "win32" ? [] : ["private?docs", "private*docs"]),
    ];
    let ig: ReturnType<typeof addIgnoreRules> | undefined;

    for (const name of unusualNames) {
      const nestedDir = path.join(tempDir, name);
      fs.mkdirSync(nestedDir);
      fs.writeFileSync(path.join(nestedDir, ".gitignore"), oversized, "utf-8");
      ig = addIgnoreRules(nestedDir, tempDir, ig);

      expect(ig.ignores(name)).toBe(true);
      expect(ig.ignores(`${name}/secret.txt`)).toBe(true);
      expect(ig.ignores([name, "nested", "secret.txt"].join(path.sep))).toBe(true);
    }

    if (!ig) {
      throw new Error("expected ignore matcher");
    }
    expect(ig.ignores("public/secret.txt")).toBe(false);
    if (process.platform !== "win32") {
      expect(ig.ignores("#private\\secret.txt")).toBe(false);
    }
  });

  it("keeps fail-closed metadata when the matcher is extended", () => {
    const nestedDir = path.join(tempDir, "locked");
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(
      path.join(nestedDir, ".gitignore"),
      "ignored-file\n".repeat(1_000_000),
      "utf-8",
    );
    const ig = addIgnoreRules(nestedDir, tempDir);

    fs.writeFileSync(path.join(tempDir, ".gitignore"), "!locked/\n!locked/secret.txt\n", "utf-8");
    addIgnoreRules(tempDir, tempDir, ig);

    expect(ig.ignores("locked")).toBe(true);
    expect(ig.ignores("locked/secret.txt")).toBe(true);
  });

  it("follows a symlinked .gitignore to a regular file", () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ignore-rules-real-"));
    try {
      fs.writeFileSync(path.join(realDir, "real.gitignore"), "node_modules/\n", "utf-8");
      fs.symlinkSync(path.join(realDir, "real.gitignore"), path.join(tempDir, ".gitignore"));

      const ig = addIgnoreRules(tempDir, tempDir);

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

      const ig = addIgnoreRules(tempDir, tempDir);

      expect(ig.ignores("node_modules/foo")).toBe(true);
    } finally {
      fs.rmSync(realDir, { force: true, recursive: true });
    }
  });
});
