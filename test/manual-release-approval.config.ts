// Operator-only approval checks. Deliberately not registered with normal test/CI shards.
import { createScopedVitestConfig } from "./vitest/vitest.scoped-config.ts";

if (process.env.CI) {
  throw new Error(
    "Release approval checks are manual-only. Run this configuration locally, outside CI.",
  );
}

export default createScopedVitestConfig(["test/manual-release-approval.spec.ts"], {
  name: "manual-release-approval",
  includeOpenClawRuntimeSetup: false,
  passWithNoTests: false,
});
