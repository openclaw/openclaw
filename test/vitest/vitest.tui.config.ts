import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createTuiVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/tui/**/*.test.ts"], {
    dir: "src",
    env,
    exclude: ["src/tui/tui-pty-harness.test.ts", "src/tui/tui-pty-local.test.ts"],
    name: "tui",
    passWithNoTests: true,
  });
}

export default createTuiVitestConfig();
