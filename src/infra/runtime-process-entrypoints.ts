// Runtime launchers and the package build share these subprocess locations.
function runtimeProcessEntrypoint(modulePath: string) {
  return {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: modulePath.startsWith("infra/")
      ? modulePath.slice("infra/".length)
      : `../${modulePath}`,
    distWorkerPath: `${modulePath}.js`,
  } as const;
}

export const SQLITE_READONLY_CHILD_ARG = "--openclaw-sqlite-readonly-child";

export const runtimeProcessEntrypoints = {
  secretEgressProxy: runtimeProcessEntrypoint("secrets/egress-proxy/proxy.worker"),
  codeModeNode: runtimeProcessEntrypoint("agents/code-mode-node.worker"),
  cronReadOnly: runtimeProcessEntrypoint("cron/store/read-only.worker"),
  stateRead: runtimeProcessEntrypoint("state/openclaw-state-read.worker"),
  spawnBroker: runtimeProcessEntrypoint("process/spawn-broker/worker"),
  cronStreamMatcher: runtimeProcessEntrypoint("gateway/cron-stream-matcher.worker"),
  nativeHookRelayClient: runtimeProcessEntrypoint("agents/harness/native-hook-relay-client.worker"),
  computerHost: runtimeProcessEntrypoint("gateway/desktop/computer.worker"),
  imageProcessor: runtimeProcessEntrypoint("media/image-processor.worker"),
  gitOperations: runtimeProcessEntrypoint("infra/git-operation.worker"),
  fsSafeCopy: runtimeProcessEntrypoint("infra/fs-safe-copy.worker"),
  sharedStateStore: runtimeProcessEntrypoint("state/openclaw-state.worker"),
  authProfileInlineUsage: runtimeProcessEntrypoint("agents/auth-profiles/inline-usage.worker"),
  agentDatabaseExecution: runtimeProcessEntrypoint("state/openclaw-agent-execution.worker"),
  workspaceMemory: runtimeProcessEntrypoint("worker/memory-worker-entry"),
  workspaceSkills: runtimeProcessEntrypoint("worker/skills-worker-entry"),
  boardStore: runtimeProcessEntrypoint("boards/sqlite-board-store.worker"),
  sessionSharingStore: runtimeProcessEntrypoint("config/sessions/session-sharing-store.worker"),
  heartbeatOutcomeStore: runtimeProcessEntrypoint("infra/heartbeat-outcome-store.worker"),
  sqliteStore: runtimeProcessEntrypoint("infra/sqlite-store.worker"),
  agentSchemaInspection: runtimeProcessEntrypoint("state/openclaw-agent-schema-inspection.worker"),
  stateMigrationSnapshot: runtimeProcessEntrypoint("infra/state-migrations.snapshot.worker"),
  githubExec: runtimeProcessEntrypoint("agents/github-exec-launcher"),
  sqliteReadOnly: runtimeProcessEntrypoint("infra/sqlite-readonly-location.worker"),
  sqliteSourceRevision: runtimeProcessEntrypoint("infra/sqlite-source-revision.worker"),
  sqliteIntegrity: runtimeProcessEntrypoint("infra/sqlite-integrity.worker"),
  preparedModelCatalog: runtimeProcessEntrypoint("agents/prepared-model-catalog.worker"),
  updateRepair: runtimeProcessEntrypoint("infra/update-repair.worker"),
  updateMigratedFinalize: runtimeProcessEntrypoint("infra/update-migrated-finalize.worker"),
  updateCandidateState: runtimeProcessEntrypoint("infra/update-candidate-state.worker"),
  doctorLint: runtimeProcessEntrypoint("commands/doctor-lint.worker"),
  doctor: runtimeProcessEntrypoint("commands/doctor.worker"),
  databaseVerify: runtimeProcessEntrypoint("state/openclaw-database-verify.worker"),
  stateLeaseHeartbeat: runtimeProcessEntrypoint("state/openclaw-state-lease-heartbeat.worker"),
  sessionTranscriptArchive: runtimeProcessEntrypoint(
    "config/sessions/session-accessor.sqlite-archive.worker",
  ),
  sessionTranscript: runtimeProcessEntrypoint("config/sessions/session-transcript.worker"),
  sessionManagerMetadata: runtimeProcessEntrypoint(
    "agents/sessions/session-manager-metadata.worker",
  ),
  sessionTranscriptProjectionPublication: runtimeProcessEntrypoint(
    "config/sessions/session-transcript-projection-publication.worker",
  ),
  sessionTranscriptReports: runtimeProcessEntrypoint(
    "config/sessions/session-accessor.sqlite-transcript-reports.worker",
  ),
  sessionTranscriptReconcile: runtimeProcessEntrypoint(
    "config/sessions/session-transcript-reconcile.worker",
  ),
  tailscaleRouteOwner: runtimeProcessEntrypoint("infra/tailscale-route-owner.worker"),
  serviceChildRelay: runtimeProcessEntrypoint("process/supervisor/service-child-relay"),
  terminalPty: runtimeProcessEntrypoint("process/terminal-pty-worker"),
  serviceChildGroupAnchor: runtimeProcessEntrypoint(
    "process/supervisor/service-child-group-anchor",
  ),
  serviceChildWindowsJobAnchor: runtimeProcessEntrypoint(
    "process/supervisor/service-child-windows-job-anchor",
  ),
  // Not a launcher: the daemon runtime probe requires this module inside candidate Bun
  // executables so they select the same SQLite library the Gateway will run with.
  bunSqliteLibrary: runtimeProcessEntrypoint("infra/bun-sqlite-library"),
} as const;
