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
  ...new Set([
    ...publicationSourceToolingPaths,
    ...collectRuntimeImportClosure(
      process.cwd(),
      [
        "scripts/preflight-frozen-target-contracts.mjs",
        "scripts/full-release-validation-state.mjs",
        "scripts/lib/trusted-native-typescript.mjs",
        "scripts/lib/native-typescript.mts",
        "scripts/lib/release-qualification-coverage.json",
        "scripts/lib/frozen-target-compat.sh",
      ],
      { includeDynamicImports: true },
    ),
  ]),
];
