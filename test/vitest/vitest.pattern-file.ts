// Vitest pattern file helper reads include and exclude patterns from files.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Minimatch } from "minimatch";
import { collectVitestFileFilters } from "../../scripts/lib/vitest-cli-mode.mts";
import { narrowIncludePatterns, relativizeScopedPatterns } from "./vitest.include-patterns.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const globMatchers = new Map<string, Minimatch>();

export function matchesVitestGlob(value: string, pattern: string): boolean {
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
  return value?.trim().replaceAll("\\", "/").replace(/\/+$/u, "") ?? "";
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
  const normalizedValue = value
    .trim()
    .replace(/^\.\/+/u, "")
    .replaceAll("\\", "/");
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

function normalizeCliFileFilter(filter: string): string {
  // Line qualifiers belong to native task selection, not physical discovery or wrapper routing.
  const file = filter.replace(/:\d+$/u, "");
  return process.platform === "win32" ? file.replaceAll("\\", "/") : file;
}

function loadPatternListFromArgvForScope(
  argv: string[] = process.argv,
  options: { scopedDir?: string } = {},
): string[] | null {
  const scopedDir = normalizeScopedDir(options.scopedDir);
  const patterns = collectVitestFileFilters(argv.slice(2))
    .map(normalizeCliFileFilter)
    .map((value) => applyScopedDir(value, scopedDir))
    .filter(looksLikeCliIncludePattern)
    .map(normalizeCliPattern);

  return patterns.length > 0 ? [...new Set(patterns)] : null;
}

export function narrowIncludePatternsForCli(
  includePatterns: string[],
  argv: string[] = process.argv,
  options: { scopedDir?: string } = {},
): string[] | null {
  const cliPatterns = loadPatternListFromArgvForScope(argv, options);
  if (!cliPatterns) {
    return null;
  }

  return narrowIncludePatterns(includePatterns, cliPatterns, matchesVitestGlob);
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
  const relativeFile = path.posix.relative(scopedDir, file);
  const absoluteFile = path.resolve(repoRoot, file);
  if (
    !relativizeScopedPatterns(patterns, scopedDir).some((pattern) =>
      matchesVitestGlob(path.isAbsolute(pattern) ? absoluteFile : relativeFile, pattern),
    ) ||
    collectVitestExcludePatterns(args).some((pattern) =>
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
      const relativeFilter = filter.endsWith("/")
        ? path.join(path.relative(dir, filter), "/")
        : path.relative(dir, filter);
      return (
        relativeFile.toLocaleLowerCase().includes(filter.toLocaleLowerCase()) ||
        relativeFile.toLocaleLowerCase().includes(relativeFilter.toLocaleLowerCase())
      );
    })
  );
}
