import path from "node:path";
import { defaultExclude, defineConfig } from "vitest/config";
import normalizationCorePackageJson from "../../packages/normalization-core/package.json" with { type: "json" };
import { markdownTestFiles } from "./vitest.markdown-paths.mjs";
import { nodeVitestConfig, repoRoot, resolveRepoRootPath } from "./vitest.node-base.ts";
import {
  createScopedVitestPatternPlugin,
  withoutVitestPatternFields,
} from "./vitest.scoped-patterns.ts";
import { createVitestSourcePackageAliases } from "./vitest.source-package-alias.ts";

const { sourcePackageAliasesFromExports } = createVitestSourcePackageAliases(repoRoot);
export default defineConfig({
  ...nodeVitestConfig,
  plugins: [
    ...(nodeVitestConfig.plugins ?? []),
    createScopedVitestPatternPlugin(
      markdownTestFiles,
      { root: repoRoot, intersectIncludeFile: true, excludeUnitFastTests: false },
      defaultExclude,
    ),
  ],
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
    ...withoutVitestPatternFields(nodeVitestConfig.test),
    name: "markdown",
    setupFiles: [resolveRepoRootPath("test/setup.env.ts")],
    passWithNoTests: true,
  },
});
