import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TreeToolSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Directory to explore. Defaults to the current working directory. " +
        "Supports absolute paths or paths relative to cwd.",
    }),
  ),
  depth: Type.Optional(
    Type.Number({
      description: "Maximum recursion depth. Default: 3. Use 1 for a shallow listing.",
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description:
        'Glob pattern(s) to filter entries (e.g. "*.ts", "*.{js,jsx}"). ' +
        "Comma-separated for multiple patterns. Matches against filenames only.",
    }),
  ),
  include_metadata: Type.Optional(
    Type.Boolean({
      description: "Include file metadata (size in bytes, last modified time). Default: false.",
    }),
  ),
  include_hidden: Type.Optional(
    Type.Boolean({
      description:
        "Include hidden files and directories (those starting with a dot). Default: false.",
    }),
  ),
  no_ignore: Type.Optional(
    Type.Boolean({
      description: "Don't respect .gitignore rules. Default: false (respects .gitignore).",
    }),
  ),
  max_entries: Type.Optional(
    Type.Number({
      description:
        "Maximum number of entries to return. Default: 500. " +
        "Prevents overwhelming output for large directories.",
    }),
  ),
  directories_only: Type.Optional(
    Type.Boolean({
      description: "Only show directories, not files. Default: false.",
    }),
  ),
  files_only: Type.Optional(
    Type.Boolean({
      description: "Only show files, not directories. Default: false.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Defaults & limits
// ---------------------------------------------------------------------------

const DEFAULT_DEPTH = 3;
const HARD_MAX_DEPTH = 10;
const DEFAULT_MAX_ENTRIES = 500;
const HARD_MAX_ENTRIES = 5000;

// ---------------------------------------------------------------------------
// Gitignore support
// ---------------------------------------------------------------------------

/** A compiled set of gitignore patterns for a single directory. */
interface GitignoreRules {
  /** Patterns that match (non-negated). Each is { pattern, isDir }. */
  patterns: Array<{ regex: RegExp; isDir: boolean; negated: boolean }>;
}

/**
 * Convert a single gitignore glob line into a RegExp.
 * This handles the most common gitignore patterns; edge cases may differ
 * from git's actual implementation but are good enough for tree listing.
 */
function gitignorePatternToRegex(pattern: string): RegExp {
  // Escape regex special chars, then convert glob syntax
  let regexStr = pattern
    // Escape regex-meaningful characters except * and ?
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // ** matches everything including /
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    // * matches everything except /
    .replace(/\*/g, "[^/]*")
    // ? matches any single character except /
    .replace(/\?/g, "[^/]")
    // Restore globstar
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");

  // If pattern starts with /, it's anchored to the gitignore directory
  if (regexStr.startsWith("/")) {
    regexStr = "^" + regexStr.slice(1);
  } else {
    // Otherwise match anywhere in the path
    regexStr = "(^|/)" + regexStr;
  }

  // Ensure it can match the full segment
  regexStr += "(/.*)?$";

  return new RegExp(regexStr);
}

/**
 * Parse a .gitignore file content into rules.
 */
function parseGitignore(content: string): GitignoreRules {
  const patterns: GitignoreRules["patterns"] = [];

  for (let line of content.split("\n")) {
    line = line.trim();
    // Skip empty lines and comments
    if (!line || line.startsWith("#")) continue;

    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }

    // Trailing slash means directory-only match
    const isDir = line.endsWith("/");
    if (isDir) {
      line = line.slice(0, -1);
    }

    try {
      const regex = gitignorePatternToRegex(line);
      patterns.push({ regex, isDir, negated });
    } catch {
      // Skip malformed patterns
    }
  }

  return { patterns };
}

/**
 * Check whether a relative path is ignored by the given gitignore rules.
 * `isDirectory` indicates whether the entry is a directory.
 */
function isIgnoredByRules(
  relativePath: string,
  isDirectory: boolean,
  allRules: GitignoreRules[],
): boolean {
  let ignored = false;

  for (const rules of allRules) {
    for (const rule of rules.patterns) {
      // Directory-only patterns only match directories
      if (rule.isDir && !isDirectory) continue;

      if (rule.regex.test(relativePath)) {
        ignored = !rule.negated;
      }
    }
  }

  return ignored;
}

/**
 * Load .gitignore from a directory if it exists.
 */
async function loadGitignore(dir: string): Promise<GitignoreRules | null> {
  try {
    const content = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    return parseGitignore(content);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Split a comma-separated glob string while respecting `{...}` brace groups.
 * e.g. "*.{ts,js},*.md" → ["*.{ts,js}", "*.md"]
 */
function splitGlobPatterns(input: string): string[] {
  const results: string[] = [];
  let current = "";
  let braceDepth = 0;

  for (const ch of input) {
    if (ch === "{") {
      braceDepth++;
      current += ch;
    } else if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      current += ch;
    } else if (ch === "," && braceDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) results.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed) results.push(trimmed);

  return results;
}

/**
 * Simple glob matcher for filename filtering.
 * Supports *, ?, and {a,b} brace expansion.
 */
function matchGlob(filename: string, pattern: string): boolean {
  // Handle brace expansion: *.{js,ts} → *.js or *.ts
  const braceMatch = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, alternatives, suffix] = braceMatch;
    return alternatives.split(",").some((alt) => matchGlob(filename, prefix + alt.trim() + suffix));
  }

  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${regexStr}$`, "i").test(filename);
}

// ---------------------------------------------------------------------------
// Tree entry types
// ---------------------------------------------------------------------------

interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  modified?: string;
  children?: TreeEntry[];
  symlink_target?: string;
  error?: string;
}

interface TreeStats {
  files: number;
  directories: number;
  symlinks: number;
  errors: number;
  truncated: boolean;
}

interface WalkOptions {
  maxDepth: number;
  includeHidden: boolean;
  noIgnore: boolean;
  includeMetadata: boolean;
  globs: string[];
  maxEntries: number;
  directoriesOnly: boolean;
  filesOnly: boolean;
}

// ---------------------------------------------------------------------------
// Core walker
// ---------------------------------------------------------------------------

async function walkDirectory(
  dirPath: string,
  basePath: string,
  currentDepth: number,
  options: WalkOptions,
  stats: TreeStats,
  gitignoreRules: GitignoreRules[],
): Promise<TreeEntry[]> {
  if (stats.files + stats.directories + stats.symlinks >= options.maxEntries) {
    stats.truncated = true;
    return [];
  }

  // Load .gitignore for this directory if respecting ignores
  const localRules = [...gitignoreRules];
  if (!options.noIgnore) {
    const rules = await loadGitignore(dirPath);
    if (rules) {
      localRules.push(rules);
    }
  }

  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    stats.errors++;
    return [
      {
        name: path.basename(dirPath),
        path: path.relative(basePath, dirPath) || ".",
        type: "directory",
        error: err instanceof Error ? err.message : String(err),
      },
    ];
  }

  // Sort entries: directories first, then files, alphabetically within each group
  entries.sort((a, b) => {
    const aIsDir = a.isDirectory() || a.isSymbolicLink();
    const bIsDir = b.isDirectory() || b.isSymbolicLink();
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const result: TreeEntry[] = [];

  for (const entry of entries) {
    // Check max entries
    if (stats.files + stats.directories + stats.symlinks >= options.maxEntries) {
      stats.truncated = true;
      break;
    }

    // Skip hidden files unless requested
    if (!options.includeHidden && entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(basePath, entryPath);

    // Check gitignore rules
    const isDir = entry.isDirectory();
    if (!options.noIgnore && isIgnoredByRules(relativePath, isDir, localRules)) {
      continue;
    }

    // Handle symlinks
    if (entry.isSymbolicLink()) {
      stats.symlinks++;
      let target: string | undefined;
      let resolvedIsDir = false;
      try {
        target = await fs.readlink(entryPath);
        const realStat = await fs.stat(entryPath);
        resolvedIsDir = realStat.isDirectory();
      } catch {
        // Broken symlink — still include it
      }

      if (options.directoriesOnly && !resolvedIsDir) continue;
      if (options.filesOnly && resolvedIsDir) continue;

      const treeEntry: TreeEntry = {
        name: entry.name,
        path: relativePath,
        type: "symlink",
        symlink_target: target,
      };

      if (options.includeMetadata) {
        try {
          const stat = await fs.lstat(entryPath);
          treeEntry.size = stat.size;
          treeEntry.modified = stat.mtime.toISOString();
        } catch {
          // Skip metadata on error
        }
      }

      // Recurse into symlinked directories (but don't follow chains deeply)
      if (resolvedIsDir && currentDepth < options.maxDepth) {
        treeEntry.children = await walkDirectory(
          entryPath,
          basePath,
          currentDepth + 1,
          options,
          stats,
          localRules,
        );
      }

      result.push(treeEntry);
      continue;
    }

    if (isDir) {
      if (options.filesOnly) {
        // Still recurse into directories even in files-only mode to find files inside
        if (currentDepth < options.maxDepth) {
          const childEntries = await walkDirectory(
            entryPath,
            basePath,
            currentDepth + 1,
            options,
            stats,
            localRules,
          );
          // Only add children results (files) directly — skip the directory entry itself
          result.push(...childEntries);
        }
        continue;
      }

      stats.directories++;

      const treeEntry: TreeEntry = {
        name: entry.name,
        path: relativePath,
        type: "directory",
      };

      if (options.includeMetadata) {
        try {
          const stat = await fs.stat(entryPath);
          treeEntry.modified = stat.mtime.toISOString();
        } catch {
          // Skip metadata on error
        }
      }

      // Recurse into subdirectory
      if (currentDepth < options.maxDepth) {
        treeEntry.children = await walkDirectory(
          entryPath,
          basePath,
          currentDepth + 1,
          options,
          stats,
          localRules,
        );
      }

      result.push(treeEntry);
    } else {
      // Regular file
      if (options.directoriesOnly) continue;

      // Apply glob filter (to files only)
      if (options.globs.length > 0) {
        const matchesAny = options.globs.some((g) => matchGlob(entry.name, g));
        if (!matchesAny) continue;
      }

      stats.files++;

      const treeEntry: TreeEntry = {
        name: entry.name,
        path: relativePath,
        type: "file",
      };

      if (options.includeMetadata) {
        try {
          const stat = await fs.stat(entryPath);
          treeEntry.size = stat.size;
          treeEntry.modified = stat.mtime.toISOString();
        } catch {
          // Skip metadata on error
        }
      }

      result.push(treeEntry);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Text rendering (tree-like display)
// ---------------------------------------------------------------------------

function renderTree(entries: TreeEntry[], prefix: string = ""): string {
  const lines: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    let line = `${prefix}${connector}${entry.name}`;

    if (entry.type === "symlink" && entry.symlink_target) {
      line += ` → ${entry.symlink_target}`;
    }

    if (entry.type === "directory") {
      line += "/";
    }

    if (entry.size !== undefined) {
      line += ` (${formatSize(entry.size)})`;
    }

    if (entry.error) {
      line += ` [error: ${entry.error}]`;
    }

    lines.push(line);

    if (entry.children && entry.children.length > 0) {
      lines.push(renderTree(entry.children, prefix + childPrefix));
    }
  }

  return lines.join("\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTreeTool(opts?: {
  /** Override the working directory for relative path resolution. */
  workspaceDir?: string;
}): AnyAgentTool {
  return {
    label: "Tree",
    name: "tree",
    description:
      "Explore directory structure as a tree. Returns a recursive listing with file/directory names, " +
      "optional metadata (size, modified time), glob filtering, and .gitignore support. " +
      "Use for: understanding project layout, finding files, exploring directory contents. " +
      "Output includes both a visual tree and statistics (file/directory counts).",
    parameters: TreeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      const cwd = opts?.workspaceDir ?? process.cwd();
      const rawPath = readStringParam(params, "path");
      const targetPath = rawPath ? path.resolve(cwd, rawPath) : cwd;

      // Validate target exists and is a directory
      try {
        const stat = await fs.stat(targetPath);
        if (!stat.isDirectory()) {
          return jsonResult({
            error: `Not a directory: ${targetPath}`,
            path: targetPath,
          });
        }
      } catch (err) {
        return jsonResult({
          error: err instanceof Error ? err.message : String(err),
          path: targetPath,
        });
      }

      // Parse options
      const depthParam = readNumberParam(params, "depth", { integer: true });
      const maxDepth = Math.min(Math.max(depthParam ?? DEFAULT_DEPTH, 0), HARD_MAX_DEPTH);

      const maxEntriesParam = readNumberParam(params, "max_entries", { integer: true });
      const maxEntries = Math.min(
        Math.max(maxEntriesParam ?? DEFAULT_MAX_ENTRIES, 1),
        HARD_MAX_ENTRIES,
      );

      const includeHidden = params.include_hidden === true;
      const noIgnore = params.no_ignore === true;
      const includeMetadata = params.include_metadata === true;
      const directoriesOnly = params.directories_only === true;
      const filesOnly = params.files_only === true;

      // Parse glob patterns (respecting brace groups like *.{ts,js})
      const globStr = readStringParam(params, "glob");
      const globs = globStr ? splitGlobPatterns(globStr) : [];

      if (directoriesOnly && filesOnly) {
        return jsonResult({
          error: "Cannot use both directories_only and files_only at the same time.",
        });
      }

      const walkOpts: WalkOptions = {
        maxDepth,
        includeHidden,
        noIgnore,
        includeMetadata,
        globs,
        maxEntries,
        directoriesOnly,
        filesOnly,
      };

      const treeStats: TreeStats = {
        files: 0,
        directories: 0,
        symlinks: 0,
        errors: 0,
        truncated: false,
      };

      // Load root-level .gitignore
      const rootRules: GitignoreRules[] = [];
      if (!noIgnore) {
        const rules = await loadGitignore(targetPath);
        if (rules) {
          rootRules.push(rules);
        }
      }

      // Start at depth 1 so that depth=N means "show N levels" (matching `tree -L N` behavior).
      // depth=1 → only immediate children; depth=2 → children + grandchildren; etc.
      // depth=0 → immediate children listed but no subdirectory recursion.
      const tree = await walkDirectory(targetPath, targetPath, 1, walkOpts, treeStats, rootRules);

      // Render visual tree
      const rootName = path.basename(targetPath) || targetPath;
      const treeText = `${rootName}/\n${renderTree(tree)}`;

      // Build result
      const result: Record<string, unknown> = {
        root: targetPath,
        tree: treeText,
        stats: {
          files: treeStats.files,
          directories: treeStats.directories,
          symlinks: treeStats.symlinks,
          total: treeStats.files + treeStats.directories + treeStats.symlinks,
        },
      };

      if (treeStats.errors > 0) {
        result.errors = treeStats.errors;
      }

      if (treeStats.truncated) {
        result.truncated = true;
        result.note =
          `Output was truncated at ${maxEntries} entries. ` +
          "Use a more specific path, lower depth, or glob patterns to narrow results.";
      }

      return jsonResult(result);
    },
  };
}
