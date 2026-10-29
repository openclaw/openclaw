import { describe, expect, it } from "vitest";
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
  const pathMatch = (pattern: string, resolution = baseResolution) =>
    matchAllowlist([{ pattern }], resolution)?.pattern ?? null;

  it("follows replaced or edited allowlist entries", () => {
    const entry: ExecAllowlistEntry = { pattern: "/opt/**/r?" };
    const entries = [entry];
    expect(matchAllowlist(entries, baseResolution)).toBe(entry);
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

  it.each([
    ["RG", baseResolution, null],
    ["not-rg", baseResolution, null],
    ["/opt/**/rg", baseResolution, "/opt/**/rg"],
    ["/opt/*/rg", baseResolution, null],
    ["rg", baseResolution, "rg"],
    ["r?", baseResolution, "r?"],
    ["homebrew", baseResolution, null],
    ["rg", executable("./rg", "/tmp/openclaw-workspace/rg"), null],
    ["rg", executable("/tmp/openclaw-workspace/rg"), null],
    ["*", baseResolution, "*"],
    ["/usr/bin/g++", executable("/usr/bin/g++"), "/usr/bin/g++"],
    ["/usr/bin/*++", executable("/usr/bin/g++"), "/usr/bin/*++"],
    ["/opt/tool[1](stable)", executable("/opt/tool[1](stable)"), "/opt/tool[1](stable)"],
  ] as const)("matches %s against %j as %s", (pattern, resolution, expected) => {
    expect(pathMatch(pattern, resolution)).toBe(expected);
  });

  it("honors argPattern checks for bare command-name matches on win32", () => {
    const entries = [{ pattern: "rg", argPattern: "^--json$" }];

    expect(matchAllowlist(entries, baseResolution, ["rg", "--json"], "win32")?.pattern).toBe("rg");
    expect(matchAllowlist(entries, baseResolution, ["rg", "--files"], "win32")).toBeNull();
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

    it("requires argv before matching argPattern entries on win32", () => {
      const restricted = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
      const manual = { pattern: "/usr/bin/python3" };
      expect(matchAllowlist([restricted], resolution, undefined, "win32")).toBeNull();
      expect(matchAllowlist([restricted, manual], resolution, undefined, "win32")).toBe(manual);
    });

    it("rejects split-arg bypasses against single-arg auto-generated argPattern", () => {
      const entry = { pattern: "/usr/bin/python3", argPattern: "^hello world\x00$" };
      expect(matchAllowlist([entry], resolution, ["python3", "hello world"])).toBe(entry);
      expect(matchAllowlist([entry], resolution, ["python3", "hello", "world"])).toBeNull();
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

  it("matches path-shaped allowlist entries against the executable trust realpath", () => {
    const resolution = executable(
      "rg",
      "/opt/homebrew/bin/rg",
      "/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg",
    );

    const realpath = "/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg";
    expect(pathMatch(realpath, resolution)).toBe(realpath);
    expect(pathMatch("/opt/homebrew/bin/rg", resolution)).toBeNull();
  });
});
