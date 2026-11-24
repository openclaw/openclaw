// Vitest pattern file helper reads include and exclude patterns from files.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Minimatch } from "minimatch";
import { collectVitestFileFilters } from "../../scripts/lib/vitest-cli-mode.mts";
import { parseVitestExecutionArgs } from "../../scripts/lib/vitest-cli.mts";
import {
  narrowIncludePatterns,
  resolveNonBrowserTestPattern,
  splitIncludePatterns,
} from "./vitest.include-patterns.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const globMatchers = new Map<string, Minimatch>();

// Match Vitest's script-extension grammar so broad selectors cannot leak opt-in suites.
export const vitestE2eTestGlob = "**/*.e2e.test.?(c|m)[jt]s?(x)";
export const vitestLiveTestGlob = "**/*.live.test.?(c|m)[jt]s?(x)";

export const sharedVitestExcludePatterns: readonly string[] = Object.freeze([
  "dist/**",
  "test/fixtures/**",
  "apps/macos/**",
  "apps/macos/.build/**",
  "**/node_modules/**",
  "**/vendor/**",
  "dist/OpenClaw.app/**",
  "**/._*",
  vitestLiveTestGlob,
  vitestE2eTestGlob,
]);

export function isSharedVitestExcludedPath(file: string, scopedDir = ""): boolean {
  const normalized = file.replaceAll("\\", "/");
  const scopedFile = scopedDir ? path.posix.relative(scopedDir, normalized) : normalized;
  return relativizeScopedPatterns(sharedVitestExcludePatterns, scopedDir).some((pattern) =>
    matchesVitestGlob(scopedFile, pattern),
  );
}

export function matchesVitestGlob(value: string, pattern: string): boolean {
  // Preserve the original Node/Bun spelling while native discovery uses the full basename.
  const nonBrowser = resolveNonBrowserTestPattern(pattern);
  if (nonBrowser) {
    return matchesVitestGlob(value, nonBrowser);
  }
  // CI plans tests before installing dependencies; keep Node's matcher dependency-free.
  if (!process.versions.bun) {
    return path.matchesGlob(value, pattern);
  }
  let matcher = globMatchers.get(pattern);
  if (!matcher) {
    // Keep Node's path.matchesGlob semantics when Bun does not support extglobs.
    const { Minimatch: Matcher }: typeof import("minimatch") = require("minimatch");
    matcher = new Matcher(pattern, {
      nocase: process.platform === "win32" || process.platform === "darwin",
      windowsPathsNoEscape: true,
      nonegate: true,
      nocomment: true,
      optimizationLevel: 2,
      platform: process.platform,
      nocaseMagicOnly: true,
    });
    globMatchers.set(pattern, matcher);
    if (globMatchers.size > 250) {
      const oldest = globMatchers.keys().next().value;
      if (oldest !== undefined) {
        globMatchers.delete(oldest);
      }
    }
  }
  return matcher.match(value);
}

function normalizeCliPattern(value: string): string {
  let normalized = value
    .trim()
    .replace(/^\.\/+/u, "")
    .replace(/\/+$/u, "");
  if (
    /^(?:src|test|extensions|ui|packages|apps)(?:\/|$)/u.test(normalized) &&
    !/[?*[\]{}]/u.test(normalized) &&
    !/\.(?:[cm]?[jt]sx?)$/u.test(normalized)
  ) {
    normalized = `${normalized}/**/*.test.*`;
  }
  return normalized;
}

function normalizeScopedDir(value: string | undefined): string {
  return value ? normalizeVitestPath(value.trim()).replace(/\/+$/u, "") : "";
}

function hasRepoRootPrefix(value: string): boolean {
  return /^(?:src|test|extensions|ui|packages|apps)(?:\/|$)/u.test(value);
}

function looksLikeDirRelativePath(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes(".test.") ||
    value.includes(".e2e.") ||
    value.includes(".live.")
  );
}

function applyScopedDir(value: string, scopedDir: string): string {
  const normalizedValue = normalizeVitestPath(value.trim().replace(/^\.\/+/u, ""));
  if (
    !scopedDir ||
    hasRepoRootPrefix(normalizedValue) ||
    path.isAbsolute(value) ||
    !looksLikeDirRelativePath(normalizedValue)
  ) {
    return normalizedValue;
  }
  return `${scopedDir}/${normalizedValue}`;
}

function looksLikeCliIncludePattern(value: string): boolean {
  const normalized = normalizeCliPattern(value);
  return (
    normalized.includes(".test.") ||
    normalized.includes(".e2e.") ||
    normalized.includes(".live.") ||
    /^(?:src|test|extensions|ui|packages|apps)(?:\/|$)/u.test(normalized)
  );
}

function loadPatternListFile(filePath: string, label: string): string[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${label} must point to a JSON array: ${filePath}`);
  }
  return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function loadPatternListFromEnv(
  envKey: string,
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const filePath = env[envKey]?.trim();
  if (!filePath) {
    return null;
  }
  return loadPatternListFile(filePath, envKey);
}

export function collectVitestExcludePatterns(args: string[]): string[] {
  const patterns: string[] = [];
  for (const [index, arg] of args.entries()) {
    if (arg === "--") {
      break;
    }
    const value =
      arg === "--exclude"
        ? args[index + 1]
        : arg.startsWith("--exclude=")
          ? arg.slice("--exclude=".length)
          : undefined;
    if (value) {
      patterns.push(value);
    }
  }
  return patterns;
}

function normalizeVitestPath(file: string): string {
  return path.sep === "\\" ? file.replaceAll("\\", "/") : file;
}

function normalizeCliFileFilter(filter: string): string {
  // Line qualifiers belong to native task selection, not physical discovery or wrapper routing.
  return normalizeVitestPath(filter.replace(/:\d+$/u, ""));
}

function narrowIncludePatternsForFilters(
  includePatterns: string[],
  filters: string[],
  options: { scopedDir?: string; root?: string },
) {
  const scopedDir = normalizeScopedDir(options.scopedDir);
  const patterns = filters
    .map((value) => applyScopedDir(value, scopedDir))
    .filter(looksLikeCliIncludePattern)
    .map(normalizeCliPattern);
  if (patterns.length === 0) return null;
  const root = options.root ?? repoRoot;
  return narrowIncludePatterns(includePatterns, [...new Set(patterns)], (value, pattern) =>
    matchesVitestGlob(path.resolve(root, value), path.resolve(root, pattern)),
  );
}

export function narrowIncludePatternsForCli(
  includePatterns: string[],
  argv: string[] = process.argv,
  options: { scopedDir?: string; root?: string } = {},
): string[] | null {
  // CLI operands may be absolute while canonical project ownership is repo-relative.
  return narrowIncludePatternsForFilters(
    includePatterns,
    collectVitestFileFilters(argv.slice(2)).map(normalizeCliFileFilter),
    options,
  );
}

export function relativizeScopedPatterns(values: readonly string[], dir = ""): string[] {
  const normalizedDir = normalizeVitestPath(dir).replace(/\/+$/u, "");
  return values.map((value) => {
    const sign = value[0] === "!" && value[1] !== "(" ? "!" : "";
    const normalized = normalizeVitestPath(value.slice(sign.length));
    if (!normalizedDir) {
      return sign + normalized;
    }
    if (normalized === normalizedDir) {
      return sign + ".";
    }
    const prefix = `${normalizedDir}/`;
    return sign + (normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized);
  });
}

/** Absolute selections keep owner exclusions in the same physical project, even under --dir. */
export function resolveNativeVitestExcludes(
  values: readonly string[],
  include: readonly string[],
  dir: string,
  effectiveDir = dir,
): string[] {
  const exclude = splitIncludePatterns(values).include;
  if (
    path.resolve(dir) === path.resolve(effectiveDir) &&
    !splitIncludePatterns(include).include.some((pattern) => path.isAbsolute(pattern))
  ) {
    return exclude;
  }
  const { convertPathToPattern }: typeof import("tinyglobby") = require("tinyglobby");
  const base = convertPathToPattern(path.resolve(dir));
  return exclude.map((value) => (path.isAbsolute(value) ? value : `${base}/${value}`));
}

/** Project one candidate through the same scoped include and CLI file filters as Vitest. */
export function matchesVitestCliSelection(
  file: string,
  include: string[],
  args: string[],
  scopedDir: string,
  env: NodeJS.ProcessEnv,
  selectedPatterns?: readonly string[] | null,
): boolean {
  const patterns =
    selectedPatterns ??
    loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env) ??
    narrowIncludePatternsForCli(include, ["node", "vitest", ...args], { scopedDir }) ??
    include;
  const selection = splitIncludePatterns(patterns);
  const relativeFile = path.posix.relative(scopedDir, file);
  const absoluteFile = normalizeVitestPath(path.resolve(repoRoot, file));
  if (
    !relativizeScopedPatterns(selection.include, scopedDir).some((pattern) =>
      matchesVitestGlob(path.isAbsolute(pattern) ? absoluteFile : relativeFile, pattern),
    ) ||
    [
      ...relativizeScopedPatterns(selection.exclude, scopedDir),
      ...collectVitestExcludePatterns(args),
    ].some((pattern) =>
      matchesVitestGlob(path.isAbsolute(pattern) ? absoluteFile : relativeFile, pattern),
    )
  ) {
    return false;
  }
  const filters = collectVitestFileFilters(args).map(normalizeCliFileFilter);
  const dir = path.resolve(repoRoot, scopedDir);
  // Vitest filterFiles uses OR/substring matching, not glob matching, after discovery.
  return (
    filters.length === 0 ||
    filters.some((filter) => {
      if (path.isAbsolute(filter) && absoluteFile.startsWith(filter)) {
        return true;
      }
      const relativeFilter = normalizeVitestPath(
        filter.endsWith("/")
          ? path.join(path.relative(dir, filter), "/")
          : path.relative(dir, filter),
      );
      return (
        relativeFile.toLocaleLowerCase().includes(filter.toLocaleLowerCase()) ||
        relativeFile.toLocaleLowerCase().includes(relativeFilter.toLocaleLowerCase())
      );
    })
  );
}

/** Prepare native invocation facts once, then discover each eligible project. */
export function createVitestCliDiscovery(args: string[], root = repoRoot) {
  // CI imports the planner before installation. Native parsing and discovery
  // belong to interactive execution, never to the module's import graph.
  const { parseCLI, createCLI }: typeof import("vitest/node") = require("vitest/node");
  const parsed = parseVitestExecutionArgs([...args], parseCLI);
  const normalizePath: unknown = createCLI().globalCommand.hasOption("dir")?.config.type;
  if (typeof normalizePath !== "function") {
    throw new Error("Vitest's native directory normalizer is unavailable");
  }
  const filters = (parsed?.filter ?? []).map((filter) =>
    String(normalizePath(`"${filter}"`)).replace(/:\d+$/u, ""),
  );
  // Vitest's project grammar is case-insensitive, anchored, and star-only.
  // File glob matchers would incorrectly interpret ?, [] and extglobs here.
  const projects = (parsed?.options.project ?? []).map((pattern) => ({
    excluded: pattern.startsWith("!"),
    matcher: new RegExp(
      `^${(pattern.startsWith("!") ? pattern.slice(1) : pattern)
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*")}$`,
      "i",
    ),
  }));
  return {
    projectStatus(name: string): "native" | "excluded" | "eligible" {
      if (!parsed) return "native";
      if (projects.some(({ excluded, matcher }) => excluded && matcher.test(name))) {
        return "excluded";
      }
      const positives = projects.filter(({ excluded }) => !excluded);
      return !positives.length || positives.some(({ matcher }) => matcher.test(name))
        ? "eligible"
        : "excluded";
    },
    effectiveDir(scopedDir = "") {
      return path.resolve(root, parsed?.options.dir ?? scopedDir);
    },
    discover(include: string[], dir: string, exclude: readonly string[] = []) {
      if (!parsed) return { available: [], selected: [] };
      const { globSync }: typeof import("tinyglobby") = require("tinyglobby");
      // The caller supplies final canonical scope facts. Re-projecting here
      // would move inherited exclusions or absolute selections under --dir.
      const files = globSync(include, {
        cwd: dir,
        dot: true,
        ignore: [...exclude, ...(parsed.options.exclude ?? [])],
        expandDirectories: false,
      });
      const nativeFilters = filters.map((filter) => ({
        filter,
        relative: normalizeVitestPath(
          filter.endsWith("/")
            ? path.join(path.relative(dir, path.resolve(root, filter)), "/")
            : path.relative(dir, path.resolve(root, filter)),
        ).toLocaleLowerCase(),
      }));
      const selected = files.filter((file) => {
        const absoluteFile = normalizeVitestPath(path.resolve(dir, file));
        const relativeFile = normalizeVitestPath(
          path.relative(dir, absoluteFile),
        ).toLocaleLowerCase();
        return (
          !nativeFilters.length ||
          nativeFilters.some(({ filter, relative }) =>
            path.isAbsolute(filter) && absoluteFile.startsWith(filter)
              ? true
              : relativeFile.includes(filter.toLocaleLowerCase()) ||
                relativeFile.includes(relative),
          )
        );
      });
      const toRepoPath = (file: string) =>
        normalizeVitestPath(path.relative(root, path.resolve(dir, file)));
      return { available: files.map(toRepoPath), selected: selected.map(toRepoPath) };
    },
  };
}
