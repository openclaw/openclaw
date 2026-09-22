// Keep CLI main guards and lazy-import probes on physical prepared modules.
export const toolingMtsEntrypoints = {
  crabboxSourceCapsule: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/crabbox-source-capsule",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/crabbox-source-capsule.js",
  },
  crabboxStaging: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/crabbox-staging",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/crabbox-staging.js",
  },
  crabboxStagingClaims: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/crabbox-staging-claims",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/crabbox-staging-claims.js",
  },
  crabboxStagingArtifacts: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/crabbox-staging-artifacts",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/crabbox-staging-artifacts.js",
  },
  deadcodeExports: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/check-deadcode-exports",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/check-deadcode-exports.js",
  },
  deadcodeUnusedFiles: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/check-deadcode-unused-files",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/check-deadcode-unused-files.js",
  },
  releaseMetadata: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/check-release-metadata-only",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/check-release-metadata-only.js",
  },
  gatewayWatch: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/check-gateway-watch-regression",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/check-gateway-watch-regression.js",
  },
  controlPlane: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/check-built-plugin-control-plane-modules",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/check-built-plugin-control-plane-modules.js",
  },
  runtimePostbuild: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/runtime-postbuild",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/runtime-postbuild.js",
  },
  runNode: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/run-node",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/run-node.js",
  },
  dockerSummary: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/docker-e2e",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/docker-e2e.js",
  },
  dockerTimings: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/docker-e2e-timings",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/docker-e2e-timings.js",
  },
} as const;
