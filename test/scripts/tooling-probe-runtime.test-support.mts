// Script main guards require their original module boundaries in the prepared graph.
export const toolingProbeRuntimeEntrypoints = {
  buildAll: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/build-all",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/build-all.js",
  },
  buildArtifactCache: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/lib/build-artifact-cache",
    sourceExtension: ".mts",
    distWorkerPath: "scripts/lib/build-artifact-cache.js",
  },
  buildIdentity: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/lib/build-identity",
    sourceExtension: ".mts",
    distWorkerPath: "scripts/lib/build-identity.js",
  },
  ciRefitTestTimings: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/ci-refit-test-timings",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/ci-refit-test-timings.js",
  },
  testGroupReport: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/test-group-report",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/test-group-report.js",
  },
} as const;
