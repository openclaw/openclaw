// Compile the provider and its callers together so payload deadlines exclude source transforms.
const currentModuleUrl = import.meta.url;

export const dashboardTitleRuntimeEntrypoints = {
  isolated: {
    currentModuleUrl,
    sourceWorkerName: "../agents/isolated-completion",
    distWorkerPath: "agents/isolated-completion.js",
  },
  dashboard: {
    currentModuleUrl,
    sourceWorkerName: "dashboard-session-title",
    distWorkerPath: "gateway/dashboard-session-title.js",
  },
  config: {
    currentModuleUrl,
    sourceWorkerName: "../config/runtime-snapshot",
    distWorkerPath: "config/runtime-snapshot.js",
  },
  ollama: {
    currentModuleUrl,
    sourceWorkerName: "../../extensions/ollama/index",
    distWorkerPath: "extensions/ollama/index.js",
  },
} as const;
