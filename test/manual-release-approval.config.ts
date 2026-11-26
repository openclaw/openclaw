// Keep the .checks.ts name: CI changed-owner discovery routes both .test.ts and .spec.ts.
// This suite is explicitly local-only, not a registered CI shard.
import { createScopedVitestConfig } from "./vitest/vitest.scoped-config.ts";

if (process.env.CI) {
  throw new Error(
    "Release approval checks are manual-only. Run this configuration locally, outside CI.",
  );
}

export default createScopedVitestConfig(
  [
    "test/manual-release-approval.checks.ts",
    "test/manual-build-only-workflow.checks.ts",
    "test/manual-build-only-artifacts.checks.ts",
    "test/manual-build-only-evidence.checks.ts",
    "test/manual-build-only-parent.checks.ts",
    "test/manual-fast-track-publication.checks.ts",
    "test/manual-fast-track-receipt.checks.ts",
    "test/manual-fast-track-button.checks.ts",
  ],
  {
    name: "manual-release-approval",
    includeOpenClawRuntimeSetup: false,
    passWithNoTests: false,
  },
);
