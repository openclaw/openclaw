// Vitest auto reply config wires the auto reply test shard.
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAutoReplyVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/auto-reply/**/*.test.ts"], {
    dir: "src/auto-reply",
    env,
    exclude: databaseWorkerCoreTestFiles,
    name: "auto-reply",
  });
}

export default createAutoReplyVitestConfig();
