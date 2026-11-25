// Vitest daemon config wires the daemon test shard.
import { cliProcessTestFiles } from "./vitest.cli-process-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createDaemonVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/daemon/**/*.test.ts"], {
    dir: "src",
    env,
    exclude: cliProcessTestFiles,
    intersectIncludeFile: true,
    name: "daemon",
    passWithNoTests: true,
  });
}

export default createDaemonVitestConfig();
