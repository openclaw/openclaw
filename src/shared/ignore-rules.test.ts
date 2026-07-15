import { mkdirSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addIgnoreRules } from "./ignore-rules.js";

describe("addIgnoreRules", () => {
  it("skips missing ignore files silently", () => {
    const ig = addIgnoreRules(join(tmpdir(), `ignore-rules-test-missing-${Date.now()}`), "/");
    expect(ig).toBeTruthy();
  });

  it("reads and applies .gitignore patterns", () => {
    const dir = join(tmpdir(), `ignore-rules-test-read-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".gitignore"), "node_modules\ndist\n");
      const ig = addIgnoreRules(dir, dir);
      expect(ig.ignores("node_modules")).toBe(true);
      expect(ig.ignores("dist")).toBe(true);
      expect(ig.ignores("src")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-throws non-ENOENT errors such as EACCES", () => {
    // chmod 0 has no effect for root or on Windows.
    if (process.platform === "win32" || (process.getuid && process.getuid() === 0)) {
      return;
    }
    const dir = join(tmpdir(), `ignore-rules-test-eacces-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      const ignorePath = join(dir, ".gitignore");
      writeFileSync(ignorePath, "secret\n");
      chmodSync(ignorePath, 0o000);
      expect(() => addIgnoreRules(dir, dir)).toThrow();
    } finally {
      // Restore permissions so cleanup can delete the file.
      try {
        chmodSync(join(dir, ".gitignore"), 0o644);
      } catch {
        // already gone
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
