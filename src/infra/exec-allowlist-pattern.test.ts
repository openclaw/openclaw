import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchesExecAllowlistPattern } from "./exec-allowlist-pattern.js";

describe("matchesExecAllowlistPattern", () => {
  it.each([
    { pattern: "", target: "/tmp/tool", expected: false },
    { pattern: "   ", target: "/tmp/tool", expected: false },
    { pattern: "/tmp/tool", target: "/tmp/tool", expected: true },
  ])("handles literal patterns for %j", ({ pattern, target, expected }) => {
    expect(matchesExecAllowlistPattern(pattern, target)).toBe(expected);
  });

  it("does not let ? cross path separators", () => {
    expect(matchesExecAllowlistPattern("/tmp/a?b", "/tmp/a/b")).toBe(false);
    expect(matchesExecAllowlistPattern("/tmp/a?b", "/tmp/acb")).toBe(true);
  });

  it.each([
    { pattern: "/tmp/*/tool", target: "/tmp/a/tool", expected: true },
    { pattern: "/tmp/*/tool", target: "/tmp/a/b/tool", expected: false },
    { pattern: "/tmp/**/tool", target: "/tmp/a/b/tool", expected: true },
  ])("handles star patterns for %j", ({ pattern, target, expected }) => {
    expect(matchesExecAllowlistPattern(pattern, target)).toBe(expected);
  });

  it("expands home-prefix patterns", () => {
    const prevOpenClawHome = process.env.OPENCLAW_HOME;
    const prevHome = process.env.HOME;
    process.env.OPENCLAW_HOME = "/srv/openclaw-home";
    process.env.HOME = "/home/other";
    const openClawHome = path.join(path.resolve("/srv/openclaw-home"), "bin", "tool");
    const fallbackHome = path.join(path.resolve("/home/other"), "bin", "tool");
    try {
      expect(matchesExecAllowlistPattern("~/bin/tool", openClawHome)).toBe(true);
      expect(matchesExecAllowlistPattern("~/bin/tool", fallbackHome)).toBe(false);
    } finally {
      if (prevOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = prevOpenClawHome;
      }
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  it.runIf(process.platform !== "win32")("preserves case sensitivity on POSIX", () => {
    expect(matchesExecAllowlistPattern("/tmp/Allowed-Tool", "/tmp/allowed-tool")).toBe(false);
    expect(matchesExecAllowlistPattern("/tmp/Allowed-Tool", "/tmp/Allowed-Tool")).toBe(true);
  });

  it.runIf(process.platform === "win32")("preserves case-insensitive matching on Windows", () => {
    expect(matchesExecAllowlistPattern("C:/Tools/Allowed-Tool", "c:/tools/allowed-tool")).toBe(
      true,
    );
  });
});
