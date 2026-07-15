import { existsSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ignore from "ignore";
import { readRegularFileSync } from "../infra/regular-file.js";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
// Ignore files are line-oriented pattern lists; a few MiB is generous headroom
// for monorepos while preventing a malicious or runaway file from OOMing the
// workspace scanner.
const IGNORE_FILE_MAX_BYTES = 4 * 1024 * 1024;
// Returned instead of null when an ignore file exceeds IGNORE_FILE_MAX_BYTES so
// the caller can fail closed; fs-safe signals oversize only via a generic
// message, so the size is checked directly before the bounded read.
const OVERSIZED_IGNORE_FILE = Symbol("oversizedIgnoreFile");

export type IgnoreMatcher = ReturnType<typeof ignore>;

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
      // the scan surface files the user asked to hide.
      ig.add(`${prefix}**`);
      continue;
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

function readIgnoreFileContent(
  ignorePath: string,
): string | null | typeof OVERSIZED_IGNORE_FILE {
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
    if (statSync(resolvedPath).size > IGNORE_FILE_MAX_BYTES) {
      return OVERSIZED_IGNORE_FILE;
    }
    const { buffer } = readRegularFileSync({
      filePath: resolvedPath,
      maxBytes: IGNORE_FILE_MAX_BYTES,
    });
    return buffer.toString("utf-8");
  } catch {
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
