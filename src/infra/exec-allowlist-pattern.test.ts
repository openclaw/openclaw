// Verifies exec approval allowlist pattern parsing and matching.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { compileExecAllowlistPattern } from "./exec-allowlist-pattern.js";

function matchesExecAllowlistPattern(pattern: string, target: string) {
  return compileExecAllowlistPattern(pattern)(target);
}

describe("matchesExecAllowlistPattern", () => {
  it.each([{ pattern: "   ", target: "/tmp/tool", expected: false }])(
    "handles literal patterns for %j",
    ({ pattern, target, expected }) => {
      expect(matchesExecAllowlistPattern(pattern, target)).toBe(expected);
    },
  );

  it("does not let ? cross path separators", () => {
    expect(matchesExecAllowlistPattern("/tmp/a?b", "/tmp/a/b")).toBe(false);
    expect(matchesExecAllowlistPattern("/tmp/a?b", "/tmp/acb")).toBe(true);
  });

  it.each([
    ["/usr/bin/../sh", false],
    ["/usr/bin/sub/../../sh", false],
    ["/usr/bin/sub/../tool", true],
    ["/usr/bin/./tool", true],
    ["/usr/bin/tool..", true],
    ["/usr/bin/.tool", true],
    ["/usr/bin/.../tool", true],
    ["/usr//bin/.\n", false],
    ["/usr//bin/..\n", false],
  ] as const)("preserves wildcard path boundaries for %s", (target, expected) => {
    expect(matchesExecAllowlistPattern("/usr/bin/**", target)).toBe(expected);
  });

  it("expands home-prefix patterns", () => {
    const matches = compileExecAllowlistPattern("~/bin/tool");
    const openClawHome = path.join(path.resolve("/srv/openclaw-home"), "bin", "tool");
    const fallbackHome = path.join(path.resolve("/home/other"), "bin", "tool");
    withEnv({ OPENCLAW_HOME: "/srv/openclaw-home", HOME: "/home/other" }, () => {
      expect(matchesExecAllowlistPattern("~/bin/tool", openClawHome)).toBe(true);
      expect(matchesExecAllowlistPattern("~/bin/tool", fallbackHome)).toBe(false);
      expect(matches(openClawHome)).toBe(true);
    });
    withEnv({ OPENCLAW_HOME: "/home/other", HOME: "/home/other" }, () => {
      expect(matches(openClawHome)).toBe(false);
      expect(matches(fallbackHome)).toBe(true);
    });
  });

  it.runIf(process.platform === "darwin")("matches macOS /private/var temp aliases", () => {
    expect(
      matchesExecAllowlistPattern(
        "/var/folders/example/bin/tool",
        "/private/var/folders/example/bin/tool",
      ),
    ).toBe(true);
    expect(
      matchesExecAllowlistPattern(
        "/private/var/folders/example/bin/tool",
        "/var/folders/example/bin/tool",
      ),
    ).toBe(true);
  });

  it.runIf(process.platform === "win32")("preserves case-insensitive matching on Windows", () => {
    expect(matchesExecAllowlistPattern("C:/Tools/Allowed-Tool", "c:/tools/allowed-tool")).toBe(
      true,
    );
  });

  it.runIf(process.platform === "win32")(
    "matches Windows wildcard paths after collapsing dot segments",
    () => {
      expect(
        matchesExecAllowlistPattern("C:/Tools/**", "C:/Tools/../../Windows/System32/cmd.exe"),
      ).toBe(false);
      expect(matchesExecAllowlistPattern("C:/Tools/**", String.raw`..\..\Windows\cmd.exe`)).toBe(
        false,
      );
      expect(matchesExecAllowlistPattern("C:/Tools/**", "C:/Tools/bin/../runner.exe")).toBe(true);
    },
  );
});
