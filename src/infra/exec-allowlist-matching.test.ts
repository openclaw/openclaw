// Covers exec allowlist pattern matching.
import { describe, expect, it, vi } from "vitest";
import { matchAllowlist, type ExecAllowlistEntry } from "./exec-approvals.js";

function executable(
  rawExecutable: string,
  resolvedPath = rawExecutable,
  resolvedRealPath?: string,
) {
  return {
    kind: "executable" as const,
    rawExecutable,
    resolvedPath,
    ...(resolvedRealPath ? { resolvedRealPath } : {}),
    executableName: rawExecutable.split("/").at(-1) ?? rawExecutable,
  };
}

describe("exec allowlist matching", () => {
  const baseResolution = executable("rg", "/opt/homebrew/bin/rg");

  it("prepares a revision's patterns once and follows replaced or edited entries", () => {
    const entry: ExecAllowlistEntry = { pattern: "/opt/**/r?" };
    const entries = [entry];
    expect(matchAllowlist(entries, baseResolution)).toBe(entry);
    const replace = vi.spyOn(String.prototype, "replace");
    let repeatedPatternWork: number;
    try {
      for (let index = 0; index < 10; index++) {
        expect(matchAllowlist(entries, baseResolution)).toBe(entry);
      }
      repeatedPatternWork = replace.mock.contexts.filter((value) => value === entry.pattern).length;
    } finally {
      replace.mockRestore();
    }
    expect(repeatedPatternWork).toBe(0);
    entries[0] = { pattern: "/revoked/**" };
    expect(matchAllowlist(entries, baseResolution)).toBeNull();
    entry.pattern = "/revoked/**";
    expect(matchAllowlist([entry], baseResolution)).toBeNull();
    entry.pattern = "r?";
    expect(matchAllowlist([entry], baseResolution)).toBe(entry);
    entry.argPattern = "^--files$";
    expect(matchAllowlist([entry], baseResolution, ["rg", "--json"])).toBeNull();
    expect(matchAllowlist([entry], baseResolution, ["rg", "--files"])).toBe(entry);
    entry.argPattern = "[invalid";
    expect(matchAllowlist([entry], baseResolution, ["rg", "--files"])).toBeNull();
  });

  it("handles wildcard and path matching semantics", () => {
    const cases = [
      ["RG", null],
      ["not-rg", null],
      ["/opt/**/rg", "/opt/**/rg"],
      ["/opt/*/rg", null],
    ] as const;
    for (const [pattern, expectedPattern] of cases) {
      const match = matchAllowlist([{ pattern }], baseResolution);
      expect(match?.pattern ?? null).toBe(expectedPattern);
    }
  });

  it("matches bare command-name patterns against PATH-resolved executable basenames", () => {
    expect(matchAllowlist([{ pattern: "rg" }], baseResolution)?.pattern).toBe("rg");
    expect(matchAllowlist([{ pattern: "r?" }], baseResolution)?.pattern).toBe("r?");
    expect(matchAllowlist([{ pattern: "homebrew" }], baseResolution)).toBeNull();
  });

  it("does not let bare command-name patterns match path-selected executables", () => {
    const relativeResolution = executable("./rg", "/tmp/openclaw-workspace/rg");
    const absoluteResolution = executable("/tmp/openclaw-workspace/rg");

    expect(matchAllowlist([{ pattern: "rg" }], relativeResolution)).toBeNull();
    expect(matchAllowlist([{ pattern: "rg" }], absoluteResolution)).toBeNull();
  });

  it.each(["win32"])("honors argPattern checks for bare command-name matches on %s", (platform) => {
    const entries = [{ pattern: "rg", argPattern: "^--json$" }];

    expect(matchAllowlist(entries, baseResolution, ["rg", "--json"], platform)?.pattern).toBe("rg");
    expect(matchAllowlist(entries, baseResolution, ["rg", "--files"], platform)).toBeNull();
  });

  describe("argPattern path matches", () => {
    const resolution = executable("python3", "/usr/bin/python3", "/usr/bin/python3");

    it("ignores legacy generated path-only allow-always entries", () => {
      const legacyGenerated = { pattern: "/usr/bin/python3", source: "allow-always" as const };
      const manual = { pattern: "/usr/bin/python3" };

      expect(matchAllowlist([legacyGenerated], resolution, ["python3", "b.py"])).toBeNull();
      expect(matchAllowlist([manual], resolution, ["python3", "b.py"])).toBe(manual);
    });

    it("does not discard redirect-shaped direct argv literals", () => {
      const restricted = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
      const explicit = { pattern: "/usr/bin/python3", argPattern: "^a\\.py 2>/dev/null$" };
      const argv = ["python3", "a.py", "2>/dev/null"];

      expect(matchAllowlist([restricted], resolution, argv)).toBeNull();
      expect(matchAllowlist([explicit], resolution, argv)).toBe(explicit);
    });

    it.each(["win32"])("requires argv before matching argPattern entries on %s", (platform) => {
      const restricted = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
      const manual = { pattern: "/usr/bin/python3" };
      expect(matchAllowlist([restricted], resolution, undefined, platform)).toBeNull();
      expect(matchAllowlist([restricted, manual], resolution, undefined, platform)).toBe(manual);
    });

    it("handles invalid regex gracefully", () => {
      const entries: ExecAllowlistEntry[] = [
        { pattern: "/usr/bin/python3", argPattern: "[invalid" },
      ];

      expect(matchAllowlist(entries, resolution, ["python3", "a.py"])).toBeNull();
    });

    it("rejects split-arg bypasses against single-arg auto-generated argPattern", () => {
      const entry = { pattern: "/usr/bin/python3", argPattern: "^hello world\x00$" };
      const entries: ExecAllowlistEntry[] = [entry];

      expect(matchAllowlist(entries, resolution, ["python3", "hello world"])).toBe(entry);
      expect(matchAllowlist(entries, resolution, ["python3", "hello", "world"])).toBeNull();
    });

    it("distinguishes zero-arg patterns from one-empty-string-arg patterns", () => {
      const zeroArgEntry = { pattern: "/usr/bin/python3", argPattern: "^\x00\x00$" };
      const emptyArgEntry = { pattern: "/usr/bin/python3", argPattern: "^\x00$" };

      expect(matchAllowlist([zeroArgEntry], resolution, ["python3"])).toBe(zeroArgEntry);
      expect(matchAllowlist([emptyArgEntry], resolution, ["python3"])).toBeNull();
      expect(matchAllowlist([emptyArgEntry], resolution, ["python3", ""])).toBe(emptyArgEntry);
      expect(matchAllowlist([zeroArgEntry], resolution, ["python3", ""])).toBeNull();
    });
  });

  it("matches bare wildcard patterns against arbitrary resolved executables", () => {
    const cases = [baseResolution, executable("python3", "/usr/bin/python3")] as const;
    for (const resolution of cases) {
      expect(matchAllowlist([{ pattern: "*" }], resolution)?.pattern).toBe("*");
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects wildcard path matches that escape through dot segments",
    () => {
      expect(
        matchAllowlist([{ pattern: "/usr/bin/**" }], executable("/usr/bin/../../bin/sh")),
      ).toBeNull();
      expect(
        matchAllowlist([{ pattern: "/usr/bin/**" }], executable("/usr/bin/sub/../env"))?.pattern,
      ).toBe("/usr/bin/**");
    },
  );

  it("matches absolute paths containing regex metacharacters literally", () => {
    const plusPathCases = ["/usr/bin/g++", "/usr/bin/clang++"] as const;
    for (const candidatePath of plusPathCases) {
      const match = matchAllowlist([{ pattern: candidatePath }], executable(candidatePath));
      expect(match?.pattern).toBe(candidatePath);
    }

    const literalCases = [
      { pattern: "/usr/bin/*++", resolution: executable("/usr/bin/g++") },
      {
        pattern: "/opt/builds/tool[1](stable)",
        resolution: executable("/opt/builds/tool[1](stable)"),
      },
    ] as const;
    for (const { pattern, resolution } of literalCases) {
      expect(matchAllowlist([{ pattern }], resolution)?.pattern).toBe(pattern);
    }
  });

  it("matches path-shaped allowlist entries against the executable trust realpath", () => {
    const resolution = executable(
      "rg",
      "/opt/homebrew/bin/rg",
      "/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg",
    );

    expect(
      matchAllowlist([{ pattern: "/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg" }], resolution)
        ?.pattern,
    ).toBe("/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg");
    expect(matchAllowlist([{ pattern: "/opt/homebrew/bin/rg" }], resolution)).toBeNull();
  });
});
