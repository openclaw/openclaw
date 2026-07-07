// Verifies exec approval allowlist pattern parsing and matching.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  matchesExecAllowlistPattern,
  normalizeExecAllowlistPatternForAdd,
} from "./exec-allowlist-pattern.js";

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

  it.runIf(process.platform !== "win32")(
    "matches wildcard paths after collapsing dot segments",
    () => {
      expect(matchesExecAllowlistPattern("/usr/bin/**", "/usr/bin/../../bin/sh")).toBe(false);
      expect(
        matchesExecAllowlistPattern("/trusted/tools/**", "/trusted/tools/../../etc/shadow"),
      ).toBe(false);
      expect(matchesExecAllowlistPattern("/usr/bin/**", "../../etc/shadow")).toBe(false);
      expect(matchesExecAllowlistPattern("/usr/bin/**", "/usr/bin/./env")).toBe(true);
      expect(matchesExecAllowlistPattern("/usr/bin/**", "/usr/./bin/./env")).toBe(true);
      expect(matchesExecAllowlistPattern("/usr/bin/**", "/usr/bin/sub/../env")).toBe(true);
      expect(matchesExecAllowlistPattern("/usr/bin/*", "/usr/bin/sub/../env")).toBe(true);
      expect(matchesExecAllowlistPattern("/usr/bin/**", "/usr/bin/sub/tool")).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps wildcard dot-segment matches inside the declared POSIX root",
    () => {
      const bases = ["/usr/bin", "/opt/tools", "/srv/bin"] as const;
      for (const base of bases) {
        const pattern = `${base}/**`;
        expect(matchesExecAllowlistPattern(pattern, `${base}/inside/file`)).toBe(true);
        expect(matchesExecAllowlistPattern(pattern, `${base}/sub/../inside`)).toBe(true);
        expect(matchesExecAllowlistPattern(pattern, `${base}/../escape`)).toBe(false);
        expect(matchesExecAllowlistPattern(pattern, `${base}/sub/../../escape`)).toBe(false);
      }
    },
  );

  it("expands home-prefix patterns", () => {
    const openClawHome = path.join(path.resolve("/srv/openclaw-home"), "bin", "tool");
    const fallbackHome = path.join(path.resolve("/home/other"), "bin", "tool");
    withEnv({ OPENCLAW_HOME: "/srv/openclaw-home", HOME: "/home/other" }, () => {
      expect(matchesExecAllowlistPattern("~/bin/tool", openClawHome)).toBe(true);
      expect(matchesExecAllowlistPattern("~/bin/tool", fallbackHome)).toBe(false);
    });
  });

  it.runIf(process.platform !== "win32")("preserves case sensitivity on POSIX", () => {
    expect(matchesExecAllowlistPattern("/tmp/Allowed-Tool", "/tmp/allowed-tool")).toBe(false);
    expect(matchesExecAllowlistPattern("/tmp/Allowed-Tool", "/tmp/Allowed-Tool")).toBe(true);
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

describe("normalizeExecAllowlistPatternForAdd", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-allowlist-add-"));
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps bare command names and glob patterns unchanged", () => {
    expect(normalizeExecAllowlistPatternForAdd("rg")).toEqual({
      kind: "unchanged",
      pattern: "rg",
    });
    expect(normalizeExecAllowlistPatternForAdd("/opt/homebrew/bin/*")).toEqual({
      kind: "unchanged",
      pattern: "/opt/homebrew/bin/*",
    });
    expect(normalizeExecAllowlistPatternForAdd("~/Projects/**/bin/rg")).toEqual({
      kind: "unchanged",
      pattern: "~/Projects/**/bin/rg",
    });
  });

  it("reports literal paths that do not resolve locally as unverified", () => {
    const missing = path.join(tempDir, "does-not-exist", "tool");
    expect(normalizeExecAllowlistPatternForAdd(missing)).toEqual({
      kind: "unverified-path",
      pattern: missing,
    });
  });

  it.runIf(process.platform !== "win32")(
    "resolves symlinked binaries to their realpath so the entry matches at exec time",
    () => {
      const cellarDir = fs.mkdtempSync(path.join(tempDir, "cellar-"));
      const binDir = fs.mkdtempSync(path.join(tempDir, "bin-"));
      const realBinary = path.join(cellarDir, "rg");
      fs.writeFileSync(realBinary, "#!/bin/sh\n", { mode: 0o755 });
      const symlinkPath = path.join(binDir, "rg");
      fs.symlinkSync(realBinary, symlinkPath);

      const normalized = normalizeExecAllowlistPatternForAdd(symlinkPath);
      expect(normalized).toEqual({
        kind: "resolved-symlink",
        pattern: fs.realpathSync(realBinary),
      });
      // The stored pattern must match the trust realpath the allowlist uses.
      expect(matchesExecAllowlistPattern(normalized.pattern, fs.realpathSync(realBinary))).toBe(
        true,
      );
      // Remote-target writes must not translate against the local filesystem.
      expect(
        normalizeExecAllowlistPatternForAdd(symlinkPath, { resolveLocalRealpath: false }),
      ).toEqual({ kind: "unverified-path", pattern: symlinkPath });
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps regular file paths unchanged when the realpath already matches",
    () => {
      const plainDir = fs.mkdtempSync(path.join(tempDir, "plain-"));
      const realDir = fs.realpathSync(plainDir);
      const binary = path.join(realDir, "tool");
      fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
      expect(normalizeExecAllowlistPatternForAdd(binary)).toEqual({
        kind: "unchanged",
        pattern: binary,
      });
    },
  );
});
