// Vitest runtime config config wires the runtime config test shard.
import type { ViteUserConfig } from "vitest/config";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { runtimeConfigTestOwner } from "./vitest.test-shards.mjs";

export function createRuntimeConfigVitestConfig(
  env?: Record<string, string | undefined>,
): ViteUserConfig {
  const config = createScopedVitestConfig(runtimeConfigTestOwner.include, {
    dir: "src",
    env,
    exclude: runtimeConfigTestOwner.exclude,
    includeOpenClawRuntimeSetup: false,
    name: "runtime-config",
    passWithNoTests: true,
    // Native SQLite handles can abort V8 when threaded workers tear down.
    // Forks keep database lifetimes inside a disposable process.
    pool: "forks",
  });
  return {
    ...config,
    test: {
      ...config.test,
      sequence: {
        ...config.test?.sequence,
        groupOrder: 3,
      },
    },
  };
}

export default createRuntimeConfigVitestConfig();
