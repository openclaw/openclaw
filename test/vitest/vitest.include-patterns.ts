import path from "node:path";

type GlobMatcher = (value: string, pattern: string) => boolean;

function nonBrowserPattern(extension: string): string {
  return `!(*.browser.test.${extension}|!(*.test.${extension}))`;
}

export const nonBrowserTestBasenamePattern = nonBrowserPattern("{ts,tsx}");

export function resolveNonBrowserTestPattern(pattern: string): string | null {
  for (const extension of ["{ts,tsx}", "ts", "tsx"]) {
    const basename = nonBrowserPattern(extension);
    if (!pattern.endsWith(basename)) {
      continue;
    }
    const prefix = pattern.slice(0, -basename.length);
    if (prefix && !prefix.endsWith("/") && !prefix.endsWith("\\")) {
      return null;
    }
    return prefix + `!(*.browser).test.${extension}`;
  }
  return null;
}

export function filterFilesByPatterns(
  files: readonly string[],
  include: readonly string[],
  exclude: readonly string[],
  matchesGlob: GlobMatcher,
): string[] {
  const selected = new Set<string>();
  // Finish each pattern before advancing so large inventories do not churn
  // the runtime's bounded compiled-glob cache for every candidate file.
  for (const pattern of include) {
    for (const file of files) {
      if (!selected.has(file) && matchesGlob(file, pattern)) {
        selected.add(file);
      }
    }
  }
  for (const pattern of exclude) {
    for (const file of selected) {
      if (matchesGlob(file, pattern)) {
        selected.delete(file);
      }
    }
  }
  return files.filter((file) => selected.has(file));
}

function literalPrefixForGlobPattern(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const globIndex = normalized.search(/[?*[\]{}]/u);
  if (globIndex === -1) {
    return normalized;
  }
  const slashIndex = normalized.lastIndexOf("/", globIndex);
  return slashIndex === -1 ? "" : normalized.slice(0, slashIndex + 1);
}

function patternsCouldOverlap(value: string, pattern: string, matchesGlob: GlobMatcher): boolean {
  if (matchesGlob(value, pattern) || matchesGlob(pattern, value)) {
    return true;
  }

  const valuePrefix = literalPrefixForGlobPattern(value);
  const patternPrefix = literalPrefixForGlobPattern(pattern);
  return (
    patternPrefix === "" ||
    valuePrefix === "" ||
    valuePrefix.startsWith(patternPrefix) ||
    patternPrefix.startsWith(valuePrefix)
  );
}

export function narrowIncludePatterns(
  includePatterns: string[],
  candidatePatterns: string[] | null,
  matchesGlob: GlobMatcher,
): string[] | null {
  if (!candidatePatterns) {
    return null;
  }

  // Prefix overlap alone cannot prove containment. Only narrow literal files
  // and plain directory test patterns; preserve more complex owner globs.
  const narrowed = new Set<string>();
  for (const candidate of candidatePatterns) {
    const isLiteral = !/[?*[\]{}]/u.test(candidate);
    const directoryCandidate = candidate.replace(
      /\.test\.\*$/u,
      includePatterns.some((pattern) => pattern.includes("tsx")) ? ".test.{ts,tsx}" : ".test.ts",
    );
    const candidateRoot = directoryTestPatternRoot(directoryCandidate);
    for (const laneScope of includePatterns) {
      if (isLiteral) {
        if (matchesGlob(candidate, laneScope)) {
          narrowed.add(candidate);
        }
      } else if (patternsCouldOverlap(candidate, laneScope, matchesGlob)) {
        const ownerRoot = directoryTestPatternRoot(laneScope);
        if (candidateRoot !== null && ownerRoot !== null && isAtOrUnder(candidateRoot, ownerRoot)) {
          for (const pattern of intersectTestExtensions(directoryCandidate, laneScope)) {
            narrowed.add(pattern);
          }
        } else {
          for (const pattern of intersectTestExtensions(laneScope, candidate)) {
            narrowed.add(pattern);
          }
        }
      }
    }
  }
  return [...narrowed];
}

export function isPlainRepoRelativePath(value: string): boolean {
  if (!/^[A-Za-z0-9_./-]+$/u.test(value) || path.isAbsolute(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function directoryTestPatternRoot(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  const suffix = normalized.match(/(?:^|\/)\*\*\/\*\.test\.(?:tsx?|\{ts,tsx\})$/u)?.[0];
  if (suffix === normalized) {
    return "";
  }
  if (!suffix) {
    return null;
  }
  const root = normalized.slice(0, -suffix.length);
  return isPlainRepoRelativePath(root) ? root : null;
}

function isAtOrUnder(value: string, root: string): boolean {
  return root === "" || value === root || value.startsWith(`${root}/`);
}

function patternIsFullyUnderDirectory(pattern: string, root: string): boolean {
  const normalized = pattern.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  const testPattern = resolveNonBrowserTestPattern(normalized) ?? normalized;
  if (!/\.test\.(?:tsx?|\{ts,tsx\})$/u.test(testPattern)) {
    return false;
  }
  const literalPrefix = literalPrefixForGlobPattern(testPattern).replace(/\/+$/u, "");
  return isAtOrUnder(literalPrefix, root);
}

function intersectDirectoryTestPattern(
  includePatterns: string[],
  candidatePattern: string,
  matchesGlob: GlobMatcher,
): string[] | null {
  const candidateRoot = directoryTestPatternRoot(candidatePattern);
  if (candidateRoot === null) {
    const containingPatterns = includePatterns.filter((pattern) => {
      const includeRoot = directoryTestPatternRoot(pattern);
      return includeRoot !== null && patternIsFullyUnderDirectory(candidatePattern, includeRoot);
    });
    return containingPatterns.length === 0
      ? null
      : [
          ...new Set(
            containingPatterns.flatMap((pattern) =>
              intersectTestExtensions(candidatePattern, pattern),
            ),
          ),
        ];
  }

  const result: string[] = [];
  let hasAmbiguousOverlap = false;
  for (const includePattern of includePatterns) {
    const includeRoot = directoryTestPatternRoot(includePattern);
    if (includeRoot !== null && isAtOrUnder(candidateRoot, includeRoot)) {
      const intersection = intersectTestExtensions(candidatePattern, includePattern);
      if (intersection.includes(candidatePattern)) {
        return intersection;
      }
      result.push(...intersection);
    } else if (patternIsFullyUnderDirectory(includePattern, candidateRoot)) {
      result.push(...intersectTestExtensions(includePattern, candidatePattern));
    } else if (patternsCouldOverlap(candidatePattern, includePattern, matchesGlob)) {
      hasAmbiguousOverlap = true;
    }
  }
  if (hasAmbiguousOverlap) {
    return null;
  }
  return [...new Set(result)];
}

function intersectTestExtensions(pattern: string, constraint: string): string[] {
  const normalized = resolveNonBrowserTestPattern(pattern) ?? pattern;
  const suffix = /\.test\.(tsx?|\{ts,tsx\})$/u;
  const extension = normalized.match(suffix)?.[1];
  const allowed = (resolveNonBrowserTestPattern(constraint) ?? constraint).match(suffix)?.[1];
  if (!extension || !allowed || allowed === "{ts,tsx}" || extension === allowed) {
    return [pattern];
  }
  if (extension !== "{ts,tsx}") {
    return [];
  }
  return [
    resolveNonBrowserTestPattern(pattern)
      ? pattern.slice(0, -nonBrowserTestBasenamePattern.length) + nonBrowserPattern(allowed)
      : pattern.replace(suffix, `.test.${allowed}`),
  ];
}

export function intersectIncludePatterns(
  includePatterns: string[],
  candidatePatterns: string[] | null,
  matchesGlob: GlobMatcher,
): string[] | null {
  if (!candidatePatterns) {
    return null;
  }

  const literalIncludes = includePatterns.every(isPlainRepoRelativePath)
    ? new Set(includePatterns)
    : null;
  const result: string[] = [];
  for (const candidate of candidatePatterns) {
    if (!isPlainRepoRelativePath(candidate)) {
      if (literalIncludes) {
        result.push(...includePatterns.filter((include) => matchesGlob(include, candidate)));
        continue;
      }
      if (includePatterns.includes(candidate)) {
        result.push(candidate);
        continue;
      }
      // Watch directory targets retain their glob so newly added tests appear.
      // Only generated directory globs have a provable ownership intersection.
      const intersection = intersectDirectoryTestPattern(includePatterns, candidate, matchesGlob);
      if (!intersection) {
        throw new Error(`cannot safely intersect non-literal include path: ${candidate}`);
      }
      result.push(...intersection);
      continue;
    }
    if (
      literalIncludes
        ? literalIncludes.has(candidate)
        : includePatterns.some((include) => matchesGlob(candidate, include))
    ) {
      result.push(candidate);
    }
  }

  return [...new Set(result)];
}
