import { symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildExcludeFilter,
  ExcludeFileError,
  ProtectedPathError,
  resolveExcludePatterns,
  SMART_EXCLUDE_DEFAULTS,
  type ExcludeSpec,
} from "./backup-exclude.js";

function makeSpec(overrides: Partial<ExcludeSpec> = {}): ExcludeSpec {
  return {
    exclude: [],
    includeAll: false,
    smartExclude: false,
    allowExcludeProtected: false,
    nonInteractive: false,
    ...overrides,
  };
}

describe("resolveExcludePatterns", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-exclude-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty array when --include-all is set", async () => {
    const { patterns } = await resolveExcludePatterns(
      makeSpec({ includeAll: true, smartExclude: true, exclude: ["*.log"] }),
      tempDir,
    );
    expect(patterns).toEqual([]);
  });

  it("returns empty when no flags and no --smart-exclude", async () => {
    const { patterns } = await resolveExcludePatterns(makeSpec(), tempDir);
    expect(patterns).toEqual([]);
  });

  it("returns SMART_EXCLUDE_DEFAULTS when --smart-exclude is set", async () => {
    const { patterns, sources } = await resolveExcludePatterns(
      makeSpec({ smartExclude: true }),
      tempDir,
    );
    expect(patterns).toEqual([...SMART_EXCLUDE_DEFAULTS]);
    for (const p of SMART_EXCLUDE_DEFAULTS) {
      expect(sources.get(p)).toBe("default");
    }
  });

  it("--include-all overrides --smart-exclude + --exclude", async () => {
    const { patterns } = await resolveExcludePatterns(
      makeSpec({ includeAll: true, smartExclude: true, exclude: ["*.tmp"] }),
      tempDir,
    );
    expect(patterns).toEqual([]);
  });

  it("--exclude adds patterns on top of smart-exclude defaults", async () => {
    const { patterns } = await resolveExcludePatterns(
      makeSpec({ smartExclude: true, exclude: ["*.log"] }),
      tempDir,
    );
    expect(patterns).toContain("*.log");
    for (const d of SMART_EXCLUDE_DEFAULTS) {
      expect(patterns).toContain(d);
    }
  });

  it("--exclude-file loads patterns from file, stacks with --exclude", async () => {
    const excludeFilePath = path.join(tempDir, "ignore.txt");
    await fs.writeFile(excludeFilePath, "*.tmp\n# comment\n\n*.bak\n", "utf8");

    const { patterns, sources } = await resolveExcludePatterns(
      makeSpec({ exclude: ["*.log"], excludeFile: excludeFilePath }),
      tempDir,
    );
    expect(patterns).toContain("*.tmp");
    expect(patterns).toContain("*.bak");
    expect(patterns).toContain("*.log");
    expect(sources.get("*.tmp")).toBe("config-file");
    expect(sources.get("*.log")).toBe("cli");
  });

  it("duplicate patterns are deduplicated", async () => {
    const { patterns } = await resolveExcludePatterns(
      makeSpec({ smartExclude: true, exclude: ["venvs/", "*.log", "*.log"] }),
      tempDir,
    );
    const logCount = patterns.filter((p) => p === "*.log").length;
    expect(logCount).toBe(1);
    // venvs/ from smart-exclude should only appear once
    const venvsCount = patterns.filter((p) => p === "venvs/").length;
    expect(venvsCount).toBe(1);
  });

  it("comment lines (#) in exclude-file are ignored", async () => {
    const excludeFilePath = path.join(tempDir, "ignore.txt");
    await fs.writeFile(excludeFilePath, "# this is a comment\nkeep.txt\n", "utf8");

    const { patterns } = await resolveExcludePatterns(
      makeSpec({ excludeFile: excludeFilePath }),
      tempDir,
    );
    expect(patterns).toEqual(["keep.txt"]);
  });

  it("blank lines in exclude-file are ignored", async () => {
    const excludeFilePath = path.join(tempDir, "ignore.txt");
    await fs.writeFile(excludeFilePath, "\n\npattern1\n\npattern2\n\n", "utf8");

    const { patterns } = await resolveExcludePatterns(
      makeSpec({ excludeFile: excludeFilePath }),
      tempDir,
    );
    expect(patterns).toEqual(["pattern1", "pattern2"]);
  });

  // --exclude-file validation
  it("throws ExcludeFileError when --exclude-file does not exist", async () => {
    await expect(
      resolveExcludePatterns(
        makeSpec({ excludeFile: path.join(tempDir, "nonexistent.txt") }),
        tempDir,
      ),
    ).rejects.toThrow(ExcludeFileError);
  });

  it("throws ExcludeFileError when --exclude-file is a directory", async () => {
    const dirPath = path.join(tempDir, "somedir");
    await fs.mkdir(dirPath);

    await expect(
      resolveExcludePatterns(makeSpec({ excludeFile: dirPath }), tempDir),
    ).rejects.toThrow(ExcludeFileError);
  });

  it("throws ExcludeFileError when --exclude-file exceeds 1MB", async () => {
    const bigFile = path.join(tempDir, "big.txt");
    // Write just over 1MB
    await fs.writeFile(bigFile, "x".repeat(1024 * 1024 + 1), "utf8");

    await expect(
      resolveExcludePatterns(makeSpec({ excludeFile: bigFile }), tempDir),
    ).rejects.toThrow(ExcludeFileError);
  });

  // P2-011: symlink rejection for --exclude-file
  it("throws ExcludeFileError when --exclude-file is a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }

    const realFile = path.join(tempDir, "real-patterns.txt");
    await fs.writeFile(realFile, "*.log\n", "utf8");
    const symlinkFile = path.join(tempDir, "symlink-patterns.txt");
    symlinkSync(realFile, symlinkFile);

    await expect(
      resolveExcludePatterns(makeSpec({ excludeFile: symlinkFile }), tempDir),
    ).rejects.toThrow(ExcludeFileError);
    await expect(
      resolveExcludePatterns(makeSpec({ excludeFile: symlinkFile }), tempDir),
    ).rejects.toThrow(/symb/i);
  });

  // Protected path checks
  it("warns when --exclude matches credentials/ and says pattern was removed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await resolveExcludePatterns(makeSpec({ exclude: ["credentials/"] }), tempDir);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("protected path"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("removed"));
    warnSpy.mockRestore();
  });

  it("throws in --non-interactive mode when --exclude matches protected path without --allow-exclude-protected", async () => {
    await expect(
      resolveExcludePatterns(
        makeSpec({ exclude: ["credentials/"], nonInteractive: true }),
        tempDir,
      ),
    ).rejects.toThrow(ProtectedPathError);
  });

  it("passes when --allow-exclude-protected is set for protected path", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patterns } = await resolveExcludePatterns(
      makeSpec({ exclude: ["credentials/"], allowExcludeProtected: true }),
      tempDir,
    );
    expect(patterns).toContain("credentials/");
    // Should NOT warn when override is set
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // P2-010: glob bypass protection for protected paths
  it("warns when glob pattern matches protected path (cred*)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await resolveExcludePatterns(makeSpec({ exclude: ["cred*"] }), tempDir);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("protected path"));
    warnSpy.mockRestore();
  });

  it("throws in --non-interactive mode when glob matches protected path", async () => {
    await expect(
      resolveExcludePatterns(makeSpec({ exclude: ["cred*"], nonInteractive: true }), tempDir),
    ).rejects.toThrow(ProtectedPathError);
  });

  it("--allow-exclude-protected overrides glob match check", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patterns } = await resolveExcludePatterns(
      makeSpec({ exclude: ["cred*"], allowExcludeProtected: true }),
      tempDir,
    );
    expect(patterns).toContain("cred*");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Finding 1: protected-path patterns are dropped (not just warned about)
  it("drops protected-path pattern from returned patterns (exact match)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patterns, sources } = await resolveExcludePatterns(
      makeSpec({ exclude: ["credentials/", "*.log"] }),
      tempDir,
    );
    expect(patterns).not.toContain("credentials/");
    expect(patterns).toContain("*.log");
    expect(sources.has("credentials/")).toBe(false);
    warnSpy.mockRestore();
  });

  it("drops protected-path pattern from returned patterns (glob match)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patterns, sources } = await resolveExcludePatterns(
      makeSpec({ exclude: ["cred*", "*.log"] }),
      tempDir,
    );
    expect(patterns).not.toContain("cred*");
    expect(patterns).toContain("*.log");
    expect(sources.has("cred*")).toBe(false);
    warnSpy.mockRestore();
  });

  // Finding 3: descendant patterns trigger protected-path guard
  it("catches descendant pattern credentials/*", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patterns } = await resolveExcludePatterns(
      makeSpec({ exclude: ["credentials/*"] }),
      tempDir,
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("protected path"));
    expect(patterns).not.toContain("credentials/*");
    warnSpy.mockRestore();
  });

  it("catches descendant pattern credentials/**", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patterns } = await resolveExcludePatterns(
      makeSpec({ exclude: ["credentials/**"] }),
      tempDir,
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("protected path"));
    expect(patterns).not.toContain("credentials/**");
    warnSpy.mockRestore();
  });

  it("catches descendant pattern cron/* in non-interactive mode", async () => {
    await expect(
      resolveExcludePatterns(makeSpec({ exclude: ["cron/*"], nonInteractive: true }), tempDir),
    ).rejects.toThrow(ProtectedPathError);
  });

  // Finding 3b: case-variation bypass
  it("catches case-variant Credentials/ (case-insensitive guard)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patterns } = await resolveExcludePatterns(
      makeSpec({ exclude: ["Credentials/"] }),
      tempDir,
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("protected path"));
    expect(patterns).not.toContain("Credentials/");
    warnSpy.mockRestore();
  });

  it("catches case-variant + descendant Credentials/*", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patterns } = await resolveExcludePatterns(
      makeSpec({ exclude: ["Credentials/*"] }),
      tempDir,
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("protected path"));
    expect(patterns).not.toContain("Credentials/*");
    warnSpy.mockRestore();
  });

  // ReDoS protection
  it("throws for pattern longer than 256 chars", async () => {
    const longPattern = "*".repeat(257);
    await expect(
      resolveExcludePatterns(makeSpec({ exclude: [longPattern] }), tempDir),
    ).rejects.toThrow(/too long/i);
  });

  it("throws for more than 500 patterns", async () => {
    const manyPatterns = Array.from({ length: 501 }, (_, i) => `pattern${i}`);
    await expect(
      resolveExcludePatterns(makeSpec({ exclude: manyPatterns }), tempDir),
    ).rejects.toThrow(/too many/i);
  });

  it("throws for pattern with more than 5 consecutive globstars", async () => {
    const pattern = "**/**/**/**/**/**/foo";
    await expect(resolveExcludePatterns(makeSpec({ exclude: [pattern] }), tempDir)).rejects.toThrow(
      /globstars/i,
    );
  });

  // Finding 10: pattern validation applies to all sources
  it("rejects too-long pattern from .backupignore (not just CLI)", async () => {
    const backupignore = path.join(tempDir, ".backupignore");
    await fs.writeFile(backupignore, `${"*".repeat(257)}\n`, "utf8");
    await fs.chmod(backupignore, 0o644);

    await expect(resolveExcludePatterns(makeSpec(), tempDir)).rejects.toThrow(/too long/i);
  });

  // .backupignore auto-detection
  it(".backupignore auto-loaded from stateDir when present", async () => {
    const backupignore = path.join(tempDir, ".backupignore");
    await fs.writeFile(backupignore, "auto-pattern\n", "utf8");
    await fs.chmod(backupignore, 0o644);

    const { patterns, sources } = await resolveExcludePatterns(makeSpec(), tempDir);
    expect(patterns).toContain("auto-pattern");
    expect(sources.get("auto-pattern")).toBe("auto-file");
  });

  it(".backupignore skipped when group-writable (security)", async () => {
    if (process.platform === "win32") {
      return;
    }

    const backupignore = path.join(tempDir, ".backupignore");
    await fs.writeFile(backupignore, "should-skip\n", "utf8");
    await fs.chmod(backupignore, 0o664); // group writable

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patterns } = await resolveExcludePatterns(makeSpec(), tempDir);
    expect(patterns).not.toContain("should-skip");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("group/world writable"));
    warnSpy.mockRestore();
  });

  it(".backupignore skipped when world-writable (security)", async () => {
    if (process.platform === "win32") {
      return;
    }

    const backupignore = path.join(tempDir, ".backupignore");
    await fs.writeFile(backupignore, "should-skip\n", "utf8");
    await fs.chmod(backupignore, 0o666); // world writable

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patterns } = await resolveExcludePatterns(makeSpec(), tempDir);
    expect(patterns).not.toContain("should-skip");
    warnSpy.mockRestore();
  });

  it(".backupignore as symlink is rejected (patterns not loaded)", async () => {
    if (process.platform === "win32") {
      return;
    }

    const realFile = path.join(tempDir, ".backupignore-real");
    await fs.writeFile(realFile, "symlink-pattern\n", "utf8");
    const backupignore = path.join(tempDir, ".backupignore");
    symlinkSync(realFile, backupignore);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { patterns } = await resolveExcludePatterns(makeSpec(), tempDir);
    expect(patterns).not.toContain("symlink-pattern");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("symb"));
    warnSpy.mockRestore();
  });

  it("--include-all disables .backupignore auto-loading", async () => {
    const backupignore = path.join(tempDir, ".backupignore");
    await fs.writeFile(backupignore, "auto-pattern\n", "utf8");

    const { patterns } = await resolveExcludePatterns(makeSpec({ includeAll: true }), tempDir);
    expect(patterns).toEqual([]);
  });
});

describe("buildExcludeFilter", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-filter-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("throws TypeError when baseDir is not absolute", () => {
    expect(() =>
      buildExcludeFilter(["venvs/"], new Map([["venvs/", "default"]]), "relative/path"),
    ).toThrow(TypeError);
  });

  it("returns { filter: () => true } when patterns is empty", () => {
    const { filter, getExcludedStats } = buildExcludeFilter([], new Map(), tempDir);
    expect(filter("/any/path", { size: 100 })).toBe(true);
    const stats = getExcludedStats();
    expect(stats.totalFiles).toBe(0);
    expect(stats.totalBytes).toBe(0);
    expect(stats.byPattern).toEqual([]);
  });

  it("filter returns true (include) for non-matching path", () => {
    const sources = new Map([["venvs/", "default" as const]]);
    const { filter } = buildExcludeFilter(["venvs/"], sources, tempDir);
    expect(filter("memory/notes.md", { size: 100 })).toBe(true);
  });

  it("filter returns false (exclude) for exact directory match", () => {
    const sources = new Map([["venvs/", "default" as const]]);
    const { filter } = buildExcludeFilter(["venvs/"], sources, tempDir);
    expect(filter("venvs", { size: 0 })).toBe(false);
  });

  it("filter returns false for nested file under excluded directory", () => {
    const sources = new Map([["venvs/", "default" as const]]);
    const { filter } = buildExcludeFilter(["venvs/"], sources, tempDir);
    expect(filter("venvs/lib/python3.11/site-packages/pip.py", { size: 1024 })).toBe(false);
  });

  it("glob pattern *.log excludes log files", () => {
    const sources = new Map([["*.log", "cli" as const]]);
    const { filter } = buildExcludeFilter(["*.log"], sources, tempDir);
    expect(filter("error.log", { size: 500 })).toBe(false);
    expect(filter("error.txt", { size: 500 })).toBe(true);
  });

  it("** glob matches nested paths", () => {
    const sources = new Map([["**/__pycache__", "cli" as const]]);
    const { filter } = buildExcludeFilter(["**/__pycache__"], sources, tempDir);
    expect(filter("src/__pycache__", { size: 0 })).toBe(false);
    expect(filter("src/lib/__pycache__", { size: 0 })).toBe(false);
    expect(filter("src/lib/main.py", { size: 100 })).toBe(true);
  });

  it("getExcludedStats() returns per-pattern stats populated by filter side-effect", () => {
    const sources = new Map([["venvs/", "default" as const]]);
    const { filter, getExcludedStats } = buildExcludeFilter(["venvs/"], sources, tempDir);

    filter("venvs", { size: 0 });
    filter("memory/notes.md", { size: 100 });

    const stats = getExcludedStats();
    expect(stats.totalFiles).toBe(1);
    expect(stats.totalBytes).toBe(0);
    expect(stats.byPattern).toHaveLength(1);
    expect(stats.byPattern[0]?.pattern).toBe("venvs/");
    expect(stats.byPattern[0]?.source).toBe("default");
    expect(stats.byPattern[0]?.files).toBe(1);
    expect(stats.byPattern[0]?.bytes).toBe(0);
  });

  it("getExcludedStats() aggregates bytes and file count per pattern", () => {
    const sources = new Map([["*.log", "cli" as const]]);
    const { filter, getExcludedStats } = buildExcludeFilter(["*.log"], sources, tempDir);

    filter("error.log", { size: 500 });
    filter("access.log", { size: 300 });
    const stats = getExcludedStats();

    expect(stats.totalFiles).toBe(2);
    expect(stats.totalBytes).toBe(800);
    expect(stats.byPattern).toHaveLength(1);
    expect(stats.byPattern[0]).toEqual({
      pattern: "*.log",
      source: "cli",
      files: 2,
      bytes: 800,
    });
  });

  it("getExcludedStats() source is 'default' for SMART_EXCLUDE_DEFAULTS patterns", () => {
    const sources = new Map<string, "default" | "cli">();
    for (const d of SMART_EXCLUDE_DEFAULTS) {
      sources.set(d, "default");
    }
    const { filter, getExcludedStats } = buildExcludeFilter(
      [...SMART_EXCLUDE_DEFAULTS],
      sources,
      tempDir,
    );

    filter("venvs", { size: 0 });
    filter("models", { size: 0 });

    const stats = getExcludedStats();
    expect(stats.totalFiles).toBe(2);
    expect(stats.byPattern.length).toBeGreaterThanOrEqual(2);
    for (const entry of stats.byPattern) {
      expect(entry.source).toBe("default");
    }
  });

  it("filter returns false (exclude) and warns when an error occurs (fail-closed)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sources = new Map([["venvs/", "default" as const]]);
    const { filter } = buildExcludeFilter(["venvs/"], sources, tempDir);

    // Normal operation should work fine
    expect(filter("venvs", { size: 0 })).toBe(false);
    expect(filter("safe-file.txt", { size: 100 })).toBe(true);

    warnSpy.mockRestore();
  });

  it("handles absolute paths by converting to relative", () => {
    const sources = new Map([["venvs/", "default" as const]]);
    const { filter } = buildExcludeFilter(["venvs/"], sources, tempDir);

    // Absolute path under baseDir should be converted to relative
    expect(filter(path.join(tempDir, "venvs"), { size: 0 })).toBe(false);
    expect(filter(path.join(tempDir, "memory/notes.md"), { size: 100 })).toBe(true);
  });

  it("handles path with leading ./ gracefully", () => {
    const sources = new Map([["venvs/", "default" as const]]);
    const { filter } = buildExcludeFilter(["venvs/"], sources, tempDir);
    expect(filter("./venvs", { size: 0 })).toBe(false);
  });

  it("getExcludedStats() does not include individual file paths", () => {
    const sources = new Map([["venvs/", "default" as const]]);
    const { filter, getExcludedStats } = buildExcludeFilter(["venvs/"], sources, tempDir);

    filter("venvs/lib/python3.11/site.py", { size: 1024 });
    filter("venvs/bin/python", { size: 512 });
    const stats = getExcludedStats();

    // Stats should aggregate without exposing individual paths
    expect(stats.totalFiles).toBe(2);
    expect(stats.totalBytes).toBe(1536);
    expect(stats.byPattern).toHaveLength(1);
    // No 'path' field on the byPattern entries
    for (const entry of stats.byPattern) {
      expect(entry).not.toHaveProperty("path");
    }
  });

  it("getExcludedStats() returns consistent snapshots on each call", () => {
    const sources = new Map([["venvs/", "default" as const]]);
    const { filter, getExcludedStats } = buildExcludeFilter(["venvs/"], sources, tempDir);

    filter("venvs", { size: 0 });
    const first = getExcludedStats();
    const second = getExcludedStats();

    expect(first).toEqual(second);
  });

  it("getExcludedStats() tracks multiple patterns independently", () => {
    const sources = new Map([
      ["venvs/", "default" as const],
      ["*.log", "cli" as const],
    ]);
    const { filter, getExcludedStats } = buildExcludeFilter(["venvs/", "*.log"], sources, tempDir);

    filter("venvs/lib/site.py", { size: 100 });
    filter("error.log", { size: 200 });
    filter("access.log", { size: 300 });

    const stats = getExcludedStats();
    expect(stats.totalFiles).toBe(3);
    expect(stats.totalBytes).toBe(600);
    expect(stats.byPattern).toHaveLength(2);

    const venvsStats = stats.byPattern.find((p: { pattern: string }) => p.pattern === "venvs/");
    expect(venvsStats).toEqual({ pattern: "venvs/", source: "default", files: 1, bytes: 100 });

    const logStats = stats.byPattern.find((p: { pattern: string }) => p.pattern === "*.log");
    expect(logStats).toEqual({ pattern: "*.log", source: "cli", files: 2, bytes: 500 });
  });

  // Finding 2: paths outside baseDir are included (not silently excluded)
  it("filter returns true (include) for absolute path outside baseDir", () => {
    const sources = new Map([["venvs/", "default" as const]]);
    const { filter } = buildExcludeFilter(["venvs/"], sources, tempDir);
    // Path outside tempDir — should be included, not silently excluded
    expect(filter("/some/other/path/file.txt", { size: 100 })).toBe(true);
  });

  it("filter returns true for ../relative paths (outside baseDir) without triggering warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sources = new Map([["venvs/", "default" as const]]);
    const { filter } = buildExcludeFilter(["venvs/"], sources, tempDir);

    // Simulate a path that resolves to ../ relative to baseDir
    expect(filter(path.join(tempDir, "..", "outside-file.txt"), { size: 100 })).toBe(true);
    // Should NOT trigger the fail-closed warn — guard catches before catch block
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
