export const execOutputRetentionEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "exec-output.retention.test-support",
  distWorkerPath: "process/exec-output.retention.test-support.js",
} as const;

export const serviceChildCleanupRetentionEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "supervisor/service-child-cleanup-deadline.retention.test-support",
  distWorkerPath: "process/supervisor/service-child-cleanup-deadline.retention.test-support.js",
} as const;
