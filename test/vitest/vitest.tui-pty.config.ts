import { defineConfig } from "vitest/config";
import { resolveRepoRootPath, sharedVitestConfig } from "./vitest.shared.config.ts";

export function createTuiPtyVitestConfig(env?: Record<string, string | undefined>) {
  const baseTest = sharedVitestConfig.test ?? {};
  const exclude = (baseTest.exclude ?? []).filter((pattern) => pattern !== "**/*.e2e.test.ts");
  const configEnv = env ?? process.env;
  const includeLocal = configEnv.OPENCLAW_TUI_PTY_INCLUDE_LOCAL === "1";
  const include = [
    "tui/tui-pty-harness.e2e.test.ts",
    ...(includeLocal ? ["tui/tui-pty-local.e2e.test.ts"] : []),
  ];

  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...baseTest,
      env,
      name: "tui-pty",
      dir: resolveRepoRootPath("src"),
      include,
      exclude,
      fileParallelism: false,
      maxWorkers: 1,
      setupFiles: [
        ...new Set(
          [...(baseTest.setupFiles ?? []), "test/setup-openclaw-runtime.ts"].map(
            resolveRepoRootPath,
          ),
        ),
      ],
      sequence: {
        ...baseTest.sequence,
        groupOrder: 95,
      },
    },
  });
}

export default createTuiPtyVitestConfig();
