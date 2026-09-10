// Runtime launchers and the package build share these subprocess locations.
const currentModuleUrl = import.meta.url;

export const runtimeProcessEntrypoints = {
  supervisedReview: {
    currentModuleUrl,
    sourceWorkerName: "../tasks/supervised-review-process",
    distWorkerPath: "tasks/supervised-review-process.js",
  },
  supervisedAttempt: {
    currentModuleUrl,
    sourceWorkerName: "../tasks/supervised-attempt-process",
    distWorkerPath: "tasks/supervised-attempt-process.js",
  },
  supervisedCommand: {
    currentModuleUrl,
    sourceWorkerName: "../tasks/supervised-command-process",
    distWorkerPath: "tasks/supervised-command-process.js",
  },
  supervisedOperation: {
    currentModuleUrl,
    sourceWorkerName: "../tasks/supervised-operation-process",
    distWorkerPath: "tasks/supervised-operation-process.js",
  },
  stateMigrationSnapshot: {
    currentModuleUrl,
    sourceWorkerName: "state-migrations.snapshot.worker",
    distWorkerPath: "infra/state-migrations.snapshot.worker.js",
  },
  githubExec: {
    currentModuleUrl,
    sourceWorkerName: "../agents/github-exec-launcher",
    distWorkerPath: "agents/github-exec-launcher.js",
  },
  sqliteReadOnly: {
    currentModuleUrl,
    sourceWorkerName: "sqlite-readonly-location.worker",
    distWorkerPath: "infra/sqlite-readonly-location.worker.js",
  },
  sqliteIntegrity: {
    currentModuleUrl,
    sourceWorkerName: "sqlite-integrity.worker",
    distWorkerPath: "infra/sqlite-integrity.worker.js",
  },
  updateRepair: {
    currentModuleUrl,
    sourceWorkerName: "update-repair.worker",
    distWorkerPath: "infra/update-repair.worker.js",
  },
  updateMigratedFinalize: {
    currentModuleUrl,
    sourceWorkerName: "update-migrated-finalize.worker",
    distWorkerPath: "infra/update-migrated-finalize.worker.js",
  },
  updateCandidateState: {
    currentModuleUrl,
    sourceWorkerName: "update-candidate-state.worker",
    distWorkerPath: "infra/update-candidate-state.worker.js",
  },
  databaseVerify: {
    currentModuleUrl,
    sourceWorkerName: "../state/openclaw-database-verify.worker",
    distWorkerPath: "state/openclaw-database-verify.worker.js",
  },
  stateLeaseHeartbeat: {
    currentModuleUrl,
    sourceWorkerName: "../state/openclaw-state-lease-heartbeat.worker",
    distWorkerPath: "state/openclaw-state-lease-heartbeat.worker.js",
  },
  sessionTranscriptArchive: {
    currentModuleUrl,
    sourceWorkerName: "../config/sessions/session-accessor.sqlite-archive.worker",
    distWorkerPath: "config/sessions/session-accessor.sqlite-archive.worker.js",
  },
  sessionTranscriptReconcile: {
    currentModuleUrl,
    sourceWorkerName: "../config/sessions/session-transcript-reconcile.worker",
    distWorkerPath: "config/sessions/session-transcript-reconcile.worker.js",
  },
  tailscaleRouteOwner: {
    currentModuleUrl,
    sourceWorkerName: "tailscale-route-owner.worker",
    distWorkerPath: "infra/tailscale-route-owner.worker.js",
  },
  serviceChildRelay: {
    currentModuleUrl,
    sourceWorkerName: "../process/supervisor/service-child-relay",
    distWorkerPath: "process/supervisor/service-child-relay.js",
  },
  serviceChildGroupAnchor: {
    currentModuleUrl,
    sourceWorkerName: "../process/supervisor/service-child-group-anchor",
    distWorkerPath: "process/supervisor/service-child-group-anchor.js",
  },
  serviceChildWindowsJobAnchor: {
    currentModuleUrl,
    sourceWorkerName: "../process/supervisor/service-child-windows-job-anchor",
    distWorkerPath: "process/supervisor/service-child-windows-job-anchor.js",
  },
} as const;
