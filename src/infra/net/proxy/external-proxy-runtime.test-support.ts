export const externalProxyTestEntrypoints = {
  lifecycle: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "proxy-lifecycle",
    distWorkerPath: "infra/net/proxy/proxy-lifecycle.js",
  },
  websocket: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../../../packages/gateway-client/src/websocket.test-support",
    distWorkerPath: "packages/gateway-client/websocket.test-support.js",
  },
} as const;
