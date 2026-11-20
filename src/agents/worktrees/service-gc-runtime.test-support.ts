// Prepare the graph before the real Node main-thread child's bounded cleanup.
export const managedWorktreeGcEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "service-gc.test-support",
  distWorkerPath: "agents/worktrees/service-gc.test-support.js",
} as const;

export const managedWorktreeRemovalEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "service.remove.postgres.test-support",
  distWorkerPath: "agents/worktrees/service.remove.postgres.test-support.js",
} as const;
