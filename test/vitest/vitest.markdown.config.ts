import path from "node:path";
import { defineConfig } from "vitest/config";
import normalizationCorePackageJson from "../../packages/normalization-core/package.json" with { type: "json" };
import { intersectIncludePatterns } from "./vitest.include-patterns.ts";
import { markdownTestFiles } from "./vitest.markdown-paths.mjs";
import { nodeVitestConfig, repoRoot, resolveRepoRootPath } from "./vitest.node-base.ts";
import {
  loadPatternListFromEnv,
  matchesVitestGlob,
  narrowIncludePatternsForCli,
} from "./vitest.pattern-file.ts";
import { createVitestSourcePackageAliases } from "./vitest.source-package-alias.ts";

const { sourcePackageAliasesFromExports } = createVitestSourcePackageAliases(repoRoot);

export default defineConfig({
  ...nodeVitestConfig,
  ...(process.env.OPENCLAW_VITEST_OBSERVATION_DIR
    ? { cacheDir: path.join(process.env.OPENCLAW_VITEST_OBSERVATION_DIR, "vite") }
    : {}),
  resolve: {
    alias: sourcePackageAliasesFromExports(
      "normalization-core",
      normalizationCorePackageJson.exports,
    ),
  },
  test: {
    ...nodeVitestConfig.test,
    name: "markdown",
    setupFiles: [resolveRepoRootPath("test/setup.env.ts")],
    include:
      intersectIncludePatterns(
        markdownTestFiles,
        loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE"),
        matchesVitestGlob,
      ) ??
      narrowIncludePatternsForCli(markdownTestFiles) ??
      markdownTestFiles,
    passWithNoTests: true,
  },
});
