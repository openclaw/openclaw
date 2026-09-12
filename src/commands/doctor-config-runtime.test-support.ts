// Fresh Doctor script processes share compiled config and install-index module identities.
export const doctorConfigRuntimeEntrypoints = {
  preflight: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "doctor-config-preflight",
    distWorkerPath: "commands/doctor-config-preflight.js",
  },
  configGuard: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../cli/program/config-guard",
    distWorkerPath: "cli/program/config-guard.js",
  },
  runtime: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../runtime",
    distWorkerPath: "runtime.js",
  },
  configFlow: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "doctor-config-flow",
    distWorkerPath: "commands/doctor-config-flow.js",
  },
  configHealth: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../flows/doctor-health-contribution-runners.config",
    distWorkerPath: "flows/doctor-health-contribution-runners.config.js",
  },
  installIndexSeed: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../plugins/test-helpers/installed-plugin-index",
    distWorkerPath: "test-support/installed-plugin-index.js",
  },
} as const;
