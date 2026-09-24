export const mediaNativeProcessEntrypoints = {
  store: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "store",
    distWorkerPath: "media/store.js",
  },
  channelReadAuthority: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../shared/channel-read-authority",
    distWorkerPath: "shared/channel-read-authority.js",
  },
} as const;
