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
    addIgnoreRules(ig, tempDir, tempDir);

    expect(ig.ignores("node_modules/foo")).toBe(true);
    expect(ig.ignores("dist/bar.js")).toBe(true);
    expect(ig.ignores("src/main.ts")).toBe(false);
  });

  it("silently skips an oversized ignore file instead of buffering it", () => {
    const huge = "ignored-file\n".repeat(200_000); // ~2.4 MB, under 4 MB cap
    fs.writeFileSync(path.join(tempDir, ".gitignore"), huge, "utf-8");

    const ig = ignore();
    addIgnoreRules(ig, tempDir, tempDir);

    expect(ig.ignores("ignored-file")).toBe(true);
  });

  it("silently skips a ignore file that exceeds the byte cap", () => {
    const oversized = "ignored-file\n".repeat(1_000_000); // ~13 MB, over 4 MB cap
    fs.writeFileSync(path.join(tempDir, ".gitignore"), oversized, "utf-8");

    const ig = ignore();
    addIgnoreRules(ig, tempDir, tempDir);

    expect(ig.ignores("ignored-file")).toBe(false);
  });
});
