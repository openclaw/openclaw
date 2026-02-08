import { describe, expect, it } from "vitest";
import { classifySignalCliLogLine, validateSignalCliPath } from "./daemon.js";

describe("VULN-028: validateSignalCliPath prevents arbitrary binary execution", () => {
  it("rejects paths outside the allowlist (non-existent files)", () => {
    // Non-existent files are rejected before the allowlist check
    expect(() => validateSignalCliPath("/tmp/malicious-binary")).toThrow(
      /does not exist or is not accessible/,
    );
  });

  it("rejects relative paths", () => {
    expect(() => validateSignalCliPath("./signal-cli")).toThrow(/must be an absolute path/);
    expect(() => validateSignalCliPath("signal-cli")).toThrow(/must be an absolute path/);
  });

  it("rejects paths with directory traversal (non-existent target)", () => {
    // Directory traversal to non-existent paths fails early
    expect(() => validateSignalCliPath("/usr/local/bin/../../../tmp/evil")).toThrow(
      /does not exist or is not accessible/,
    );
  });

  it("rejects shell metacharacters in path", () => {
    expect(() => validateSignalCliPath("/usr/local/bin/signal-cli; rm -rf /")).toThrow(
      /contains invalid characters/,
    );
    expect(() => validateSignalCliPath("/usr/local/bin/$(whoami)")).toThrow(
      /contains invalid characters/,
    );
  });

  it("accepts paths in the default allowlist", () => {
    // These paths may not exist on all systems, but the function should not reject them
    // based on the allowlist check. It may throw due to file not existing.
    const allowedPaths = [
      "/usr/local/bin/signal-cli",
      "/usr/bin/signal-cli",
      "/opt/homebrew/bin/signal-cli",
    ];
    for (const testPath of allowedPaths) {
      // The function should either return the path (if file exists) or throw about
      // file not existing/not executable - but NOT about allowlist
      try {
        validateSignalCliPath(testPath);
      } catch (err) {
        expect(String(err)).not.toMatch(/not in allowlist/);
      }
    }
  });
});

describe("classifySignalCliLogLine", () => {
  it("treats INFO/DEBUG as log (even if emitted on stderr)", () => {
    expect(classifySignalCliLogLine("INFO  DaemonCommand - Started")).toBe("log");
    expect(classifySignalCliLogLine("DEBUG Something")).toBe("log");
  });

  it("treats WARN/ERROR as error", () => {
    expect(classifySignalCliLogLine("WARN  Something")).toBe("error");
    expect(classifySignalCliLogLine("WARNING Something")).toBe("error");
    expect(classifySignalCliLogLine("ERROR Something")).toBe("error");
  });

  it("treats failures without explicit severity as error", () => {
    expect(classifySignalCliLogLine("Failed to initialize HTTP Server - oops")).toBe("error");
    expect(classifySignalCliLogLine('Exception in thread "main"')).toBe("error");
  });

  it("returns null for empty lines", () => {
    expect(classifySignalCliLogLine("")).toBe(null);
    expect(classifySignalCliLogLine("   ")).toBe(null);
  });
});
