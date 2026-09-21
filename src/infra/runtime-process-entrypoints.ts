// Runtime launchers and the package build share these subprocess locations.
const currentModuleUrl = import.meta.url;

export const SQLITE_READONLY_CHILD_ARG = "--openclaw-sqlite-readonly-child";

export const runtimeProcessEntrypoints = {
  cronReadOnly: {
    currentModuleUrl,
    sourceWorkerName: "../cron/store/read-only.worker",
    distWorkerPath: "cron/store/read-only.worker.js",
  },
  stateRead: {
    currentModuleUrl,
    sourceWorkerName: "../state/openclaw-state-read.worker",
    distWorkerPath: "state/openclaw-state-read.worker.js",
  },
  spawnBroker: {
    currentModuleUrl,
    sourceWorkerName: "../process/spawn-broker/worker",
    distWorkerPath: "process/spawn-broker/worker.js",
  },
  cronStreamMatcher: {
    currentModuleUrl,
    sourceWorkerName: "../gateway/cron-stream-matcher.worker",
    distWorkerPath: "gateway/cron-stream-matcher.worker.js",
  },
  nativeHookRelayClient: {
    currentModuleUrl,
    sourceWorkerName: "../agents/harness/native-hook-relay-client.worker",
    distWorkerPath: "agents/harness/native-hook-relay-client.worker.js",
  },
  computerHost: {
    currentModuleUrl,
    sourceWorkerName: "../gateway/desktop/computer.worker",
    distWorkerPath: "gateway/desktop/computer.worker.js",
  },
  imageProcessor: {
    currentModuleUrl,
    sourceWorkerName: "../media/image-processor.worker",
    distWorkerPath: "media/image-processor.worker.js",
  },
  gitOperations: {
    currentModuleUrl,
    sourceWorkerName: "git-operation.worker",
    distWorkerPath: "infra/git-operation.worker.js",
  },
  fsSafeCopy: {
    currentModuleUrl,
    sourceWorkerName: "fs-safe-copy.worker",
    distWorkerPath: "infra/fs-safe-copy.worker.js",
  },
  sharedStateStore: {
    currentModuleUrl,
    sourceWorkerName: "../state/openclaw-state.worker",
    distWorkerPath: "state/openclaw-state.worker.js",
  },
  authProfileInlineUsage: {
    currentModuleUrl,
    sourceWorkerName: "../agents/auth-profiles/inline-usage.worker",
    distWorkerPath: "agents/auth-profiles/inline-usage.worker.js",
  },
  agentDatabaseExecution: {
    currentModuleUrl,
    sourceWorkerName: "../state/openclaw-agent-execution.worker",
    distWorkerPath: "state/openclaw-agent-execution.worker.js",
  },
  workspaceMemory: {
    currentModuleUrl,
    sourceWorkerName: "../worker/memory-worker-entry",
    distWorkerPath: "worker/memory-worker-entry.js",
  },
  workspaceSkills: {
    currentModuleUrl,
    sourceWorkerName: "../worker/skills-worker-entry",
    distWorkerPath: "worker/skills-worker-entry.js",
  },
  boardStore: {
    currentModuleUrl,
    sourceWorkerName: "../boards/sqlite-board-store.worker",
    distWorkerPath: "boards/sqlite-board-store.worker.js",
  },
  heartbeatOutcomeStore: {
    currentModuleUrl,
    sourceWorkerName: "heartbeat-outcome-store.worker",
    distWorkerPath: "infra/heartbeat-outcome-store.worker.js",
  },
  sqliteStore: {
    currentModuleUrl,
    sourceWorkerName: "sqlite-store.worker",
    distWorkerPath: "infra/sqlite-store.worker.js",
  },
  agentSchemaInspection: {
    currentModuleUrl,
    sourceWorkerName: "../state/openclaw-agent-schema-inspection.worker",
    distWorkerPath: "state/openclaw-agent-schema-inspection.worker.js",
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
  preparedModelCatalog: {
    currentModuleUrl,
    sourceWorkerName: "../agents/prepared-model-catalog.worker",
    distWorkerPath: "agents/prepared-model-catalog.worker.js",
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
  doctorLint: {
    currentModuleUrl,
    sourceWorkerName: "../commands/doctor-lint.worker",
    distWorkerPath: "commands/doctor-lint.worker.js",
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
  sessionTranscript: {
    currentModuleUrl,
    sourceWorkerName: "../config/sessions/session-transcript.worker",
    distWorkerPath: "config/sessions/session-transcript.worker.js",
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
  terminalPty: {
    currentModuleUrl,
    sourceWorkerName: "../process/terminal-pty-worker",
    distWorkerPath: "process/terminal-pty-worker.js",
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
  // Not a launcher: the daemon runtime probe requires this module inside candidate Bun
  // executables so they select the same SQLite library the Gateway will run with.
  bunSqliteLibrary: {
    currentModuleUrl,
    sourceWorkerName: "bun-sqlite-library",
    distWorkerPath: "infra/bun-sqlite-library.js",
  },
} as const;
