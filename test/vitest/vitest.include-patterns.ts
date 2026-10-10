import path from "node:path";

type GlobMatcher = (value: string, pattern: string) => boolean;

export const nonBrowserTestBasenamePattern = "!(*.browser.test.ts|!(*.test.ts))";
export const nonBrowserTsxTestBasenamePattern = "!(*.browser.test.tsx|!(*.test.tsx))";

export function resolveNonBrowserTestPattern(pattern: string): string | null {
  const basename = [nonBrowserTestBasenamePattern, nonBrowserTsxTestBasenamePattern].find(
    (candidate) => pattern.endsWith(candidate),
  );
  if (!basename) {
    return null;
  }
  const prefix = pattern.slice(0, -basename.length);
  if (prefix && !prefix.endsWith("/") && !prefix.endsWith("\\")) {
    return null;
  }
  return (
    prefix +
    (basename === nonBrowserTestBasenamePattern ? "!(*.browser).test.ts" : "!(*.browser).test.tsx")
  );
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
    for (const laneScope of includePatterns) {
      const directoryCandidate = candidate.replace(
        /\.test\.\*$/u,
        laneScope.endsWith(".tsx") ? ".test.tsx" : ".test.ts",
      );
      const candidateRoot = directoryTestPatternRoot(directoryCandidate);
      if (isLiteral) {
        if (matchesGlob(candidate, laneScope)) {
          narrowed.add(candidate);
        }
      } else if (patternsCouldOverlap(candidate, laneScope, matchesGlob)) {
        const ownerRoot = directoryTestPatternRoot(laneScope);
        narrowed.add(
          candidateRoot !== null && ownerRoot !== null && isAtOrUnder(candidateRoot, ownerRoot)
            ? directoryCandidate
            : laneScope,
        );
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
  const match = /^(?:(.+)\/)?\*\*\/\*\.test\.tsx?$/u.exec(normalized);
  if (!match) {
    return null;
  }
  const root = match[1] ?? "";
  return root === "" || isPlainRepoRelativePath(root) ? root : null;
}

function isAtOrUnder(value: string, root: string): boolean {
  return root === "" || value === root || value.startsWith(`${root}/`);
}

function patternIsFullyUnderDirectory(pattern: string, root: string): boolean {
  const normalized = pattern.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  const testPattern = resolveNonBrowserTestPattern(normalized) ?? normalized;
  if (!/\.test\.tsx?$/u.test(testPattern)) {
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
  const candidateExtension = /\.test\.(tsx?)$/u.exec(candidatePattern)?.[1];
  const compatiblePatterns = includePatterns.filter((pattern) => {
    const extension = /\.test\.(tsx?)$/u.exec(
      resolveNonBrowserTestPattern(pattern) ?? pattern,
    )?.[1];
    return !candidateExtension || !extension || candidateExtension === extension;
  });
  const candidateRoot = directoryTestPatternRoot(candidatePattern);
  if (candidateRoot === null) {
    return compatiblePatterns.some((pattern) => {
      const includeRoot = directoryTestPatternRoot(pattern);
      return includeRoot !== null && patternIsFullyUnderDirectory(candidatePattern, includeRoot);
    })
      ? [candidatePattern]
      : null;
  }

  const result: string[] = [];
  let hasAmbiguousOverlap = false;
  for (const includePattern of compatiblePatterns) {
    const includeRoot = directoryTestPatternRoot(includePattern);
    if (includeRoot !== null && isAtOrUnder(candidateRoot, includeRoot)) {
      return [candidatePattern];
    } else if (patternIsFullyUnderDirectory(includePattern, candidateRoot)) {
      result.push(includePattern);
    } else if (patternsCouldOverlap(candidatePattern, includePattern, matchesGlob)) {
      hasAmbiguousOverlap = true;
    }
  }
  if (hasAmbiguousOverlap) {
    return null;
  }
  return [...new Set(result)];
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
