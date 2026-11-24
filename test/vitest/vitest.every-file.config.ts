// Secretless scheduled coverage for explicit files without another scheduled owner.
import { defineConfig } from "vitest/config";
import {
  loadPatternListFromEnv,
  matchesVitestGlob,
  sharedVitestExcludePatterns,
  vitestE2eTestGlob,
} from "./vitest.pattern-file.ts";
import { resolveRepoRootPath, sharedVitestConfig } from "./vitest.shared.config.ts";

const include = loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE");
if (!include?.length) {
  throw new Error("Every-file tests require a nonempty OPENCLAW_VITEST_INCLUDE_FILE selection");
}
const exclude = sharedVitestExcludePatterns.filter((pattern) => pattern !== vitestE2eTestGlob);
for (const file of include) {
  if (exclude.some((pattern) => matchesVitestGlob(file, pattern))) {
    throw new Error(`Every-file selection is excluded from unattended Vitest execution: ${file}`);
  }
}

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    name: "every-file",
    include,
    exclude,
    setupFiles: [
      ...new Set([
        ...(sharedVitestConfig.test.setupFiles ?? []),
        resolveRepoRootPath("test/setup-openclaw-runtime.ts"),
      ]),
    ],
    isolate: true,
    pool: "forks",
    runner: undefined,
    passWithNoTests: false,
  },
});
