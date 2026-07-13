import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ignore from "ignore";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export type IgnoreMatcher = ReturnType<typeof ignore>;

export function toPosixPath(pathValue: string): string {
  return pathValue.split(sep).join("/");
}

/** Adds nested ignore-file rules to a matcher using paths relative to the scan root. */
export function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
  const relativeDir = relative(rootDir, dir);
  const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, filename);
    if (!existsSync(ignorePath)) {
      continue;
    }
    try {
      const content = readFileSync(ignorePath, "utf-8");
      const patterns = content
        .split(/\r?\n/)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => Boolean(line));
      if (patterns.length > 0) {
        ig.add(patterns);
      }
    } catch {}
  }
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) {
    return null;
  }

  let pattern = line;
  let negated = false;

  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }
  // Keep escaped "!" intact; the ignore library handles "\!" as a literal filename.

  let anchored = false;
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  }

  const slashIndex = pattern.indexOf("/");
  if (slashIndex !== -1 && slashIndex !== pattern.length - 1) {
    anchored = true;
  }

  // A pattern without a middle/beginning slash matches at any depth below the
  // ignore file's directory; prefix with **/ so the ignore library agrees.
  const needsDepthGlob = prefix && !anchored;
  const prefixed = prefix
    ? needsDepthGlob
      ? `${prefix}**/${pattern}`
      : `${prefix}${pattern}`
    : pattern;
  return negated ? `!${prefixed}` : prefixed;
}
