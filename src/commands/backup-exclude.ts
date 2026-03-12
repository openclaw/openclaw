import { readFileSync, statSync, existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import picomatch from "picomatch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PatternSource = "default" | "cli" | "config-file" | "auto-file";

export interface ExcludedEntry {
  readonly path: string;
  readonly pattern: string;
  readonly source: PatternSource;
  readonly bytes: number;
}

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
  /** Snapshot of every entry the filter excluded (populated as a side-effect). */
  readonly getExcluded: () => readonly ExcludedEntry[];
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

function parseLinesFromFile(filePath: string): string[] {
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

// ---------------------------------------------------------------------------
// Pattern resolution
// ---------------------------------------------------------------------------

/**
 * Resolve all exclude patterns from the various sources (CLI flags, files,
 * smart-exclude defaults). Validates patterns and checks for protected path
 * conflicts **before** tar starts — fail fast.
 */
export function resolveExcludePatterns(
  spec: ExcludeSpec,
  stateDir: string,
): { patterns: readonly string[]; sources: ReadonlyMap<string, PatternSource> } {
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
  const autoIgnoreFile = resolve(stateDir, ".backupignore");
  if (existsSync(autoIgnoreFile)) {
    try {
      const fileStat = statSync(autoIgnoreFile);
      const isGroupOrWorldWritable = (fileStat.mode & 0o022) !== 0;
      if (isGroupOrWorldWritable) {
        console.warn("⚠️  .backupignore is group/world writable — skipping for security");
      } else if (fileStat.isFile() && fileStat.size <= MAX_EXCLUDE_FILE_BYTES) {
        const lines = parseLinesFromFile(autoIgnoreFile);
        for (const l of lines) {
          patterns.push(l);
          if (!sources.has(l)) {
            sources.set(l, "auto-file");
          }
        }
      }
    } catch {
      // Ignore read errors for auto-detected file — it's optional.
    }
  }

  // Layer 3: --exclude-file (pre-validated — fail fast before tar starts)
  if (spec.excludeFile) {
    const filePath = resolve(spec.excludeFile);
    let fileStat: ReturnType<typeof statSync>;
    try {
      fileStat = statSync(filePath);
    } catch {
      throw new ExcludeFileError(filePath, "file not found");
    }
    if (!fileStat.isFile()) {
      throw new ExcludeFileError(filePath, "must be a regular file (not a device or directory)");
    }
    if (fileStat.size > MAX_EXCLUDE_FILE_BYTES) {
      throw new ExcludeFileError(
        filePath,
        `too large: ${fileStat.size} bytes (max ${MAX_EXCLUDE_FILE_BYTES / 1024 / 1024}MB)`,
      );
    }
    const lines = parseLinesFromFile(filePath);
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

  // Validate counts and user-supplied pattern complexity.
  if (deduplicated.length > MAX_PATTERN_COUNT) {
    throw new Error(`Too many exclude patterns: ${deduplicated.length} (max ${MAX_PATTERN_COUNT})`);
  }
  for (const p of spec.exclude) {
    validatePattern(p);
  }

  // Protected path checks
  for (const pattern of deduplicated) {
    const normalized = pattern.replace(/\/$/, "");
    for (const protectedPath of PROTECTED_PATHS) {
      const protectedNormalized = protectedPath.replace(/\/$/, "");
      if (normalized === protectedNormalized) {
        if (!spec.allowExcludeProtected) {
          if (spec.nonInteractive) {
            throw new ProtectedPathError(pattern);
          }
          console.warn(
            `⚠️  Pattern "${pattern}" matches protected path "${protectedPath}". Use --allow-exclude-protected to override.`,
          );
        }
      }
    }
  }

  return { patterns: deduplicated, sources };
}

// ---------------------------------------------------------------------------
// Filter factory
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
    return { filter: () => true, getExcluded: () => [] };
  }

  // -----------------------------------------------------------------------
  // Pre-compile patterns OUTSIDE the filter closure for performance.
  // -----------------------------------------------------------------------

  // `ignore` handles gitignore-style patterns (trailing `/`, negation, etc.)
  const ig = ignore().add(patterns as string[]);

  // Pre-classify simple directory-prefix patterns for O(1) fast-path check.
  // These are plain names without glob chars — check as string prefixes.
  const prefixPatterns: Array<{ prefix: string; pattern: string }> = [];
  for (const p of patterns) {
    if (!/[*?{[]/.test(p)) {
      prefixPatterns.push({
        prefix: p.replace(/\/$/, ""),
        pattern: p,
      });
    }
  }

  // Pre-compile picomatch matchers for glob patterns (CLI --exclude).
  // These run only when `ignore` doesn't match — belt-and-suspenders.
  const globPatterns = patterns.filter((p) => /[*?{[]/.test(p));
  const picoMatcher = globPatterns.length > 0 ? picomatch(globPatterns, { dot: true }) : undefined;

  const excluded: ExcludedEntry[] = [];

  const filter = (entryPath: string, stat: { size?: number }): boolean => {
    try {
      // Normalize to relative path with forward slashes — required by `ignore`.
      // tar.c() filter receives relative paths (relative to cwd).
      let rel: string;
      if (isAbsolute(entryPath)) {
        rel = relative(baseDir, entryPath);
      } else {
        rel = entryPath;
      }
      // Normalize separators (Windows safety) and strip leading `./`
      rel = rel.split(sep).join("/").replace(/^\.\//, "");

      if (!rel) {
        return true; // root directory itself — always include
      }

      // Fast path: prefix check for simple directory/file name patterns.
      for (const { prefix, pattern } of prefixPatterns) {
        if (rel === prefix || rel.startsWith(`${prefix}/`)) {
          excluded.push({
            path: rel,
            pattern,
            source: sources.get(pattern) ?? "cli",
            bytes: stat.size ?? 0,
          });
          return false; // exclude — prunes entire subtree if directory
        }
      }

      // Glob path: use `ignore` package for gitignore-compliant matching.
      if (ig.ignores(rel)) {
        // `ignore` doesn't expose which rule matched; find best match.
        const matchedPattern = findMatchingPattern(rel, patterns) ?? "(pattern)";
        excluded.push({
          path: rel,
          pattern: matchedPattern,
          source: sources.get(matchedPattern) ?? "cli",
          bytes: stat.size ?? 0,
        });
        return false;
      }

      // Fallback: picomatch for bash-style globs that `ignore` might not cover.
      if (picoMatcher?.(rel)) {
        const matchedPattern = findMatchingGlobPattern(rel, globPatterns) ?? "(glob)";
        excluded.push({
          path: rel,
          pattern: matchedPattern,
          source: sources.get(matchedPattern) ?? "cli",
          bytes: stat.size ?? 0,
        });
        return false;
      }

      return true; // include
    } catch (err) {
      // FAIL-CLOSED: on any filter error, exclude the entry for safety.
      console.warn(
        `⚠️  Filter error for "${entryPath}", excluding for safety: ${(err as Error).message}`,
      );
      excluded.push({
        path: entryPath,
        pattern: "(filter-error)",
        source: "cli",
        bytes: 0,
      });
      return false;
    }
  };

  return { filter, getExcluded: () => [...excluded] };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findMatchingPattern(relPath: string, patterns: readonly string[]): string | undefined {
  // Try each pattern individually with `ignore` to find which one matched.
  for (const p of patterns) {
    try {
      if (ignore().add(p).ignores(relPath)) {
        return p;
      }
    } catch {
      // skip broken pattern
    }
  }
  return undefined;
}

function findMatchingGlobPattern(
  relPath: string,
  globPatterns: readonly string[],
): string | undefined {
  for (const p of globPatterns) {
    try {
      if (picomatch.isMatch(relPath, p, { dot: true })) {
        return p;
      }
    } catch {
      // skip broken pattern
    }
  }
  return undefined;
}
