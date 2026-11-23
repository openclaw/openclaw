// Keep the .checks.ts name: CI changed-owner discovery routes both .test.ts and .spec.ts.
// This suite is explicitly local-only, not a registered CI shard.
import { createScopedVitestConfig } from "./vitest/vitest.scoped-config.ts";

if (process.env.CI) {
  throw new Error(
    "Release approval checks are manual-only. Run this configuration locally, outside CI.",
  );
}

export default createScopedVitestConfig(["test/manual-release-approval.checks.ts"], {
  name: "manual-release-approval",
  includeOpenClawRuntimeSetup: false,
  passWithNoTests: false,
});
