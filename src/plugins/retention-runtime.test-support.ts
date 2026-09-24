export const pluginRetentionEntrypoints = {
  services: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "services.retention.test-support",
    distWorkerPath: "plugins/services.retention.test-support.js",
  },
  cache: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "plugin-cache.retention.test-support",
    distWorkerPath: "plugins/plugin-cache.retention.test-support.js",
  },
  accessPolicy: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "gateway-access-policy-registration.test-support",
    distWorkerPath: "plugins/gateway-access-policy-registration.test-support.js",
  },
} as const;
