import { publicationSourceToolingPaths } from "../../scripts/lib/publication-source-paths.mjs";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";

// Fixture inputs, not expected inventory results. Retain the separately verified
// producer bootstrap, type module, child runner and non-imported policy file.
export const INVENTORY_PRODUCER_PATHS = collectRuntimeImportClosure(process.cwd(), [
  "scripts/release-plan-producer.mts",
  "scripts/release-plan-producer.types.mts",
  "scripts/release-plan-producer-core.mts",
  "scripts/release-qualification-admission.mjs",
  "scripts/release-qualification-coverage.mjs",
  "scripts/release-tooling-identity.mjs",
  "scripts/lib/release-plan-child-runner.mjs",
  "scripts/lib/npm-core-release-packages.json",
]);

export const PUBLICATION_TRANSPORT_PATHS = collectRuntimeImportClosure(process.cwd(), [
  "scripts/full-release-publication-contract.mjs",
  "scripts/lib/npm-core-release-packages.json",
]);

export const SOURCE_ADMISSION_PATHS = [
  ...publicationSourceToolingPaths,
  "scripts/lib/frozen-target-workflow-request.mjs",
  "scripts/lib/release-qualification-coverage.json",
  "scripts/preflight-frozen-target-contracts.mjs",
  "scripts/lib/frozen-target-source.mjs",
  "scripts/lib/docker-e2e-plan.mts",
  "scripts/lib/docker-e2e-scenarios.mts",
  "scripts/lib/official-external-channel-catalog.json",
  "scripts/lib/official-external-provider-catalog.json",
  "scripts/lib/update-compat-inventory.json",
  "scripts/lib/update-first-hop-lanes.mjs",
  "scripts/lib/upgrade-survivor-policy.mjs",
  "scripts/lib/upgrade-survivor-scenarios.json",
  "scripts/lib/frozen-target-compat.sh",
  "scripts/lib/trusted-native-typescript.mjs",
  "scripts/lib/native-typescript.mts",
  "scripts/resolve-frozen-codex-live-suite.mjs",
  "scripts/resolve-fs-safe-native-contract.mjs",
  "scripts/e2e/lib/upgrade-survivor/config-recipe.mts",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/plan-release-workflow-matrix.mjs",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/plugin-prerelease-test-plan.mts",
  "scripts/plan-targeted-docker-lane-groups.mjs",
  "scripts/lib/numeric-options.mjs",
  "scripts/full-release-candidate-contract.mjs",
  "scripts/full-release-validation-state.mjs",
  "scripts/full-release-validation-policy.mjs",
  "scripts/lib/release-validation-waivers.mjs",
  "scripts/pr-lib/gh-api-preflight.mjs",
  "scripts/release-ci-summary.mjs",
  "scripts/lib/full-release-candidate-reuse.mjs",
  "scripts/lib/full-release-child-reuse.mjs",
  "scripts/lib/full-release-evidence.mjs",
  "scripts/lib/npm-shrinkwrap-dependencies.mjs",
  "scripts/lib/release-publish-inputs.mjs",
  "scripts/npm-preflight-tooling-identity.mjs",
  "scripts/npm-prepared-bundle.mjs",
  "scripts/lib/npm-core-release-packages.mjs",
  "scripts/plugin-sdk-api-release-evidence.mjs",
  "scripts/lib/release-context.mjs",
  "scripts/lib/release-changelog.mjs",
  "scripts/lib/cross-os-release-checks/suite-filter.mjs",
  "scripts/lib/managed-cleanup-handoff.mts",
  "scripts/lib/release-evidence-identity.mjs",
  "scripts/lib/full-release-manifest.mjs",
];
