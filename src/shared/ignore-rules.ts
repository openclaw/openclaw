import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ignore from "ignore";
import { readRegularFileSync } from "../infra/regular-file.js";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
// Ignore files are line-oriented pattern lists; a few MiB is generous headroom
// for monorepos while preventing a malicious or runaway file from OOMing the
// workspace scanner.
const IGNORE_FILE_MAX_BYTES = 4 * 1024 * 1024;
const IGNORE_MATCHER_MAX_PATTERNS = 20_000;
const IGNORE_PATTERN_MAX_CHARS = 16 * 1024;
const IGNORE_MATCHER_MAX_PATTERN_CHARS = IGNORE_FILE_MAX_BYTES;
// Returned instead of null when an ignore file exceeds IGNORE_FILE_MAX_BYTES so
// the caller can fail closed.
const OVERSIZED_IGNORE_FILE = Symbol("oversizedIgnoreFile");
const COMPLEX_IGNORE_FILE = Symbol("complexIgnoreFile");

type IgnoreRuleMatcher = ReturnType<typeof ignore>;
type IgnoreMatcherState = {
  rules: IgnoreRuleMatcher;
  excludedSubtrees: Set<string>;
  patternCount: number;
  patternChars: number;
};
const IGNORE_MATCHER_STATE: unique symbol = Symbol("ignoreMatcherState");

export type IgnoreMatcher = {
  readonly [IGNORE_MATCHER_STATE]: IgnoreMatcherState;
  ignores(pathname: string): boolean;
};

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

function createIgnoreMatcher(): IgnoreMatcher {
  const state: IgnoreMatcherState = {
    rules: ignore(),
    excludedSubtrees: new Set<string>(),
    patternCount: 0,
    patternChars: 0,
  };
  return {
    [IGNORE_MATCHER_STATE]: state,
    ignores: (pathname) =>
      isInLiteralSubtree(pathname, state.excludedSubtrees) || state.rules.ignores(pathname),
  };
}

function addFailClosedSubtree(matcher: IgnoreMatcher, prefix: string): void {
  matcher[IGNORE_MATCHER_STATE].excludedSubtrees.add(
    prefix.endsWith("/") ? prefix.slice(0, -1) : prefix,
  );
}

function parseIgnorePatterns(
  content: string,
  prefix: string,
  budget: { patterns: number; chars: number },
): { patterns: string[]; chars: number } | typeof COMPLEX_IGNORE_FILE {
  const patterns: string[] = [];
  let patternChars = 0;
  let lineStart = 0;

  while (lineStart <= content.length) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    const contentEnd = lineEnd > lineStart && content[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    const pattern = prefixIgnorePattern(content.slice(lineStart, contentEnd), prefix);
    if (pattern) {
      if (pattern.length > IGNORE_PATTERN_MAX_CHARS || patterns.length >= budget.patterns) {
        return COMPLEX_IGNORE_FILE;
      }
      patternChars += pattern.length;
      if (patternChars > budget.chars) {
        return COMPLEX_IGNORE_FILE;
      }
      patterns.push(pattern);
    }
    if (newline === -1) {
      break;
    }
    lineStart = newline + 1;
  }
  return { patterns, chars: patternChars };
}

export const toPosixPath = (pathValue: string) => pathValue.split(sep).join("/");

/** Adds nested ignore-file rules to a matcher using paths relative to the scan root. */
export function addIgnoreRules(
  dir: string,
  rootDir: string,
  ig: IgnoreMatcher = createIgnoreMatcher(),
): IgnoreMatcher {
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
      addFailClosedSubtree(ig, prefix);
      break;
    }
    if (content === null) {
      continue;
    }
    const state = ig[IGNORE_MATCHER_STATE];
    const parsed = parseIgnorePatterns(content, prefix, {
      patterns: IGNORE_MATCHER_MAX_PATTERNS - state.patternCount,
      chars: IGNORE_MATCHER_MAX_PATTERN_CHARS - state.patternChars,
    });
    if (parsed === COMPLEX_IGNORE_FILE) {
      addFailClosedSubtree(ig, prefix);
      break;
    }
    if (parsed.patterns.length > 0) {
      state.rules.add(parsed.patterns);
      state.patternCount += parsed.patterns.length;
      state.patternChars += parsed.chars;
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
