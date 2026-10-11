// Native fixtures share the invocation's compiled runtime and nested process entries.
export const schtasksNativeEntrypoints = {
  taskSupervisor: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../cli/gateway-cli/task-supervisor",
    distWorkerPath: "cli/gateway-cli/task-supervisor.js",
  },
  hostedStop: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "schtasks.hosted-stop.native-test-support",
    distWorkerPath: "daemon/schtasks.hosted-stop.native-test-support.js",
  },
  startupFallback: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "schtasks-runtime",
    distWorkerPath: "daemon/schtasks-runtime.js",
  },
} as const;
