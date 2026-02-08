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
    it("allows absolute paths within home directory", () => {
      expect(validateBrowserFilePath(path.join(home, "file.txt"))).toBeNull();
      expect(validateBrowserFilePath(path.join(home, "Documents", "file.pdf"))).toBeNull();
      expect(validateBrowserFilePath(home)).toBeNull();
    });

    it("allows absolute paths within current working directory", () => {
      expect(validateBrowserFilePath(path.join(cwd, "file.txt"))).toBeNull();
      expect(validateBrowserFilePath(path.join(cwd, "subdir", "file.pdf"))).toBeNull();
      expect(validateBrowserFilePath(cwd)).toBeNull();
    });

    it("allows paths with double dots in directory/file names (not traversal)", () => {
      // These contain ".." as part of the name, not as traversal segments
      expect(validateBrowserFilePath(path.join(home, "project..backup", "file.txt"))).toBeNull();
      expect(validateBrowserFilePath(path.join(home, "..config", "settings.json"))).toBeNull();
      expect(validateBrowserFilePath(path.join(home, "file..ext"))).toBeNull();
    });

    it("rejects paths outside home and cwd", () => {
      expect(validateBrowserFilePath("/etc/passwd")).not.toBeNull();
      expect(validateBrowserFilePath("/tmp/malicious.txt")).not.toBeNull();
      expect(validateBrowserFilePath("/root/.ssh/id_rsa")).not.toBeNull();
    });

    it("rejects path traversal attempts", () => {
      expect(validateBrowserFilePath(path.join(home, "..", "etc", "passwd"))).not.toBeNull();
      expect(validateBrowserFilePath(path.join(cwd, "..", "..", "etc", "passwd"))).not.toBeNull();
    });

    it("rejects relative paths", () => {
      expect(validateBrowserFilePath("file.txt")).toEqual("path must be absolute");
      expect(validateBrowserFilePath("../../../etc/passwd")).toEqual("path must be absolute");
      expect(validateBrowserFilePath("./downloads/file.txt")).toEqual("path must be absolute");
      expect(validateBrowserFilePath("subdir/file.txt")).toEqual("path must be absolute");
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
