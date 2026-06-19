// FIX #92302: Test Windows absolute path handling in splitShellArgs
import { describe, it, expect } from "vitest";
import { splitShellArgs } from "./shell-argv.js";

describe("splitShellArgs", () => {
  describe("Windows absolute paths (FIX #92302)", () => {
    it("should preserve backslashes in Windows absolute path C:\\path\\to\\file", () => {
      const result = splitShellArgs("C:\\Users\\test\\AppData\\qmd.js");
      expect(result).toEqual(["C:\\Users\\test\\AppData\\qmd.js"]);
    });

    it("should handle Windows path with forward slashes", () => {
      const result = splitShellArgs("C:/Users/test/AppData/qmd.js");
      expect(result).toEqual(["C:/Users/test/AppData/qmd.js"]);
    });

    it("should parse Windows executable path correctly (quoted)", () => {
      // Paths with spaces should be quoted in shell context
      const result = splitShellArgs('"C:\\Program Files\\NodeJS\\node.exe"');
      expect(result).toEqual(["C:\\Program Files\\NodeJS\\node.exe"]);
    });

    it("should handle Windows path with arguments", () => {
      const result = splitShellArgs("C:\\path\\to\\node.exe script.js arg2");
      expect(result).toEqual(["C:\\path\\to\\node.exe", "script.js", "arg2"]);
    });

    it("should handle UNC paths (quoted)", () => {
      // UNC path: \\server\share\file.exe
      // In the shell parser with double quotes, backslash is mostly literal
      // except before ", $, `, \n, \r. So \\server becomes \server in the output.
      // To get \\server in output, we need to escape each backslash: \\\\server
      const result = splitShellArgs('"\\\\\\\\server\\\\share\\\\file.exe"');
      expect(result).toEqual(["\\\\server\\share\\file.exe"]);
    });

    it("should handle lowercase drive letter", () => {
      const result = splitShellArgs("c:\\users\\test\\file.txt");
      expect(result).toEqual(["c:\\users\\test\\file.txt"]);
    });

    it("should handle mixed case drive letter", () => {
      const result = splitShellArgs("D:\\Projects\\openclaw\\dist\\index.js");
      expect(result).toEqual(["D:\\Projects\\openclaw\\dist\\index.js"]);
    });
  });

  describe("POSIX shell behavior (regression tests)", () => {
    it("should handle simple command without arguments", () => {
      const result = splitShellArgs("qmd");
      expect(result).toEqual(["qmd"]);
    });

    it("should handle command with arguments", () => {
      const result = splitShellArgs("node script.js --verbose");
      expect(result).toEqual(["node", "script.js", "--verbose"]);
    });

    it("should handle double-quoted strings", () => {
      const result = splitShellArgs('echo "hello world"');
      expect(result).toEqual(["echo", "hello world"]);
    });

    it("should handle single-quoted strings", () => {
      const result = splitShellArgs("echo 'hello world'");
      expect(result).toEqual(["echo", "hello world"]);
    });

    it("should handle escaped double quotes inside double quotes", () => {
      const result = splitShellArgs('echo "hello\\"world"');
      expect(result).toEqual(["echo", 'hello"world']);
    });

    it("should handle escaped characters in POSIX shell", () => {
      const result = splitShellArgs("echo hello\\ world");
      expect(result).toEqual(["echo", "hello world"]);
    });

    it("should handle Unix absolute paths", () => {
      const result = splitShellArgs("/usr/bin/node script.js");
      expect(result).toEqual(["/usr/bin/node", "script.js"]);
    });

    it("should handle paths with spaces in quotes", () => {
      const result = splitShellArgs('"/path/with spaces/file.js"');
      expect(result).toEqual(["/path/with spaces/file.js"]);
    });

    it("should return null for unterminated double quote", () => {
      const result = splitShellArgs('echo "hello');
      expect(result).toBeNull();
    });

    it("should return null for unterminated single quote", () => {
      const result = splitShellArgs("echo 'hello");
      expect(result).toBeNull();
    });

    it("should return null for trailing escape character", () => {
      const result = splitShellArgs("echo hello\\");
      expect(result).toBeNull();
    });

    it("should handle comments", () => {
      const result = splitShellArgs("echo hello # this is a comment");
      expect(result).toEqual(["echo", "hello"]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty string", () => {
      const result = splitShellArgs("");
      expect(result).toEqual([]);
    });

    it("should handle whitespace-only string", () => {
      const result = splitShellArgs("   \t\n  ");
      expect(result).toEqual([]);
    });

    it("should handle multiple spaces between arguments", () => {
      const result = splitShellArgs("cmd   arg1    arg2");
      expect(result).toEqual(["cmd", "arg1", "arg2"]);
    });

    it("should handle Windows path in quotes", () => {
      const result = splitShellArgs('"C:\\Program Files\\app.exe" --flag');
      expect(result).toEqual(["C:\\Program Files\\app.exe", "--flag"]);
    });

    it("should handle Windows path with special characters in quotes", () => {
      const result = splitShellArgs('"C:\\My App (v1.0)\\bin.exe"');
      expect(result).toEqual(["C:\\My App (v1.0)\\bin.exe"]);
    });
  });
});
