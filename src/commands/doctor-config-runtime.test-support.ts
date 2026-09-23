// Fresh Doctor script processes share compiled config and install-index module identities.
export const doctorConfigRuntimeEntrypoints = {
  cleanup: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../test-utils/session-state-cleanup",
    distWorkerPath: "test-utils/session-state-cleanup.js",
  },
  configIO: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../config/io",
    distWorkerPath: "config/io.js",
  },
  preflight: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "doctor-config-preflight",
    distWorkerPath: "commands/doctor-config-preflight.js",
  },
  checkpoint: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/startup-migration-checkpoint",
    distWorkerPath: "infra/startup-migration-checkpoint.js",
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
  metadataSnapshot: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../plugins/current-plugin-metadata-snapshot",
    distWorkerPath: "plugins/current-plugin-metadata-snapshot.js",
  },
  stateHealth: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../flows/doctor-health-contribution-runners.state",
    distWorkerPath: "flows/doctor-health-contribution-runners.state.js",
  },
  prompter: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "doctor-prompter",
    distWorkerPath: "commands/doctor-prompter.js",
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
