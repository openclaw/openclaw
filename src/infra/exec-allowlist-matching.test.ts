import { describe, expect, it } from "vitest";
import { matchAllowlist, type ExecAllowlistEntry } from "./exec-approvals.js";

describe("exec allowlist matching", () => {
  const baseResolution = {
    rawExecutable: "rg",
    resolvedPath: "/opt/homebrew/bin/rg",
    executableName: "rg",
  };

  it("handles wildcard and path matching semantics", () => {
    const cases: Array<{ entries: ExecAllowlistEntry[]; expectedPattern: string | null }> = [
      { entries: [{ pattern: "RG" }], expectedPattern: null },
      { entries: [{ pattern: "/opt/**/rg" }], expectedPattern: "/opt/**/rg" },
      { entries: [{ pattern: "/opt/*/rg" }], expectedPattern: null },
    ];
    for (const testCase of cases) {
      const match = matchAllowlist(testCase.entries, baseResolution);
      expect(match?.pattern ?? null).toBe(testCase.expectedPattern);
    }
  });

  it("matches bare wildcard patterns against arbitrary resolved executables", () => {
    expect(matchAllowlist([{ pattern: "*" }], baseResolution)?.pattern).toBe("*");
    expect(
      matchAllowlist([{ pattern: "*" }], {
        rawExecutable: "python3",
        resolvedPath: "/usr/bin/python3",
        executableName: "python3",
      })?.pattern,
    ).toBe("*");
  });

  it("matches absolute paths containing regex metacharacters literally", () => {
    const plusPathCases = ["/usr/bin/g++", "/usr/bin/clang++"];
    for (const candidatePath of plusPathCases) {
      const match = matchAllowlist([{ pattern: candidatePath }], {
        rawExecutable: candidatePath,
        resolvedPath: candidatePath,
        executableName: candidatePath.split("/").at(-1) ?? candidatePath,
      });
      expect(match?.pattern).toBe(candidatePath);
    }

    expect(
      matchAllowlist([{ pattern: "/usr/bin/*++" }], {
        rawExecutable: "/usr/bin/g++",
        resolvedPath: "/usr/bin/g++",
        executableName: "g++",
      })?.pattern,
    ).toBe("/usr/bin/*++");
    expect(
      matchAllowlist([{ pattern: "/opt/builds/tool[1](stable)" }], {
        rawExecutable: "/opt/builds/tool[1](stable)",
        resolvedPath: "/opt/builds/tool[1](stable)",
        executableName: "tool[1](stable)",
      })?.pattern,
    ).toBe("/opt/builds/tool[1](stable)");
  });
});
