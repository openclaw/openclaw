export const toolingTsEntrypoints = {
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
