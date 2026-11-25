// Admission hooks need the runtime's physical lazy-import boundaries.
export const workerImportRuntimeEntrypoints = {
  runtime: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "worker.runtime",
    distWorkerPath: "legacy-finalizer/src/worker/worker.runtime.js",
  },
  launchDescriptor: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "launch-descriptor",
    distWorkerPath: "legacy-finalizer/src/worker/launch-descriptor.js",
  },
  admission: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../packages/gateway-protocol/src/schema/worker-admission",
    distWorkerPath: "legacy-finalizer/packages/gateway-protocol/src/schema/worker-admission.js",
  },
  websocketData: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../packages/gateway-client/src/websocket-data",
    distWorkerPath: "legacy-finalizer/packages/gateway-client/src/websocket-data.js",
  },
} as const;
