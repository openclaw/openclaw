export const proxyCaptureNativeProcessEntrypoints = {
  runtime: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "runtime",
    distWorkerPath: "proxy-capture/runtime.js",
  },
  store: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "store.sqlite",
    distWorkerPath: "proxy-capture/store.sqlite.js",
  },
  secretRedaction: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../logging/secret-redaction-registry",
    distWorkerPath: "logging/secret-redaction-registry.js",
  },
} as const;
