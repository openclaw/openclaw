// Keep subprocess metadata independent of executable launcher declarations.
export function createRuntimeProcessEntrypoints(currentModuleUrl: string) {
  function runtimeProcessEntrypoint(
    modulePath: string,
    distModulePath = modulePath,
    extension = ".js",
    sourceExtension?: ".ts" | ".mts" | ".mjs",
  ) {
    return {
      currentModuleUrl,
      sourceModulePath: `src/${modulePath}${sourceExtension ?? ".ts"}`,
      sourceExtension,
      sourceWorkerName: modulePath.startsWith("infra/")
        ? modulePath.slice("infra/".length)
        : `../${modulePath}`,
      distWorkerPath: `${distModulePath}${extension}`,
    } as const;
  }

  return {
    doctorDatabaseEngineInspection: runtimeProcessEntrypoint(
      "commands/doctor-database-engine-inspection.worker",
    ),
    backupDatabaseDiscovery: runtimeProcessEntrypoint("infra/backup-database-discovery.worker"),
    databaseBackup: runtimeProcessEntrypoint("snapshot/database-backup.worker"),
    managedHandoffEngine: runtimeProcessEntrypoint(
      "infra/update-managed-service-handoff-engine.worker",
    ),
    updatePostgresState: runtimeProcessEntrypoint("infra/update-candidate-state.postgres.worker"),
    databasePortCommand: runtimeProcessEntrypoint(
      "infra/database-engine/port-command.entry.worker",
    ),
    systemCaWarmup: runtimeProcessEntrypoint("gateway/system-ca-warmup.worker"),
    shutdownHardExit: runtimeProcessEntrypoint("cli/gateway-cli/shutdown-hard-exit.worker"),
    packageIntegrityHasher: runtimeProcessEntrypoint(
      "infra/package-update-integrity-hasher.worker",
    ),
    packageLocalOverrides: runtimeProcessEntrypoint("infra/package-local-overrides.worker"),
    directoryWatchHost: runtimeProcessEntrypoint("infra/directory-watch-host.worker"),
    directoryWatchParent: runtimeProcessEntrypoint("infra/directory-watch-parent.worker"),
    workspaceQuiescenceAcquire: runtimeProcessEntrypoint(
      "gateway/worker-environments/workspace-quiescence-acquire.generated.worker",
      undefined,
      undefined,
      ".mjs",
    ),
    workspaceQuiescenceRenew: runtimeProcessEntrypoint(
      "gateway/worker-environments/workspace-quiescence-renew.generated.worker",
      undefined,
      undefined,
      ".mjs",
    ),
    workspaceQuiescenceRelease: runtimeProcessEntrypoint(
      "gateway/worker-environments/workspace-quiescence-release.generated.worker",
      undefined,
      undefined,
      ".mjs",
    ),
    packageActivationRecovery: runtimeProcessEntrypoint(
      "infra/package-update-activation-sealed",
      "package-update-activation-recovery",
      ".mjs",
    ),
    managedHandoffRuntime: runtimeProcessEntrypoint(
      "infra/update-managed-service-handoff-sealed",
      "managed-handoff-runtime",
      ".mjs",
    ),
    sqliteVector: runtimeProcessEntrypoint("infra/database-engine/sqlite-vector.child"),
    postgresBridge: runtimeProcessEntrypoint("infra/postgres-sync/bridge.worker"),
    secretEgressProxy: runtimeProcessEntrypoint("secrets/egress-proxy/proxy.worker"),
    codeModeNode: runtimeProcessEntrypoint("agents/code-mode-node.worker"),
    cronReadOnly: runtimeProcessEntrypoint("cron/store/read-only.worker"),
    stateRead: runtimeProcessEntrypoint("state/openclaw-state-read.worker"),
    workerNativeLifecycle: runtimeProcessEntrypoint("infra/worker-native-lifecycle.worker"),
    spawnBroker: runtimeProcessEntrypoint("process/spawn-broker/worker"),
    cronStreamMatcher: runtimeProcessEntrypoint("gateway/cron-stream-matcher.worker"),
    controlUiFile: runtimeProcessEntrypoint("gateway/control-ui-file.worker"),
    publicSessionCard: runtimeProcessEntrypoint("gateway/control-ui-public-session-card.worker"),
    nodeBootstrapArtifact: runtimeProcessEntrypoint(
      "gateway/worker-environments/node-bootstrap-artifact.worker",
    ),
    nativeHookRelayClient: runtimeProcessEntrypoint(
      "agents/harness/native-hook-relay-client.worker",
    ),
    computerHost: runtimeProcessEntrypoint("gateway/desktop/computer.worker"),
    imageProcessor: runtimeProcessEntrypoint("media/image-processor.worker"),
    fileToolPlanning: runtimeProcessEntrypoint("agents/sessions/tools/file-tool-planning.worker"),
    fileToolRead: runtimeProcessEntrypoint("agents/sessions/tools/read-file.worker"),
    attachmentProcessor: runtimeProcessEntrypoint("media/attachment-processor.worker"),
    gitOperations: runtimeProcessEntrypoint("infra/git-operation.worker"),
    gitPackCleanup: runtimeProcessEntrypoint("agents/worktrees/git-pack-cleanup.worker"),
    fsSafeCopy: runtimeProcessEntrypoint("infra/fs-safe-copy.worker"),
    sharedStateStore: runtimeProcessEntrypoint("state/openclaw-state.worker"),
    clientCredentials: runtimeProcessEntrypoint("infra/client-credential.worker"),
    ttsPreferences: runtimeProcessEntrypoint("tts/tts-settings-write.worker"),
    authProfileInlineUsage: runtimeProcessEntrypoint("agents/auth-profiles/inline-usage.worker"),
    pluginModelCatalogRead: runtimeProcessEntrypoint("agents/plugin-model-catalog-read.worker"),
    pluginModelCatalogCredentials: runtimeProcessEntrypoint("agents/plugin-model-catalog.worker"),
    pluginGenerationPreparation: runtimeProcessEntrypoint(
      "plugins/plugin-generation-preparation.worker",
    ),
    agentDatabaseExecution: runtimeProcessEntrypoint("state/openclaw-agent-execution.worker"),
    // dist/worker is the sealed portable-deploy graph and is excluded from npm.
    // Local workspace subprocesses must remain directly launchable after installation.
    workspaceMemory: runtimeProcessEntrypoint(
      "worker/memory-worker-entry",
      "agents/workspace-memory.worker",
    ),
    localAgentAvatar: runtimeProcessEntrypoint("agents/identity-avatar-file.worker"),
    identityFile: runtimeProcessEntrypoint("agents/identity-file.worker"),
    workspaceSkills: runtimeProcessEntrypoint(
      "worker/skills-worker-entry",
      "agents/workspace-skills.worker",
    ),
    skillsDiscovery: runtimeProcessEntrypoint("skills/runtime/discovery.worker"),
    boardStore: runtimeProcessEntrypoint("boards/sqlite-board-store.worker"),
    progressCardStore: runtimeProcessEntrypoint("session-cards/progress-card-store.worker"),
    sessionSharingStore: runtimeProcessEntrypoint("config/sessions/session-sharing-store.worker"),
    sessionForkDomain: runtimeProcessEntrypoint("config/sessions/session-fork-domain.worker"),
    sessionGoalOperations: runtimeProcessEntrypoint("config/sessions/goals-operations.worker"),
    sessionLifecyclePlanningDomain: runtimeProcessEntrypoint(
      "config/sessions/session-lifecycle-projection.worker",
    ),
    sessionMessageRewriteDomain: runtimeProcessEntrypoint(
      "config/sessions/session-message-rewrite.worker",
    ),
    sessionDiskBudget: runtimeProcessEntrypoint("config/sessions/disk-budget.worker"),
    contextEngineTurnOutbox: runtimeProcessEntrypoint(
      "agents/harness/context-engine-turn-outbox.worker",
    ),
    sqliteStore: runtimeProcessEntrypoint("infra/sqlite-store.worker"),
    sqliteWriterAdmission: runtimeProcessEntrypoint("infra/sqlite-writer-admission.worker"),
    agentSchemaInspection: runtimeProcessEntrypoint(
      "state/openclaw-agent-schema-inspection.worker",
    ),
    stateMigrationSnapshot: runtimeProcessEntrypoint("infra/state-migrations.snapshot.worker"),
    githubExec: runtimeProcessEntrypoint("agents/github-exec-launcher"),
    sqliteReadOnly: runtimeProcessEntrypoint("infra/sqlite-readonly-location.worker"),
    sqliteSnapshotStaging: runtimeProcessEntrypoint("infra/sqlite-snapshot-staging.worker"),
    sqliteReadOnlyNativeResource: runtimeProcessEntrypoint("infra/sqlite-readonly-native-resource"),
    sqliteSourceRevision: runtimeProcessEntrypoint("infra/sqlite-source-revision.worker"),
    sqliteIntegrity: runtimeProcessEntrypoint("infra/sqlite-integrity.worker"),
    sqliteCloseProbe: runtimeProcessEntrypoint("infra/bun-sqlite-close-probe.worker"),
    preparedModelCatalog: runtimeProcessEntrypoint("agents/prepared-model-catalog.worker"),
    providerPromptState: runtimeProcessEntrypoint(
      "agents/embedded-agent-runner/provider-prompt-state.worker",
    ),
    updateRepair: runtimeProcessEntrypoint("infra/update-repair.worker"),
    immutableBuild: runtimeProcessEntrypoint("infra/update-immutable-build.worker"),
    updateMigratedFinalize: runtimeProcessEntrypoint("infra/update-migrated-finalize.worker"),
    updateAutomaticCleanup: runtimeProcessEntrypoint("infra/update-automatic-cleanup.worker"),
    updateCandidateState: runtimeProcessEntrypoint("infra/update-candidate-state.worker"),
    doctorLint: runtimeProcessEntrypoint("commands/doctor-lint.worker"),
    doctor: runtimeProcessEntrypoint("commands/doctor.worker"),
    databaseVerify: runtimeProcessEntrypoint("state/openclaw-database-verify.worker"),
    stateOwnership: runtimeProcessEntrypoint("state/openclaw-state-ownership.worker"),
    stateLeaseHeartbeat: runtimeProcessEntrypoint("state/openclaw-state-lease-heartbeat.worker"),
    gatewayStateOwnerHeartbeat: runtimeProcessEntrypoint(
      "infra/gateway-state-owner-heartbeat.worker",
    ),
    sessionTranscriptArchive: runtimeProcessEntrypoint(
      "config/sessions/session-accessor.sqlite-archive.worker",
    ),
    sessionTranscript: runtimeProcessEntrypoint("config/sessions/session-transcript.worker"),
    workerTranscriptCommit: runtimeProcessEntrypoint(
      "gateway/worker-environments/transcript-commit.worker",
    ),
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
}

// Plugin workers retain package-local paths while build tools share their target inventory.
export const pluginRuntimeProcessManifest = {
  browserNativeHost: {
    plugin: "browser",
    ownerSource: "extensions/browser/native-host-entry.ts",
    sourceWorkerName: "native-host-entry",
    distWorkerPath: "extensions/browser/native-host-entry.js",
    package: { name: "@openclaw/browser-plugin", distWorkerPath: "native-host-entry.js" },
  },
  browserRelayDaemon: {
    plugin: "browser",
    ownerSource: "extensions/browser/native-host-entry.ts",
    sourceWorkerName: "relay-daemon-entry",
    distWorkerPath: "extensions/browser/relay-daemon-entry.js",
    package: { name: "@openclaw/browser-plugin", distWorkerPath: "relay-daemon-entry.js" },
  },
  browserSetup: {
    plugin: "browser",
    ownerSource: "extensions/browser/setup-entry.ts",
    sourceWorkerName: "setup-entry",
    distWorkerPath: "extensions/browser/setup-entry.js",
    package: { name: "@openclaw/browser-plugin", distWorkerPath: "setup-entry.js" },
  },
  quickJsCodeMode: {
    plugin: "code-mode-quickjs",
    ownerSource: "extensions/code-mode-quickjs/src/executor.ts",
    sourceWorkerName: "code-mode.worker",
    distWorkerPath: "extensions/code-mode-quickjs/src/code-mode.worker.js",
    package: {
      name: "@openclaw/code-mode-quickjs",
      distWorkerPath: "src/code-mode.worker.js",
    },
  },
  codexCatalogPage: {
    plugin: "codex",
    ownerSource: "extensions/codex/catalog-page-worker-entrypoint.ts",
    sourceWorkerName: "catalog-page.worker",
    distWorkerPath: "extensions/codex/catalog-page.worker.js",
    package: {
      name: "@openclaw/codex",
      distWorkerPath: "catalog-page.worker.js",
    },
  },
  codexSessionHistory: {
    plugin: "codex",
    ownerSource: "extensions/codex/session-history-worker-entrypoint.ts",
    sourceWorkerName: "session-history.worker",
    distWorkerPath: "extensions/codex/session-history.worker.js",
    package: {
      name: "@openclaw/codex",
      distWorkerPath: "session-history.worker.js",
    },
  },
  discordAudio: {
    plugin: "discord",
    ownerSource: "extensions/discord/src/voice/audio-worker-thread.ts",
    sourceWorkerName: "audio-worker.runtime",
    distWorkerPath: "extensions/discord/src/voice/audio-worker.runtime.js",
    package: {
      name: "@openclaw/discord",
      distWorkerPath: "src/voice/audio-worker.runtime.js",
    },
  },
  documentExtractor: {
    plugin: "document-extract",
    ownerSource: "extensions/document-extract/document-extractor-worker-entrypoint.ts",
    sourceWorkerName: "document-extractor.worker",
    distWorkerPath: "extensions/document-extract/document-extractor.worker.js",
    package: {
      name: "@openclaw/document-extract-plugin",
      distWorkerPath: "document-extractor.worker.js",
    },
  },
  iMessageChatDb: {
    plugin: "imessage",
    ownerSource: "extensions/imessage/src/chat-db.ts",
    sourceWorkerName: "chat-db.worker",
    distWorkerPath: "extensions/imessage/src/chat-db.worker.js",
    package: {
      name: "@openclaw/imessage",
      distWorkerPath: "src/chat-db.worker.js",
    },
  },
  memorySearch: {
    plugin: "memory-core",
    ownerSource: "extensions/memory-core/src/memory/manager-cpu-entrypoints.ts",
    sourceWorkerName: "manager-search.worker",
    distWorkerPath: "extensions/memory-core/memory-search.worker.js",
    package: {
      name: "@openclaw/memory-core",
      distWorkerPath: "src/memory/manager-search.worker.js",
    },
  },
  memoryIndex: {
    plugin: "memory-core",
    ownerSource: "extensions/memory-core/src/memory/manager-cpu-entrypoints.ts",
    sourceWorkerName: "manager-index.worker",
    distWorkerPath: "extensions/memory-core/memory-index.worker.js",
    package: {
      name: "@openclaw/memory-core",
      distWorkerPath: "src/memory/manager-index.worker.js",
    },
  },
  memoryPublication: {
    plugin: "memory-core",
    ownerSource: "extensions/memory-core/src/memory/manager-cpu-entrypoints.ts",
    sourceWorkerName: "manager-publication.worker",
    distWorkerPath: "extensions/memory-core/memory-publication.worker.js",
    package: {
      name: "@openclaw/memory-core",
      distWorkerPath: "src/memory/manager-publication.worker.js",
    },
  },
  memoryStandingIntents: {
    plugin: "memory-core",
    ownerSource: "extensions/memory-core/src/memory/manager-cpu-entrypoints.ts",
    sourceWorkerName: "../standing-intents.worker",
    distWorkerPath: "extensions/memory-core/standing-intents.worker.js",
    package: {
      name: "@openclaw/memory-core",
      distWorkerPath: "src/standing-intents.worker.js",
    },
  },
  memoryEntryOrigins: {
    plugin: "memory-core",
    ownerSource: "extensions/memory-core/src/memory/manager-cpu-entrypoints.ts",
    sourceWorkerName: "../memory-entry-origins.worker",
    distWorkerPath: "extensions/memory-core/memory-entry-origins.worker.js",
    package: {
      name: "@openclaw/memory-core",
      distWorkerPath: "src/memory-entry-origins.worker.js",
    },
  },
  memoryStatsRuntime: {
    plugin: "memory-lancedb",
    ownerSource: "extensions/memory-lancedb/memory-stats-entrypoint.ts",
    sourceWorkerName: "memory-stats.worker",
    distWorkerPath: "extensions/memory-lancedb/memory-stats.worker.js",
    package: {
      name: "@openclaw/memory-lancedb",
      distWorkerPath: "memory-stats.worker.js",
    },
  },
  memoryWikiQuery: {
    plugin: "memory-wiki",
    ownerSource: "extensions/memory-wiki/src/query-reader.ts",
    sourceWorkerName: "query-reader.worker",
    distWorkerPath: "extensions/memory-wiki/src/query-reader.worker.js",
    package: {
      name: "@openclaw/memory-wiki",
      distWorkerPath: "src/query-reader.worker.js",
    },
  },
  openAiRealtimeAudio: {
    plugin: "openai",
    ownerSource: "extensions/openai/realtime-quicksilver-peer.runtime.ts",
    sourceWorkerName: "realtime-quicksilver-audio.worker",
    distWorkerPath: "extensions/openai/realtime-quicksilver-audio.worker.js",
    package: {
      name: "@openclaw/openai-provider",
      distWorkerPath: "realtime-quicksilver-audio.worker.js",
    },
  },
  openAiRealtimeSocket: {
    plugin: "openai",
    ownerSource: "extensions/openai/realtime-quicksilver-socket.ts",
    sourceWorkerName: "realtime-quicksilver-socket.worker",
    distWorkerPath: "extensions/openai/realtime-quicksilver-socket.worker.js",
    package: {
      name: "@openclaw/openai-provider",
      distWorkerPath: "realtime-quicksilver-socket.worker.js",
    },
  },
  qaExecutionIdentityInspection: {
    plugin: "qa-lab",
    ownerSource: "extensions/qa-lab/src/execution-identity-storage-inspection.ts",
    sourceWorkerName: "execution-identity-storage-inspection.worker",
    distWorkerPath: "extensions/qa-lab/src/execution-identity-storage-inspection.worker.js",
    package: {
      name: "@openclaw/qa-lab",
      distWorkerPath: "src/execution-identity-storage-inspection.worker.js",
    },
  },
  telegramIngress: {
    plugin: "telegram",
    ownerSource: "extensions/telegram/src/telegram-ingress-worker.ts",
    sourceWorkerName: "telegram-ingress-worker.runtime",
    distWorkerPath: "telegram-ingress-worker.runtime.js",
    package: {
      name: "@openclaw/telegram",
      distWorkerPath: "src/telegram-ingress-worker.runtime.js",
    },
  },
  onnxInference: {
    plugin: "onnx",
    ownerSource: "extensions/onnx/index.ts",
    sourceWorkerName: "src/inference.worker",
    distWorkerPath: "extensions/onnx/src/inference.worker.js",
    package: {
      name: "@openclaw/onnx",
      distWorkerPath: "src/inference.worker.js",
    },
  },
  teamReportsStore: {
    plugin: "team-reports",
    ownerSource: "extensions/team-reports/index.ts",
    sourceWorkerName: "src/store.worker",
    distWorkerPath: "extensions/team-reports/src/store.worker.js",
    package: {
      name: "@openclaw/team-reports",
      distWorkerPath: "src/store.worker.js",
    },
  },
  teamReportsRun: {
    plugin: "team-reports",
    ownerSource: "extensions/team-reports/index.ts",
    sourceWorkerName: "src/run.worker",
    distWorkerPath: "extensions/team-reports/src/run.worker.js",
    package: {
      name: "@openclaw/team-reports",
      distWorkerPath: "src/run.worker.js",
    },
  },
  logbookStore: {
    plugin: "logbook",
    ownerSource: "extensions/logbook/index.ts",
    sourceWorkerName: "src/store.worker",
    distWorkerPath: "extensions/logbook/src/store.worker.js",
    package: {
      name: "@openclaw/logbook",
      distWorkerPath: "src/store.worker.js",
    },
  },
  workboardSqlite: {
    plugin: "workboard",
    ownerSource: "extensions/workboard/index.ts",
    sourceWorkerName: "src/sqlite-store.worker",
    distWorkerPath: "extensions/workboard/src/sqlite-store.worker.js",
    package: {
      name: "@openclaw/workboard",
      distWorkerPath: "src/sqlite-store.worker.js",
    },
  },
} as const;

export function createPluginRuntimeProcessEntrypoint(
  name: keyof typeof pluginRuntimeProcessManifest,
  currentModuleUrl: string,
) {
  return { ...pluginRuntimeProcessManifest[name], currentModuleUrl };
}

// Sealed deployment entries have different bootstrap wrappers, but the same target owner.
export const runtimeProcessDeployManifest = {
  worker: { source: "src/worker/worker-deploy-entry.ts", split: true },
  "code-mode-node.worker": { source: "src/agents/code-mode-node.worker.ts", split: false },
  "client-credential.worker": {
    source: "src/worker/worker-deploy-client-credentials.ts",
    split: false,
  },
  "file-tool-planning.worker": {
    source: "src/worker/worker-deploy-file-tool-planning.ts",
    split: false,
  },
  "file-tool-read.worker": { source: "src/worker/worker-deploy-file-tool-read.ts", split: false },
  "gateway-state-owner-heartbeat.worker": {
    source: "src/infra/gateway-state-owner-heartbeat.worker.ts",
    split: false,
  },
  "image-processor.worker": { source: "src/worker/worker-deploy-image-processor.ts", split: false },
  "sqlite-store.worker": { source: "src/worker/worker-deploy-sqlite-store.ts", split: false },
  "sqlite-source-revision.worker": {
    source: "src/worker/worker-deploy-sqlite-source-revision.ts",
    split: false,
  },
  "openclaw-state-read.worker": { source: "src/worker/worker-deploy-state-read.ts", split: true },
  "worker-native-lifecycle.worker": {
    source: "src/infra/worker-native-lifecycle.worker.ts",
    split: false,
  },
} as const;

export const runtimeProcessHelperManifest = {
  "workspace-rsync-receiver": { source: "src/worker/workspace-rsync-receiver.ts", sealed: false },
  "github-exec-launcher": { source: "src/agents/github-exec-launcher.ts", sealed: false },
  "service-child-relay": { source: "src/process/supervisor/service-child-relay.ts", sealed: true },
  "service-child-group-anchor": {
    source: "src/process/supervisor/service-child-group-anchor.ts",
    sealed: true,
  },
} as const;

export const runtimeProcessStandaloneModules = [
  "../openclaw.mjs",
  "../node-compile-cache.mjs",
  "tooling/managed-memory-launcher.js",
  "tooling/managed-windows-job-launcher.js",
] as const;

// These dependency entries are emitted by the portable worker build. Only the
// filesystem watcher is itself a Worker; the highlighter is a lazy module.
export const runtimeProcessWorkerDependencies = {
  "worker-chunk-highlight": "node_modules/highlight.js/lib/index.js",
  "worker-chunk-fs-safe-watch-io": "node_modules/@openclaw/fs-safe/dist/watch-io-worker.js",
} as const;

/** The selected artifact is a projection of declarations, never filename discovery. */
export function createStandaloneRuntimeProcessEntrypoints(
  currentModuleUrl: string,
  pluginDirectories: readonly string[],
) {
  const plugins = Object.entries(pluginRuntimeProcessManifest).filter(([, entry]) =>
    pluginDirectories.includes(entry.plugin),
  );
  const deploy = [
    ...Object.keys(runtimeProcessDeployManifest),
    ...Object.keys(runtimeProcessHelperManifest),
    "worker-chunk-fs-safe-watch-io",
  ];
  return {
    ...createRuntimeProcessEntrypoints(currentModuleUrl),
    ...Object.fromEntries(plugins.map(([name, entry]) => [`plugin:${name}`, entry])),
    ...Object.fromEntries(
      deploy.map((name) => [`deploy:${name}`, { distWorkerPath: `worker/${name}.mjs` }]),
    ),
    ...Object.fromEntries(
      runtimeProcessStandaloneModules.map((name) => [`module:${name}`, { distWorkerPath: name }]),
    ),
  };
}

// Script assets execute in their destination runtime rather than a worker thread.
export const runtimeProcessScriptEntrypoints = {
  workspaceQuiescence: {
    sourceModule: "src/gateway/worker-environments/workspace-quiescence-scripts.ts",
    export: "workspaceQuiescenceArgv",
    kind: "argv",
  },
} as const;
