import path from "node:path";

export type GlobMatcher = (value: string, pattern: string) => boolean;

export type VitestPatternSelection = {
  include: string[];
  exclude: string[];
};

export function splitIncludePatterns(patterns: readonly string[]): VitestPatternSelection {
  const include = new Set<string>();
  const exclude = new Set<string>();
  for (const pattern of patterns) {
    // tinyglobby treats !(...) as an extglob, strips one exclusion bang,
    // and ignores other double negations. Split before normalizing escapes.
    if (pattern[0] !== "!" || pattern[1] === "(") {
      include.add(pattern);
    } else if (pattern[1] !== "!" || pattern[2] === "(") {
      exclude.add(pattern.slice(1));
    }
  }
  return { include: [...include], exclude: [...exclude] };
}

/** The include-file transport remains a native glob list. */
export function serializeIncludePatterns(selection: VitestPatternSelection): string[] {
  return [...selection.include, ...selection.exclude.map((pattern) => `!${pattern}`)];
}

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
  const selection = splitIncludePatterns(include);
  const selected = new Set<string>();
  // Finish each pattern before advancing so large inventories do not churn
  // the runtime's bounded compiled-glob cache for every candidate file.
  for (const pattern of selection.include) {
    for (const file of files) {
      if (!selected.has(file) && matchesGlob(file, pattern)) {
        selected.add(file);
      }
    }
  }
  for (const pattern of [...selection.exclude, ...splitIncludePatterns(exclude).include]) {
    for (const file of selected) {
      if (matchesGlob(file, pattern)) {
        selected.delete(file);
      }
    }
  }
  return files.filter((file) => selected.has(file));
}

function literalPrefixForGlobPattern(value: string): string {
  const normalized = value;
  const globIndex = normalized.search(/[?*[\]{}]|[@+!]\(/u);
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
  const owner = splitIncludePatterns(includePatterns);
  const candidateSelection = splitIncludePatterns(candidatePatterns);
  includePatterns = owner.include;
  candidatePatterns = candidateSelection.include;

  // Prefix overlap alone cannot prove containment. Only narrow literal files
  // and plain directory test patterns; preserve more complex owner globs.
  const narrowed = new Set<string>();
  for (const candidate of candidatePatterns) {
    const isLiteral = !/[?*[\]{}]|[@+!]\(/u.test(candidate);
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
  return serializeIncludePatterns({
    include: [...narrowed],
    exclude: [...new Set([...owner.exclude, ...candidateSelection.exclude])],
  });
}

export function isPlainRepoRelativePath(value: string): boolean {
  if (!/^[A-Za-z0-9_./-]+$/u.test(value) || path.isAbsolute(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isLiteralComparisonPath(value: string): boolean {
  return /^[A-Za-z0-9_./-]+$/u.test(value);
}

function directoryTestPatternRoot(value: string): string | null {
  const normalized = value.trim().replace(/^\.\//u, "");
  const suffix = normalized.match(/(?:^|\/)\*\*\/\*\.test\.(?:tsx?|\{ts,tsx\})$/u)?.[0];
  if (suffix === normalized) {
    return "";
  }
  if (!suffix) {
    return null;
  }
  const root = normalized.slice(0, -suffix.length);
  return isLiteralComparisonPath(root) ? root : null;
}

function isAtOrUnder(value: string, root: string): boolean {
  // Compare canonical literal ancestry: lexical prefixes can cross an owner via "..".
  if (path.posix.isAbsolute(value) !== path.posix.isAbsolute(root)) return false;
  const relative = path.posix.relative(root || ".", value || ".");
  return (
    relative === "" ||
    (!relative.startsWith("../") && relative !== ".." && !path.posix.isAbsolute(relative))
  );
}

function patternIsFullyUnderDirectory(pattern: string, root: string): boolean {
  const normalized = pattern.trim().replace(/^\.\//u, "");
  const testPattern = resolveNonBrowserTestPattern(normalized) ?? normalized;
  if (!/\.test\.(?:tsx?|\{ts,tsx\})$/u.test(testPattern)) {
    return false;
  }
  const literalPrefix = literalPrefixForGlobPattern(testPattern).replace(/\/+$/u, "");
  if (testPattern.slice(literalPrefix.length).split("/").includes("..")) return false;
  return isAtOrUnder(literalPrefix, root);
}

function recursiveTestPatternTemplate(value: string): string | null {
  return value.match(/^((?:.*\/)?\*\*\/[^/]+\.test\.)(?:tsx?|\{ts,tsx\})$/u)?.[1] ?? null;
}

function intersectDirectoryTestPattern(
  includePatterns: string[],
  candidatePattern: string,
  matchesGlob: GlobMatcher,
  emit: (pattern: string, include: string) => string[],
): string[] | null {
  const candidateRoot = directoryTestPatternRoot(candidatePattern);
  if (candidateRoot === null) {
    const template = recursiveTestPatternTemplate(candidatePattern);
    const result: string[] = [];
    let hasAmbiguousOverlap = false;
    for (const pattern of includePatterns) {
      const includeRoot = directoryTestPatternRoot(pattern);
      // Equal complete templates differ only in their terminal test extensions.
      // A partial match cannot hide another owner's unresolved overlap.
      if (
        (template !== null && template === recursiveTestPatternTemplate(pattern)) ||
        (includeRoot !== null && patternIsFullyUnderDirectory(candidatePattern, includeRoot))
      ) {
        const intersection = intersectTestExtensions(candidatePattern, pattern);
        const emitted = intersection.flatMap((value) => emit(value, pattern));
        if (intersection.includes(candidatePattern)) return emitted;
        result.push(...emitted);
      } else if (patternsCouldOverlap(candidatePattern, pattern, matchesGlob)) {
        hasAmbiguousOverlap = true;
      }
    }
    return hasAmbiguousOverlap ? null : [...new Set(result)];
  }

  const result: string[] = [];
  let hasAmbiguousOverlap = false;
  for (const includePattern of includePatterns) {
    const includeRoot = directoryTestPatternRoot(includePattern);
    if (includeRoot !== null && isAtOrUnder(candidateRoot, includeRoot)) {
      const intersection = intersectTestExtensions(candidatePattern, includePattern);
      const emitted = intersection.flatMap((pattern) => emit(pattern, includePattern));
      if (intersection.includes(candidatePattern)) {
        return emitted;
      }
      result.push(...emitted);
    } else if (patternIsFullyUnderDirectory(includePattern, candidateRoot)) {
      result.push(
        ...intersectTestExtensions(includePattern, candidatePattern).flatMap((pattern) =>
          emit(pattern, includePattern),
        ),
      );
    } else if (patternsCouldOverlap(candidatePattern, includePattern, matchesGlob)) {
      // Restrict a recursive basename pattern without moving a fixed suffix
      // directory: P/**/nested/x cannot be rewritten to C/**/nested/x.
      const recursive = includePattern.match(/^(.*\/)?\*\*\/([^/]+\.test\.(?:tsx?|\{ts,tsx\}))$/u);
      const root = recursive ? (recursive[1] ?? "").replace(/\/$/u, "") : undefined;
      const basename = recursive?.[2];
      if (
        basename &&
        root !== undefined &&
        (root === "" || isLiteralComparisonPath(root)) &&
        isAtOrUnder(candidateRoot, root)
      ) {
        const narrowed = `${candidateRoot ? `${candidateRoot}/` : ""}**/${basename}`;
        result.push(
          ...intersectTestExtensions(narrowed, candidatePattern).flatMap((pattern) =>
            emit(pattern, includePattern),
          ),
        );
      } else {
        hasAmbiguousOverlap = true;
      }
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

type PreparedIncludePatterns = {
  patterns: string[];
  literalIncludes: Set<string> | null;
  order: Map<string, number>;
};

function prepareIncludePatterns(order: Map<string, number>): PreparedIncludePatterns {
  const patterns = [...order.keys()];
  return {
    patterns,
    literalIncludes: patterns.every(isLiteralComparisonPath) ? new Set(patterns) : null,
    order,
  };
}

function intersectCandidatePattern(
  { patterns: includePatterns, literalIncludes }: PreparedIncludePatterns,
  candidate: string,
  matchesGlob: GlobMatcher,
  emit: (pattern: string, include: string) => string[],
): string[] {
  if (!isLiteralComparisonPath(candidate)) {
    if (literalIncludes) {
      return includePatterns
        .filter((include) => matchesGlob(include, candidate))
        .flatMap((include) => emit(include, include));
    }
    if (includePatterns.includes(candidate)) {
      return emit(candidate, candidate);
    }
    // Watch directory targets retain their glob so newly added tests appear.
    // Narrow only structurally provable directory or recursive-basename intersections.
    const intersection = intersectDirectoryTestPattern(
      includePatterns,
      candidate,
      matchesGlob,
      emit,
    );
    if (!intersection) {
      throw new Error(`cannot safely intersect non-literal include path: ${candidate}`);
    }
    return intersection;
  }
  const matching = literalIncludes
    ? literalIncludes.has(candidate)
      ? [candidate]
      : []
    : includePatterns.filter((include) => matchesGlob(candidate, include));
  return matching.flatMap((include) => emit(candidate, include));
}

export function intersectIncludePatterns(
  includePatterns: string[],
  candidatePatterns: string[] | null,
  matchesGlob: GlobMatcher,
  root?: string,
  candidateRoot = root,
  absolutePattern = (value: string, basis: string) =>
    path.resolve(basis, value).split(path.sep).join("/"),
): VitestPatternSelection | null {
  if (!candidatePatterns) {
    return null;
  }
  const owner = splitIncludePatterns(includePatterns);
  const candidateSelection = splitIncludePatterns(candidatePatterns);
  includePatterns = owner.include;
  candidatePatterns = candidateSelection.include;
  // Compare on the caller's basis, but retain both operands' path provenance.
  // Emitting an absolute constraint as relative changes its meaning under --dir.
  const relative = (value: string, basis = root) =>
    root && basis
      ? path.posix.relative(absolutePattern(".", root), absolutePattern(value, basis))
      : value;
  const groups = new Map<boolean, Map<string, number>>();
  const allIncludes = new Map<string, number>();
  for (const [index, include] of includePatterns.entries()) {
    const absolute = Boolean(root) && path.isAbsolute(include);
    const group = groups.get(absolute) ?? new Map<string, number>();
    const key = relative(include);
    if (!group.has(key)) group.set(key, index);
    if (!allIncludes.has(key)) allIncludes.set(key, index);
    groups.set(absolute, group);
  }
  const preparedGroups = new Map(
    [...groups].map(([absolute, group]) => [absolute, prepareIncludePatterns(group)]),
  );
  const absoluteGroup = new Map([[true, prepareIncludePatterns(allIncludes)]]);
  const result: string[] = [];
  for (const originalCandidate of candidatePatterns) {
    const candidate = relative(originalCandidate, candidateRoot);
    const candidateGroups =
      root && path.isAbsolute(originalCandidate) ? absoluteGroup : preparedGroups;
    const emittedOrder = new Map<string, number>();
    const selected: string[] = [];
    // Covering globs may elide narrower paths only on the same output basis.
    // Merge the two intersections in operand order; never let a relative glob
    // erase an absolute path which remains usable with a different --dir.
    for (const [absolute, group] of candidateGroups) {
      const emit = (pattern: string, include: string): string[] => {
        const value = absolute
          ? absolutePattern(pattern, root!)
          : root && candidateRoot
            ? path.posix.relative(
                absolutePattern(".", candidateRoot),
                absolutePattern(pattern, root),
              )
            : pattern;
        emittedOrder.set(
          value,
          Math.min(emittedOrder.get(value) ?? Infinity, group.order.get(include)!),
        );
        return [value];
      };
      selected.push(...intersectCandidatePattern(group, candidate, matchesGlob, emit));
    }
    if (candidateGroups.size > 1) {
      selected.sort((left, right) => emittedOrder.get(left)! - emittedOrder.get(right)!);
    }
    result.push(...selected);
  }
  return {
    include: [...new Set(result)],
    exclude: [
      ...new Set([
        ...owner.exclude.map((pattern) =>
          root && candidateRoot && !path.isAbsolute(pattern)
            ? root !== candidateRoot || result.some((value) => path.isAbsolute(value))
              ? absolutePattern(pattern, root)
              : pattern
            : pattern,
        ),
        ...candidateSelection.exclude,
      ]),
    ],
  };
}
