import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createTuiPtyVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    ["src/tui/tui-pty-harness.test.ts", "src/tui/tui-pty-local.test.ts"],
    {
      dir: "src",
      env,
      fileParallelism: false,
      name: "tui-pty",
    },
  );
}

export default createTuiPtyVitestConfig();
