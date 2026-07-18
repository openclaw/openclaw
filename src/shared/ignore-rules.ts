import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ignore from "ignore";
import { readRegularFileSync } from "../infra/regular-file.js";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
// Ignore files are line-oriented pattern lists; a few MiB is generous headroom
// for monorepos while preventing a malicious or runaway file from OOMing the
// workspace scanner.
const IGNORE_FILE_MAX_BYTES = 4 * 1024 * 1024;
// Returned instead of null when an ignore file exceeds IGNORE_FILE_MAX_BYTES so
// the caller can fail closed.
const OVERSIZED_IGNORE_FILE = Symbol("oversizedIgnoreFile");

export type IgnoreMatcher = ReturnType<typeof ignore>;

const literalExcludedSubtrees = new WeakMap<IgnoreMatcher, Set<string>>();

function isInLiteralSubtree(pathname: string, subtrees: Set<string>): boolean {
  const posixPath = toPosixPath(pathname);
  const normalized = posixPath.endsWith("/") ? posixPath.slice(0, -1) : posixPath;
  for (const subtree of subtrees) {
    if (!subtree || normalized === subtree || normalized.startsWith(`${subtree}/`)) {
      return true;
    }
  }
  return false;
}

function excludeLiteralSubtree(matcher: IgnoreMatcher, subtree: string): void {
  const existing = literalExcludedSubtrees.get(matcher);
  if (existing) {
    existing.add(subtree);
    return;
  }

  const subtrees = new Set([subtree]);
  literalExcludedSubtrees.set(matcher, subtrees);
  const originalIgnores = matcher.ignores.bind(matcher);
  const originalTest = matcher.test.bind(matcher);
  const originalCheckIgnore = matcher.checkIgnore.bind(matcher);

  matcher.ignores = (pathname) =>
    isInLiteralSubtree(pathname, subtrees) || originalIgnores(pathname);
  matcher.test = (pathname) =>
    isInLiteralSubtree(pathname, subtrees)
      ? { ignored: true, unignored: false }
      : originalTest(pathname);
  matcher.checkIgnore = (pathname) =>
    isInLiteralSubtree(pathname, subtrees)
      ? { ignored: true, unignored: false }
      : originalCheckIgnore(pathname);
  matcher.filter = (pathnames) => pathnames.filter((pathname) => !matcher.ignores(pathname));
  matcher.createFilter = () => (pathname) => !matcher.ignores(pathname);
}

export const toPosixPath = (pathValue: string) => pathValue.split(sep).join("/");

/** Adds nested ignore-file rules to a matcher using paths relative to the scan root. */
export function addIgnoreRules(dir: string, rootDir: string, ig = ignore()): IgnoreMatcher {
  const relativeDir = relative(rootDir, dir);
  const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, filename);
    if (!existsSync(ignorePath)) {
      continue;
    }
    const content = readIgnoreFileContent(ignorePath);
    if (content === OVERSIZED_IGNORE_FILE) {
      // Fail closed: an oversized ignore file cannot be parsed, so conservatively
      // exclude its whole subtree. Skipping it would drop every exclusion and let
      // the scan surface files the user asked to hide. Stop here so a later
      // ignore file in this directory cannot negate the exclusion and reopen a
      // subtree whose policy could not be parsed.
      // Filesystem paths are literal, but gitignore patterns treat characters
      // such as #, !, [, *, and ? specially. Keep the fail-closed subtree as a
      // literal path predicate so unusual directory names cannot reopen it.
      const subtree = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
      excludeLiteralSubtree(ig, subtree);
      break;
    }
    if (content === null) {
      continue;
    }
    const patterns = content
      .split(/\r?\n/)
      .map((line) => prefixIgnorePattern(line, prefix))
      .filter((line): line is string => Boolean(line));
    if (patterns.length > 0) {
      ig.add(patterns);
    }
  }
  return ig;
}

function readIgnoreFileContent(ignorePath: string): string | null | typeof OVERSIZED_IGNORE_FILE {
  // readRegularFileSync rejects symlink final paths, but legacy ignore-file
  // loading followed symlinks. Resolve any symlink chain to the final regular
  // target so the bounded read still honors the original semantics.
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(ignorePath);
  } catch {
    return null;
  }
  try {
    const { buffer } = readRegularFileSync({
      filePath: resolvedPath,
      maxBytes: IGNORE_FILE_MAX_BYTES,
    });
    return buffer.toString("utf-8");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(`File exceeds ${IGNORE_FILE_MAX_BYTES} bytes:`)
    ) {
      return OVERSIZED_IGNORE_FILE;
    }
    return null;
  }
}

function prefixIgnorePattern(line: string, prefix: string): string {
  const trimmed = line.trim();
  if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) {
    return "";
  }

  const negated = line.startsWith("!");
  const pattern = negated ? line.slice(1) : line;
  const anchored = pattern.startsWith("/");
  const normalized = anchored ? pattern.slice(1) : pattern;
  // Git trims spaces only; escaped slashes still anchor rather than broaden nested rules.
  const matchPattern = normalized.replace(/ +$/, "");
  const depthGlob = prefix && !anchored && !matchPattern.slice(0, -1).includes("/") ? "**/" : "";
  const prefixed = `${prefix}${depthGlob}${normalized}`;
  return negated ? `!${prefixed}` : prefixed;
}
