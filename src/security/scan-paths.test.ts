// Covers security scan path normalization and exclusion behavior.
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extensionUsesSkippedScannerPath, isPathInsideWithRealpath } from "./scan-paths.js";

describe("isPathInsideWithRealpath", () => {
  const tmpDir = os.tmpdir();

  it("returns true when both paths exist and candidate is inside base", () => {
    const result = isPathInsideWithRealpath(tmpDir, tmpDir);
    expect(result).toBe(true);
  });

  it("rejects candidates outside the base", () => {
    const result = isPathInsideWithRealpath(tmpDir, "/etc");
    expect(result).toBe(false);
  });

  it("returns false (safe default) when realpath fails for non-existent candidate", () => {
    const nonExistent = path.join(tmpDir, "__does_not_exist_clawin_test__");
    const result = isPathInsideWithRealpath(tmpDir, nonExistent);
    expect(result).toBe(false);
  });

  it("returns true (explicit opt-out) when requireRealpath is false and realpath fails", () => {
    const nonExistent = path.join(tmpDir, "__does_not_exist_clawin_test__");
    const result = isPathInsideWithRealpath(tmpDir, nonExistent, { requireRealpath: false });
    expect(result).toBe(true);
  });

  it("returns false (safe default) when realpath fails for base path", () => {
    const nonExistentBase = path.join(tmpDir, "__nonexistent_base__");
    const child = path.join(nonExistentBase, "child.ts");
    const result = isPathInsideWithRealpath(nonExistentBase, child);
    expect(result).toBe(false);
  });
});

describe("extensionUsesSkippedScannerPath", () => {
  it("returns true for node_modules segment", () => {
    expect(extensionUsesSkippedScannerPath("src/node_modules/pkg/index.js")).toBe(true);
  });

  it("returns true for hidden directory (.hidden)", () => {
    expect(extensionUsesSkippedScannerPath("src/.hidden/file.ts")).toBe(true);
  });

  it("returns false for normal paths", () => {
    expect(extensionUsesSkippedScannerPath("src/utils/helpers.ts")).toBe(false);
  });

  it("returns false for a single . segment (current dir)", () => {
    expect(extensionUsesSkippedScannerPath("./src/file.ts")).toBe(false);
  });

  it("returns false for a .. segment (parent dir)", () => {
    expect(extensionUsesSkippedScannerPath("../src/file.ts")).toBe(false);
  });

  it("returns true for Windows-style paths with node_modules", () => {
    expect(extensionUsesSkippedScannerPath("src\\node_modules\\pkg\\index.js")).toBe(true);
  });
});
