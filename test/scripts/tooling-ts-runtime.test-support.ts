export const toolingTsEntrypoints = {
  sqliteReliabilityWriter: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/lib/sqlite-reliability-writer",
    distWorkerPath: "legacy-finalizer/scripts/lib/sqlite-reliability-writer.js",
  },
  pluginPretagPackCheck: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/plugin-release-pretag-pack-check",
    distWorkerPath: "legacy-finalizer/scripts/plugin-release-pretag-pack-check.js",
  },
  crossOsProcess: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/lib/cross-os-release-checks/process",
    distWorkerPath: "legacy-finalizer/scripts/lib/cross-os-release-checks/process.js",
  },
  controlUiI18n: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/control-ui-i18n",
    distWorkerPath: "legacy-finalizer/scripts/control-ui-i18n.js",
  },
  sparkleBuild: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/sparkle-build",
    distWorkerPath: "legacy-finalizer/scripts/sparkle-build.js",
  },
  prepack: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/openclaw-prepack",
    distWorkerPath: "legacy-finalizer/scripts/openclaw-prepack.js",
  },
  npmPostpublish: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/openclaw-npm-postpublish-verify",
    distWorkerPath: "legacy-finalizer/scripts/openclaw-npm-postpublish-verify.js",
  },
  benchCli: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../scripts/bench-cli-startup",
    distWorkerPath: "legacy-finalizer/scripts/bench-cli-startup.js",
  },
  respawn: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../src/entry.respawn",
    distWorkerPath: "legacy-finalizer/src/entry.respawn.js",
  },
  processWait: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../helpers/process-wait",
    distWorkerPath: "legacy-finalizer/test/helpers/process-wait.js",
  },
} as const;
