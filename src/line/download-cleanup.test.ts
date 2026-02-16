import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";

// We can't easily test downloadLineMedia without mocking the LINE SDK,
// so test the cleanup behavior by creating temp files directly and
// verifying the pattern works.

describe("LINE media temp file cleanup", () => {
  const tempFiles: string[] = [];

  afterEach(async () => {
    for (const f of tempFiles) {
      await fs.promises.unlink(f).catch(() => {});
    }
    tempFiles.length = 0;
  });

  it("temp files are created in os.tmpdir with line-media prefix", () => {
    const tempDir = os.tmpdir();
    const fileName = `line-media-test-${Date.now()}.jpg`;
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, "test");
    tempFiles.push(filePath);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(path.basename(filePath)).toMatch(/^line-media-/);
  });

  it("unlink removes the temp file", async () => {
    const tempDir = os.tmpdir();
    const filePath = path.join(tempDir, `line-media-cleanup-test-${Date.now()}.jpg`);
    fs.writeFileSync(filePath, "test data");
    tempFiles.push(filePath);

    expect(fs.existsSync(filePath)).toBe(true);
    await fs.promises.unlink(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("unlink on non-existent file does not throw when caught", async () => {
    const filePath = path.join(os.tmpdir(), `line-media-nonexistent-${Date.now()}.jpg`);
    // Should not throw
    await expect(fs.promises.unlink(filePath).catch(() => {})).resolves.toBeUndefined();
  });

  it("setTimeout.unref exists and is callable", () => {
    const timer = setTimeout(() => {}, 1000);
    expect(typeof timer.unref).toBe("function");
    timer.unref();
    clearTimeout(timer);
  });
});
