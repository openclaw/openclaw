// Vitest extension slack config wires the extension slack test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionSlackVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(["extensions/slack/**/*.test.ts"], {
    dir: "extensions",
    env,
    includeOpenClawRuntimeSetup: false,
    // The non-isolated runner resets each file's mocks and module-local fixtures.
    isolate: false,
    name: "extension-slack",
    // The cooldown store uses the application-owned SQLite worker broker.
    pool: "forks",
    passWithNoTests: true,
    setupFiles: ["test/setup.extensions.ts"],
  });
}

export default createExtensionSlackVitestConfig();
