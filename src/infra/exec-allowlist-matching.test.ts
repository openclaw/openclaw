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
      { entries: [{ pattern: "/opt/**/rg" }], expectedPattern: "/opt/**/rg" },
      { entries: [{ pattern: "/opt/*/rg" }], expectedPattern: null },
    ];
    for (const { entries, expectedPattern } of cases) {
      const match = matchAllowlist(entries, baseResolution);
      expect(match?.pattern ?? null).toBe(expectedPattern);
    }
  });

  it("matches bare executable name patterns without path separators", () => {
    // Exact bare name match
    expect(matchAllowlist([{ pattern: "rg" }], baseResolution)?.pattern).toBe("rg");

    // Bare name should be case-sensitive (no match for wrong case)
    expect(matchAllowlist([{ pattern: "RG" }], baseResolution)?.pattern ?? null).toBe(null);

    // Bare name matches regardless of resolved path
    const pythonResolution = {
      rawExecutable: "python3",
      resolvedPath: "/usr/bin/python3",
      executableName: "python3",
    };
    expect(matchAllowlist([{ pattern: "python3" }], pythonResolution)?.pattern).toBe("python3");

    // Bare name does not match a different executable
    expect(matchAllowlist([{ pattern: "node" }], pythonResolution)?.pattern ?? null).toBe(null);

    // On Windows, bare pattern strips .exe before matching
    const winResolution = {
      rawExecutable: "python3",
      resolvedPath: "C:\\Python39\\python3.exe",
      executableName: "python3.exe",
    };
    expect(
      matchAllowlist([{ pattern: "python3" }], winResolution, undefined, "win32")?.pattern,
    ).toBe("python3");
    expect(
      matchAllowlist([{ pattern: "python3.exe" }], winResolution, undefined, "win32")?.pattern,
    ).toBe("python3.exe");

    const winCmdResolution = {
      rawExecutable: "deploy",
      resolvedPath: "C:\\tools\\deploy.cmd",
      executableName: "deploy.cmd",
    };
    expect(
      matchAllowlist([{ pattern: "deploy" }], winCmdResolution, undefined, "win32")?.pattern,
    ).toBe("deploy");

    // On a Linux host evaluating a Windows target, case-insensitive matching
    // should use the target platform, not the host platform.
    expect(
      matchAllowlist(
        [{ pattern: "RG" }],
        { ...baseResolution, executableName: "rg" },
        undefined,
        "win32",
      )?.pattern,
    ).toBe("RG");
  });

  it("does not widen wildcard+argPattern entries into global allows", () => {
    // { pattern: "*", argPattern: "..." } should NOT match without argv on non-Windows
    const wildArgEntry = { pattern: "*", argPattern: "--safe-flag" };
    expect(matchAllowlist([wildArgEntry], baseResolution)?.pattern ?? null).toBe(null);
  });

  it("matches bare wildcard patterns against arbitrary resolved executables", () => {
    const cases = [
      baseResolution,
      {
        rawExecutable: "python3",
        resolvedPath: "/usr/bin/python3",
        executableName: "python3",
      },
    ] as const;
    for (const resolution of cases) {
      expect(matchAllowlist([{ pattern: "*" }], resolution)?.pattern).toBe("*");
    }
  });

  it("matches absolute paths containing regex metacharacters literally", () => {
    const plusPathCases = ["/usr/bin/g++", "/usr/bin/clang++"] as const;
    for (const candidatePath of plusPathCases) {
      const match = matchAllowlist([{ pattern: candidatePath }], {
        rawExecutable: candidatePath,
        resolvedPath: candidatePath,
        executableName: candidatePath.split("/").at(-1) ?? candidatePath,
      });
      expect(match?.pattern).toBe(candidatePath);
    }

    const literalCases = [
      {
        pattern: "/usr/bin/*++",
        resolution: {
          rawExecutable: "/usr/bin/g++",
          resolvedPath: "/usr/bin/g++",
          executableName: "g++",
        },
      },
      {
        pattern: "/opt/builds/tool[1](stable)",
        resolution: {
          rawExecutable: "/opt/builds/tool[1](stable)",
          resolvedPath: "/opt/builds/tool[1](stable)",
          executableName: "tool[1](stable)",
        },
      },
    ] as const;
    for (const { pattern, resolution } of literalCases) {
      expect(matchAllowlist([{ pattern }], resolution)?.pattern).toBe(pattern);
    }
  });
});
