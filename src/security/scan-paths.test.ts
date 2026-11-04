// Covers security scan path normalization and exclusion behavior.
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathInsideWithRealpath } from "./scan-paths.js";

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
});
