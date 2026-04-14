import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(["qa-channel/**/*.test.ts", "qa-lab/**/*.test.ts"], {
  dir: "extensions",
  name: "extension-qa",
  passWithNoTests: true,
  setupFiles: ["test/setup.extensions.ts"],
});
