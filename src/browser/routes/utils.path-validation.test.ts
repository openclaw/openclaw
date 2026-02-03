import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateBrowserFilePath, validateBrowserFilePaths } from "./utils.js";

/**
 * VULN-015: Browser file upload/download path validation
 *
 * Tests for path traversal prevention (CWE-22) in browser file operations.
 */

describe("VULN-015: browser file path validation", () => {
  const home = homedir();
  const cwd = process.cwd();

  describe("validateBrowserFilePath", () => {
    it("allows paths within home directory", () => {
      expect(validateBrowserFilePath(path.join(home, "file.txt"))).toBeNull();
      expect(validateBrowserFilePath(path.join(home, "Documents", "file.pdf"))).toBeNull();
      expect(validateBrowserFilePath(home)).toBeNull();
    });

    it("allows paths within current working directory", () => {
      expect(validateBrowserFilePath(path.join(cwd, "file.txt"))).toBeNull();
      expect(validateBrowserFilePath(path.join(cwd, "subdir", "file.pdf"))).toBeNull();
      expect(validateBrowserFilePath(cwd)).toBeNull();
    });

    it("rejects paths outside home and cwd", () => {
      expect(validateBrowserFilePath("/etc/passwd")).not.toBeNull();
      expect(validateBrowserFilePath("/tmp/malicious.txt")).not.toBeNull();
      expect(validateBrowserFilePath("/root/.ssh/id_rsa")).not.toBeNull();
    });

    it("rejects path traversal attempts", () => {
      expect(validateBrowserFilePath(path.join(home, "..", "etc", "passwd"))).not.toBeNull();
      expect(validateBrowserFilePath("../../../etc/passwd")).not.toBeNull();
      expect(validateBrowserFilePath(path.join(cwd, "..", "..", "etc", "passwd"))).not.toBeNull();
    });

    it("rejects empty paths", () => {
      expect(validateBrowserFilePath("")).not.toBeNull();
    });
  });

  describe("validateBrowserFilePaths", () => {
    it("validates all paths in array", () => {
      expect(
        validateBrowserFilePaths([path.join(home, "file1.txt"), path.join(home, "file2.txt")]),
      ).toBeNull();
    });

    it("rejects if any path is invalid", () => {
      expect(validateBrowserFilePaths([path.join(home, "safe.txt"), "/etc/passwd"])).not.toBeNull();
    });
  });
});
