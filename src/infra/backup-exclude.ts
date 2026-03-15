import fs from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import ignore from "ignore";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
import type { ExcludedStats, PatternSource } from "../commands/backup-shared.js";

export interface ExcludeSpec {
  readonly exclude: readonly string[];
  readonly excludeFile?: string;
  readonly includeAll: boolean;
  readonly smartExclude: boolean;
  readonly allowExcludeProtected: boolean;
  readonly nonInteractive: boolean;
}

export interface ExcludeFilterResult {
  /** Return `true` to include the entry in the archive, `false` to exclude. */
  readonly filter: (entryPath: string, stat: { size?: number }) => boolean;
  /** Aggregated per-pattern exclusion stats (populated as a side-effect of filter calls). */
  readonly getExcludedStats: () => ExcludedStats;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SMART_EXCLUDE_DEFAULTS = ["venvs/", "models/", "logs/", "completions/"] as const;

export const PROTECTED_PATHS = ["credentials/", "extensions/", "cron/"] as const;

const MAX_PATTERN_LENGTH = 256;
const MAX_PATTERN_COUNT = 500;
const MAX_GLOBSTAR_DEPTH = 5;
const MAX_EXCLUDE_FILE_BYTES = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ExcludeFileError extends Error {
  constructor(
    public readonly filePath: string,
    reason: string,
  ) {
    super(`--exclude-file ${filePath}: ${reason}`);
    this.name = "ExcludeFileError";
  }
}

export class ProtectedPathError extends Error {
  constructor(pattern: string) {
    super(
      `Pattern "${pattern}" matches a protected path. Use --allow-exclude-protected to override.`,
    );
    this.name = "ProtectedPathError";
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validatePattern(pattern: string): void {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `Pattern too long (${pattern.length} > ${MAX_PATTERN_LENGTH}): ${pattern.slice(0, 64)}…`,
    );
  }
  const globstarCount = (pattern.match(/\*\*/g) ?? []).length;
  if (globstarCount > MAX_GLOBSTAR_DEPTH) {
    throw new Error(`Pattern has too many globstars (${globstarCount}): ${pattern}`);
  }
}

function parseLinesFromContent(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

// ---------------------------------------------------------------------------
// Shared file reading helper (P2-013 + P3-014: async with fs.promises)
// ---------------------------------------------------------------------------

interface ReadPatternFileOpts {
  /** Check group/world-writable permission bits. */
  permissionCheck?: boolean;
  /** If true, throw ExcludeFileError on failure; otherwise return []. */
  throwOnError?: boolean;
  /** If true, reject symlinks via lstat. */
  symLinkCheck?: boolean;
  /** Max file size in bytes (defaults to MAX_EXCLUDE_FILE_BYTES). */
  maxBytes?: number;
}

async function readPatternFile(filePath: string, opts: ReadPatternFileOpts): Promise<string[]> {
  try {
    // P2-011: Check for symlinks before following the path
    if (opts.symLinkCheck) {
      const lstat = await fs.lstat(filePath);
      if (lstat.isSymbolicLink()) {
        throw new ExcludeFileError(filePath, "must not be a symbolic link");
      }
    }

    const fileStat = await fs.stat(filePath);

    if (!fileStat.isFile()) {
      throw new ExcludeFileError(filePath, "must be a regular file (not a device or directory)");
    }

    const maxBytes = opts.maxBytes ?? MAX_EXCLUDE_FILE_BYTES;
    if (fileStat.size > maxBytes) {
      throw new ExcludeFileError(
        filePath,
        `too large: ${fileStat.size} bytes (max ${maxBytes / 1024 / 1024}MB)`,
      );
    }

    if (opts.permissionCheck && process.platform !== "win32") {
      const isGroupOrWorldWritable = (fileStat.mode & 0o022) !== 0;
      if (isGroupOrWorldWritable) {
        throw new ExcludeFileError(filePath, "group/world writable — skipping for security");
      }
    }

    const content = await fs.readFile(filePath, "utf-8");
    return parseLinesFromContent(content);
  } catch (err) {
    if (err instanceof ExcludeFileError) {
      if (opts.throwOnError) {
        throw err;
      }
      console.warn(`⚠️  ${err.message}`);
      return [];
    }
    if (opts.throwOnError) {
      const reason = err instanceof Error ? err.message : "file not found";
      throw new ExcludeFileError(filePath, reason);
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pattern resolution (P3-014: async)
// ---------------------------------------------------------------------------

/**
 * Resolve all exclude patterns from the various sources (CLI flags, files,
 * smart-exclude defaults). Validates patterns and checks for protected path
 * conflicts **before** tar starts — fail fast.
 */
export async function resolveExcludePatterns(
  spec: ExcludeSpec,
  stateDir: string,
): Promise<{ patterns: readonly string[]; sources: ReadonlyMap<string, PatternSource> }> {
  if (spec.includeAll) {
    return { patterns: [], sources: new Map() };
  }

  const patterns: string[] = [];
  const sources = new Map<string, PatternSource>();

  // Layer 1 (lowest priority): --smart-exclude defaults
  if (spec.smartExclude) {
    for (const p of SMART_EXCLUDE_DEFAULTS) {
      patterns.push(p);
      sources.set(p, "default");
    }
  }

  // Layer 2: auto-detect .backupignore in stateDir
  // readPatternFile with throwOnError:false returns [] if the file is missing.
  const autoIgnoreFile = resolve(stateDir, ".backupignore");
  const autoLines = await readPatternFile(autoIgnoreFile, {
    permissionCheck: true,
    symLinkCheck: true,
    throwOnError: false,
  });
  for (const l of autoLines) {
    patterns.push(l);
    if (!sources.has(l)) {
      sources.set(l, "auto-file");
    }
  }

  // Layer 3: --exclude-file (P2-011: symlink check, P2-013: shared helper)
  if (spec.excludeFile) {
    const filePath = resolve(spec.excludeFile);
    const lines = await readPatternFile(filePath, {
      throwOnError: true,
      symLinkCheck: true,
    });
    for (const l of lines) {
      patterns.push(l);
      if (!sources.has(l)) {
        sources.set(l, "config-file");
      }
    }
  }

  // Layer 4 (highest user-level): --exclude CLI flags
  for (const p of spec.exclude) {
    patterns.push(p);
    if (!sources.has(p)) {
      sources.set(p, "cli");
    }
  }

  // De-duplicate while preserving order (first occurrence wins source).
  const seen = new Set<string>();
  const deduplicated: string[] = [];
  for (const p of patterns) {
    if (!seen.has(p)) {
      seen.add(p);
      deduplicated.push(p);
    }
  }

  // Validate counts and pattern complexity for ALL sources (CLI, .backupignore, --exclude-file).
  if (deduplicated.length > MAX_PATTERN_COUNT) {
    throw new Error(`Too many exclude patterns: ${deduplicated.length} (max ${MAX_PATTERN_COUNT})`);
  }
  for (const p of deduplicated) {
    validatePattern(p);
  }

  // Protected path checks (P2-010: glob bypass protection)
  const droppedPatterns = new Set<string>();
  for (const pattern of deduplicated) {
    const normalized = pattern.replace(/\/$/, "");
    const normalizedLower = normalized.toLowerCase();
    for (const protectedPath of PROTECTED_PATHS) {
      const protectedNormalized = protectedPath.replace(/\/$/, "");
      const protectedLower = protectedNormalized.toLowerCase();
      // Check exact match (case-insensitive), descendant prefix, AND glob match.
      // ignore() defaults to ignorecase:true, so no toLowerCase needed for it.
      const wouldMatch =
        normalizedLower === protectedLower ||
        normalizedLower.startsWith(`${protectedLower}/`) ||
        ignore().add(pattern).ignores(protectedNormalized);
      if (wouldMatch && !spec.allowExcludeProtected) {
        if (spec.nonInteractive) {
          throw new ProtectedPathError(pattern);
        }
        console.warn(
          `⚠️  Pattern "${pattern}" matches protected path "${protectedPath}" and was removed. Use --allow-exclude-protected to override.`,
        );
        droppedPatterns.add(pattern);
        break; // no need to check remaining protected paths for this pattern
      }
    }
  }

  const filtered = deduplicated.filter((p) => !droppedPatterns.has(p));
  for (const dropped of droppedPatterns) {
    sources.delete(dropped);
  }

  return { patterns: filtered, sources };
}

// ---------------------------------------------------------------------------
// Filter factory (P2-006: pre-built matchers, P2-009: no picomatch)
// ---------------------------------------------------------------------------

/**
 * Build a tar `filter` function from resolved patterns.
 *
 * The filter populates `excluded[]` as a **side-effect** at runtime — not
 * reconstructed post-hoc. This ensures the manifest accurately reflects what
 * was actually excluded during archiving.
 *
 * @param patterns  Resolved exclude patterns (gitignore syntax).
 * @param sources   Map from pattern → source provenance.
 * @param baseDir   Absolute base directory (usually stateDir).
 */
export function buildExcludeFilter(
  patterns: readonly string[],
  sources: ReadonlyMap<string, PatternSource>,
  baseDir: string,
): ExcludeFilterResult {
  if (!isAbsolute(baseDir)) {
    throw new TypeError(`baseDir must be absolute, got: ${baseDir}`);
  }

  if (patterns.length === 0) {
    return {
      filter: () => true,
      getExcludedStats: () => ({ totalFiles: 0, totalBytes: 0, byPattern: [] }),
    };
  }

  // `ignore` handles gitignore-style patterns (trailing `/`, negation, etc.)
  const ig = ignore().add(patterns);

  // Per-pattern counters — keyed by pattern string.
  const patternCounters = new Map<
    string,
    { pattern: string; source: PatternSource; files: number; bytes: number }
  >();

  function recordExclusion(pattern: string, bytes: number): void {
    const existing = patternCounters.get(pattern);
    if (existing) {
      existing.files += 1;
      existing.bytes += bytes;
    } else {
      patternCounters.set(pattern, {
        pattern,
        source: sources.get(pattern) ?? "cli",
        files: 1,
        bytes,
      });
    }
  }

  const filter = (entryPath: string, stat: { size?: number }): boolean => {
    try {
      // Normalize to relative path with forward slashes — required by `ignore`.
      // Normalize separators early: tar on Windows may pass mixed separators
      // (e.g. C:\Users\...\openclaw/venvs) from its readdir-based subpath construction.
      const normalized = entryPath.replaceAll("\\", "/");
      let rel: string;
      if (isAbsolute(entryPath)) {
        rel = relative(baseDir, entryPath).replaceAll("\\", "/");
      } else {
        rel = normalized;
      }
      // Strip leading `./`
      rel = rel.replace(/^\.\//, "");

      if (!rel) {
        return true; // root directory itself — always include
      }

      // Paths outside baseDir are not subject to exclude patterns.
      // Covers: "../" paths (same drive) and "D:" paths (cross-drive on Windows).
      // Without this guard, `ignore` throws RangeError on "../" paths,
      // which hits the fail-closed catch and silently excludes content.
      if (rel.startsWith("../") || rel === ".." || /^[A-Za-z]:/.test(rel)) {
        return true;
      }

      // Use ig.test() for matching + O(1) pattern attribution via .rule
      const result = ig.test(rel);
      if (result.ignored && !result.unignored) {
        const matchedPattern = result.rule?.pattern ?? "(pattern)";
        recordExclusion(matchedPattern, stat.size ?? 0);
        return false;
      }

      // Directory-only patterns (trailing `/`) require a trailing `/` on the
      // path for `ignore` to recognise it as a directory. Tar entries for
      // directories may or may not include the trailing slash, so test both.
      if (!rel.endsWith("/")) {
        const dirResult = ig.test(`${rel}/`);
        if (dirResult.ignored && !dirResult.unignored) {
          const matchedPattern = dirResult.rule?.pattern ?? "(pattern)";
          recordExclusion(matchedPattern, stat.size ?? 0);
          return false;
        }
      }

      return true; // include
    } catch (err) {
      // FAIL-CLOSED: on any filter error, exclude the entry for safety.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️  Filter error for "${entryPath}", excluding for safety: ${message}`);
      recordExclusion("(filter-error)", 0);
      return false;
    }
  };

  const getExcludedStats = (): ExcludedStats => {
    const byPattern = [...patternCounters.values()].map((p) => ({ ...p }));
    return {
      totalFiles: byPattern.reduce((sum, p) => sum + p.files, 0),
      totalBytes: byPattern.reduce((sum, p) => sum + p.bytes, 0),
      byPattern,
    };
  };

  return { filter, getExcludedStats };
}
