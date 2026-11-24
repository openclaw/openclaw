import path from "node:path";
import type { Plugin } from "vite";
import type { TestUserConfig } from "vitest/config";
import { intersectIncludePatterns, splitIncludePatterns } from "./vitest.include-patterns.ts";
import {
  loadPatternListFromEnv,
  matchesVitestGlob,
  narrowIncludePatternsForCli,
  relativizeScopedPatterns,
  resolveNativeVitestExcludes,
  sharedVitestExcludePatterns,
} from "./vitest.pattern-file.ts";
import { getUnitFastTestFilesForIncludePatterns } from "./vitest.unit-fast-paths.mjs";

export const scopedVitestPatternPluginName = "openclaw:vitest-pattern-selection";

export type ScopedVitestPatternOptions = {
  dir?: string;
  env?: Record<string, string | undefined>;
  argv?: string[];
  root?: string;
  exclude?: string[];
  intersectIncludeFile?: boolean;
  excludeUnitFastTests?: boolean;
  /** An already projected include list on the effective native directory. */
  externalInclude?: string[] | null;
  effectiveDir?: string;
  selectOwnedInclude?: (patterns: string[], root: string) => string[];
};

/** Native pattern fields are reserved for actual CLI/programmatic overrides. */
export function withoutVitestPatternFields<T extends TestUserConfig>(test: T) {
  const { include: _include, exclude: _exclude, ...rest } = test;
  return rest;
}

// Config construction and competing watch owners must use the same selection.
// Discovery may inspect current files, but the emitted include patterns stay live.
export function resolveScopedVitestPatterns(
  include: string[],
  options: ScopedVitestPatternOptions = {},
  baseExclude: readonly string[] = sharedVitestExcludePatterns,
) {
  const root = options.root ?? path.resolve(import.meta.dirname, "../..");
  const ownerDir = path.resolve(root, options.dir ?? "");
  const effectiveDir = options.effectiveDir ?? ownerDir;
  const externalIncludePatterns =
    options.externalInclude === undefined
      ? loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", options.env)
      : options.externalInclude;
  const projectedExternal =
    externalIncludePatterns === null
      ? null
      : options.externalInclude === undefined
        ? relativizeScopedPatterns(externalIncludePatterns, options.dir)
        : externalIncludePatterns;
  let cliInclude = narrowIncludePatternsForCli(include, options.argv, {
    scopedDir: options.dir,
    root: options.root,
  });
  if (options.selectOwnedInclude) {
    // Classification consumes the effective native scope, while its returned
    // inventory remains repository-relative. Do not scan the full lane first.
    const candidates = splitIncludePatterns(
      projectedExternal ?? relativizeScopedPatterns(cliInclude ?? include, options.dir),
    ).include;
    include = options.selectOwnedInclude(
      candidates.map((pattern) =>
        path.relative(root, path.resolve(effectiveDir, pattern)).split(path.sep).join("/"),
      ),
      root,
    );
    cliInclude = narrowIncludePatternsForCli(include, options.argv, {
      scopedDir: options.dir,
      root: options.root,
    });
  }
  const ownerInclude = relativizeScopedPatterns(include, options.dir);
  const includeFromEnv = options.intersectIncludeFile
    ? intersectIncludePatterns(
        ownerInclude,
        projectedExternal,
        matchesVitestGlob,
        ownerDir,
        effectiveDir,
      )
    : projectedExternal === null
      ? null
      : splitIncludePatterns(projectedExternal);
  const selection =
    includeFromEnv ??
    splitIncludePatterns(relativizeScopedPatterns(cliInclude ?? include, options.dir));
  const effectiveInclude = selection.include.map((pattern) =>
    path.isAbsolute(pattern)
      ? pattern
      : path.relative(root, path.resolve(effectiveDir, pattern)).split(path.sep).join("/"),
  );
  const unitFastExclude =
    options.excludeUnitFastTests === false
      ? []
      : getUnitFastTestFilesForIncludePatterns(effectiveInclude, {
          dir: options.dir,
          cwd: root,
        });
  const scopedSelectionExclude = resolveNativeVitestExcludes(
    selection.exclude,
    selection.include,
    effectiveDir,
    effectiveDir,
  );
  const scopedOwnerExclude = resolveNativeVitestExcludes(
    relativizeScopedPatterns(
      [...baseExclude, ...unitFastExclude, ...(options.exclude ?? [])],
      options.dir,
    ),
    selection.include,
    ownerDir,
    effectiveDir,
  );
  const scopedExclude = [...scopedOwnerExclude, ...scopedSelectionExclude];
  return {
    externalIncludePatterns,
    effectiveDir,
    effectiveInclude,
    scopedInclude: selection.include,
    scopedOwnerExclude,
    scopedSelectionExclude,
    scopedExclude,
    scopedEnvInclude: includeFromEnv?.include ?? null,
    scopedCliInclude: cliInclude ? relativizeScopedPatterns(cliInclude, options.dir) : null,
  };
}

/** Call only after Vitest has installed CLI and programmatic overrides. */
export function resolveScopedVitestConfigPatterns(
  include: string[],
  options: ScopedVitestPatternOptions,
  baseExclude: readonly string[],
  test: TestUserConfig,
  configRoot?: string,
) {
  const nativeInclude = test.include;
  const nativeExclude = test.exclude;
  const root = options.root ?? test.root ?? configRoot ?? process.cwd();
  const patterns = resolveScopedVitestPatterns(
    include,
    {
      ...options,
      ...(nativeInclude === undefined
        ? {}
        : {
            externalInclude: nativeInclude,
            intersectIncludeFile: false,
            selectOwnedInclude: undefined,
          }),
      ...(nativeExclude === undefined ? {} : { exclude: [], excludeUnitFastTests: false }),
      root,
      effectiveDir: path.resolve(test.root ?? configRoot ?? root, test.dir ?? ""),
    },
    nativeExclude === undefined ? baseExclude : [],
  );
  if (nativeExclude !== undefined) {
    patterns.scopedOwnerExclude.unshift(...nativeExclude);
    patterns.scopedExclude.unshift(...nativeExclude);
  }
  return patterns;
}

/** Resolve only after Vitest has installed CLI and programmatic overrides. */
export function createScopedVitestPatternPlugin(
  include: string[],
  options: ScopedVitestPatternOptions,
  baseExclude: readonly string[],
  apply?: (
    patterns: ReturnType<typeof resolveScopedVitestPatterns>,
    test: TestUserConfig,
  ) => Partial<TestUserConfig>,
): Plugin {
  // Apply only the owner's static projection now. Intersection waits until
  // native CLI/programmatic config overrides establish the effective directory.
  const externalInclude =
    options.externalInclude === undefined
      ? loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", options.env)
      : options.externalInclude;
  const sourceOptions = {
    ...options,
    argv: [...(options.argv ?? process.argv)],
    exclude: options.exclude ? [...options.exclude] : undefined,
    externalInclude:
      options.externalInclude === undefined
        ? externalInclude === null
          ? null
          : relativizeScopedPatterns(externalInclude, options.dir)
        : options.externalInclude,
  };
  const ownerInclude = [...include];
  const ownerExclude = [...baseExclude];
  return {
    name: scopedVitestPatternPluginName,
    enforce: "post",
    config: {
      order: "post",
      handler(config) {
        const test = (config.test ??= {});
        const patterns = resolveScopedVitestConfigPatterns(
          ownerInclude,
          sourceOptions,
          ownerExclude,
          test,
          config.root,
        );
        // Vite's returned config merge concatenates arrays. These are final
        // constraints, not extra candidates, so replace both lists together.
        Object.assign(
          test,
          {
            include: patterns.scopedInclude,
            exclude: patterns.scopedExclude,
          },
          apply?.(patterns, test),
        );
      },
    },
  };
}
