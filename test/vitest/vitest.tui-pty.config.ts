// Vitest tui pty config wires the tui pty test shard.
import { defineConfig } from "vitest/config";
import { vitestE2eTestGlob } from "./vitest.pattern-file.ts";
import {
  createScopedVitestPatternPlugin,
  withoutVitestPatternFields,
} from "./vitest.scoped-patterns.ts";
import { resolveRepoRootPath, sharedVitestConfig } from "./vitest.shared.config.ts";
import { tuiPtyTestFiles } from "./vitest.test-shards.mjs";

export function createTuiPtyVitestConfig(env?: Record<string, string | undefined>) {
  const baseTest = sharedVitestConfig.test ?? {};
  const exclude = (baseTest.exclude ?? []).filter((pattern) => pattern !== vitestE2eTestGlob);
  const configEnv = env ?? process.env;
  const includeLocal = configEnv.OPENCLAW_TUI_PTY_INCLUDE_LOCAL === "1";
  const baseSequence = (baseTest as { sequence?: { groupOrder?: number } }).sequence;

  return defineConfig({
    ...sharedVitestConfig,
    plugins: [
      ...sharedVitestConfig.plugins,
      createScopedVitestPatternPlugin(
        tuiPtyTestFiles,
        {
          env: configEnv,
          dir: "src",
          excludeUnitFastTests: false,
        },
        exclude,
        (patterns, test) =>
          // The local default gate must not suppress an explicit CLI or native selection.
          !includeLocal &&
          test.include === undefined &&
          patterns.externalIncludePatterns === null &&
          patterns.scopedCliInclude === null
            ? {
                include: patterns.scopedInclude.filter(
                  (target) => !target.endsWith("tui-pty-local.e2e.test.ts"),
                ),
              }
            : {},
      ),
    ],
    test: {
      ...withoutVitestPatternFields(baseTest),
      env,
      name: "tui-pty",
      pool: "forks",
      dir: resolveRepoRootPath("src"),
      fileParallelism: false,
      maxWorkers: 1,
      reporters: ["verbose", ...(configEnv.GITHUB_ACTIONS === "true" ? ["github-actions"] : [])],
      setupFiles: [
        ...new Set(
          [...(baseTest.setupFiles ?? []), "test/setup-openclaw-runtime.ts"].map(
            resolveRepoRootPath,
          ),
        ),
      ],
      sequence: {
        ...baseSequence,
        groupOrder: 95,
      },
    },
  });
}

export default createTuiPtyVitestConfig();
