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

  const loaderFreeEntrypoint = (modulePath: string) =>
    runtimeProcessEntrypoint(modulePath, undefined, undefined, ".mjs");

  return {
    daemonRuntimeProbe: runtimeProcessEntrypoint("infra/daemon-runtime-probe.entry"),
    pluginToolsServe: runtimeProcessEntrypoint("mcp/plugin-tools-serve"),
    openclawToolsServe: runtimeProcessEntrypoint("mcp/openclaw-tools-serve"),
    repositoryPublicationRestore: loaderFreeEntrypoint(
      "gateway/repository-publication-restore.generated.worker",
    ),
    nodeWorkspacePublicationSnapshot: loaderFreeEntrypoint(
      "node-host/node-worker-publication-snapshot.generated.worker",
    ),
    nodeWorkspaceManifest: loaderFreeEntrypoint(
      "node-host/node-worker-workspace-manifest.generated.worker",
    ),
    nodeWorkspaceGitHistory: loaderFreeEntrypoint(
      "node-host/node-worker-workspace-git-history.generated.worker",
    ),
    doctorDatabaseEngineInspection: runtimeProcessEntrypoint(
      "commands/doctor-database-engine-inspection.worker",
    ),
    backupDatabaseDiscovery: runtimeProcessEntrypoint("infra/backup-database-discovery.worker"),
    sqliteHeaderProbe: runtimeProcessEntrypoint("infra/sqlite-header-probe.worker"),
    databaseBackup: runtimeProcessEntrypoint("snapshot/database-backup.worker"),
    managedHandoffEngine: runtimeProcessEntrypoint(
      "infra/update-managed-service-handoff-engine.worker",
    ),
    updatePostgresState: runtimeProcessEntrypoint("infra/update-candidate-state.postgres.worker"),
    databasePortCommand: runtimeProcessEntrypoint(
      "infra/database-engine/port-command.entry.worker",
    ),
    systemCaWarmup: runtimeProcessEntrypoint("gateway/system-ca-warmup.worker"),
    shutdownHardExit: loaderFreeEntrypoint("cli/gateway-cli/shutdown-hard-exit.worker"),
    packageIntegrityHasher: runtimeProcessEntrypoint(
      "infra/package-update-integrity-hasher.worker",
    ),
    packageLocalOverrides: runtimeProcessEntrypoint("infra/package-local-overrides.worker"),
    directoryWatchHost: runtimeProcessEntrypoint("infra/directory-watch-host.worker"),
    directoryWatchParent: runtimeProcessEntrypoint("infra/directory-watch-parent.worker"),
    workspaceQuiescenceAcquire: loaderFreeEntrypoint(
      "gateway/worker-environments/workspace-quiescence-acquire.generated.worker",
    ),
    workspaceQuiescenceRenew: loaderFreeEntrypoint(
      "gateway/worker-environments/workspace-quiescence-renew.generated.worker",
    ),
    workspaceQuiescenceRelease: loaderFreeEntrypoint(
      "gateway/worker-environments/workspace-quiescence-release.generated.worker",
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
    shellSnapshotEnvironment: runtimeProcessEntrypoint("agents/shell-snapshot-env.worker"),
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
    retiredWorktreeCleanup: runtimeProcessEntrypoint(
      "agents/worktrees/retired-worktree-cleanup.worker",
    ),
    updateNativeGate: runtimeProcessEntrypoint("cli/update-cli/update-command-native-gate.worker"),
    updateStateSizes: runtimeProcessEntrypoint("infra/update-state-sizes.entry"),
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
    usageOverview: runtimeProcessEntrypoint("infra/session-cost-usage-overview-report.worker"),
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
function pluginRuntimeProcess<
  const Plugin extends string,
  const Owner extends string,
  const Worker extends string,
>(plugin: Plugin, owner: Owner, worker: Worker) {
  return {
    plugin,
    ownerSource: `extensions/${plugin}/${owner}.ts`,
    sourceWorkerName: worker,
    distWorkerPath: `extensions/${plugin}/${worker}.js`,
    package: { name: `@openclaw/${plugin}`, distWorkerPath: `${worker}.js` },
  } as const;
}

export const pluginRuntimeProcessManifest = {
  browserNativeHost: {
    ...pluginRuntimeProcess("browser", "native-host-entry", "native-host-entry"),
    package: { name: "@openclaw/browser-plugin", distWorkerPath: "native-host-entry.js" },
  },
  browserRelayDaemon: {
    ...pluginRuntimeProcess("browser", "native-host-entry", "relay-daemon-entry"),
    package: { name: "@openclaw/browser-plugin", distWorkerPath: "relay-daemon-entry.js" },
  },
  browserSetup: {
    ...pluginRuntimeProcess("browser", "setup-entry", "setup-entry"),
    package: { name: "@openclaw/browser-plugin", distWorkerPath: "setup-entry.js" },
  },
  quickJsCodeMode: {
    ...pluginRuntimeProcess("code-mode-quickjs", "src/executor", "src/code-mode.worker"),
    sourceWorkerName: "code-mode.worker",
  },
  codexCatalogPage: pluginRuntimeProcess(
    "codex",
    "catalog-page-worker-entrypoint",
    "catalog-page.worker",
  ),
  codexSessionHistory: pluginRuntimeProcess(
    "codex",
    "session-history-worker-entrypoint",
    "session-history.worker",
  ),
  discordAudio: {
    ...pluginRuntimeProcess(
      "discord",
      "src/voice/audio-worker-thread",
      "src/voice/audio-worker.runtime",
    ),
    sourceWorkerName: "audio-worker.runtime",
  },
  documentExtractor: {
    ...pluginRuntimeProcess(
      "document-extract",
      "document-extractor-worker-entrypoint",
      "document-extractor.worker",
    ),
    package: {
      name: "@openclaw/document-extract-plugin",
      distWorkerPath: "document-extractor.worker.js",
    },
  },
  fileTransferDirFetch: {
    plugin: "file-transfer",
    ownerSource: "extensions/file-transfer/src/node-host/dir-fetch-archive.ts",
    sourceWorkerName: "dir-fetch-archive.worker",
    distWorkerPath: "extensions/file-transfer/src/node-host/dir-fetch-archive.worker.js",
    package: {
      name: "@openclaw/file-transfer",
      distWorkerPath: "src/node-host/dir-fetch-archive.worker.js",
    },
  },
  fileTransferDirList: {
    plugin: "file-transfer",
    ownerSource: "extensions/file-transfer/src/node-host/dir-list-worker-command.ts",
    sourceWorkerName: "dir-list.worker",
    distWorkerPath: "extensions/file-transfer/src/node-host/dir-list.worker.js",
    package: {
      name: "@openclaw/file-transfer",
      distWorkerPath: "src/node-host/dir-list.worker.js",
    },
  },
  iMessageChatDb: {
    ...pluginRuntimeProcess("imessage", "src/chat-db", "src/chat-db.worker"),
    sourceWorkerName: "chat-db.worker",
  },
  knowledgeRegistry: {
    ...pluginRuntimeProcess("knowledge", "src/registry-client", "src/registry-worker"),
    sourceWorkerName: "registry-worker",
  },
  knowledgeStorage: {
    ...pluginRuntimeProcess("knowledge", "src/storage-client", "src/storage-worker"),
    sourceWorkerName: "storage-worker",
  },
  mxcLauncher: {
    plugin: "mxc",
    ownerSource: "extensions/mxc/src/plugin-root.ts",
    sourceWorkerName: "mxc-spawn-launcher",
    sourceExtension: ".mjs",
    build: "static-asset",
    distWorkerPath: "extensions/mxc/mxc-spawn-launcher.mjs",
    package: {
      name: "@openclaw/mxc-sandbox",
      distWorkerPath: "mxc-spawn-launcher.mjs",
    },
  },
  onePasswordSecretResolver: {
    plugin: "onepassword",
    ownerSource: "extensions/onepassword/onepassword-secret-ref-resolver.js",
    sourceWorkerName: "onepassword-secret-ref-resolver",
    sourceExtension: ".js",
    build: "static-asset",
    distWorkerPath: "extensions/onepassword/onepassword-secret-ref-resolver.js",
    package: {
      name: "@openclaw/onepassword",
      distWorkerPath: "onepassword-secret-ref-resolver.js",
    },
  },
  vaultSecretResolver: {
    plugin: "vault",
    ownerSource: "extensions/vault/vault-secret-ref-resolver.js",
    sourceWorkerName: "vault-secret-ref-resolver",
    sourceExtension: ".js",
    build: "static-asset",
    distWorkerPath: "extensions/vault/vault-secret-ref-resolver.js",
    package: {
      name: "@openclaw/vault",
      distWorkerPath: "vault-secret-ref-resolver.js",
    },
  },
  memorySearch: {
    ...pluginRuntimeProcess(
      "memory-core",
      "src/memory/manager-cpu-entrypoints",
      "src/memory/manager-search.worker",
    ),
    sourceWorkerName: "manager-search.worker",
    distWorkerPath: "extensions/memory-core/memory-search.worker.js",
  },
  memoryIndex: {
    ...pluginRuntimeProcess(
      "memory-core",
      "src/memory/manager-cpu-entrypoints",
      "src/memory/manager-index.worker",
    ),
    sourceWorkerName: "manager-index.worker",
    distWorkerPath: "extensions/memory-core/memory-index.worker.js",
  },
  memoryPublication: {
    ...pluginRuntimeProcess(
      "memory-core",
      "src/memory/manager-cpu-entrypoints",
      "src/memory/manager-publication.worker",
    ),
    sourceWorkerName: "manager-publication.worker",
    distWorkerPath: "extensions/memory-core/memory-publication.worker.js",
  },
  memoryStandingIntents: {
    ...pluginRuntimeProcess(
      "memory-core",
      "src/memory/manager-cpu-entrypoints",
      "src/standing-intents.worker",
    ),
    sourceWorkerName: "../standing-intents.worker",
    distWorkerPath: "extensions/memory-core/standing-intents.worker.js",
  },
  memoryEntryOrigins: {
    ...pluginRuntimeProcess(
      "memory-core",
      "src/memory/manager-cpu-entrypoints",
      "src/memory-entry-origins.worker",
    ),
    sourceWorkerName: "../memory-entry-origins.worker",
    distWorkerPath: "extensions/memory-core/memory-entry-origins.worker.js",
  },
  memoryStatsRuntime: pluginRuntimeProcess(
    "memory-lancedb",
    "memory-stats-entrypoint",
    "memory-stats.worker",
  ),
  memoryWikiQuery: {
    ...pluginRuntimeProcess("memory-wiki", "src/query-reader", "src/query-reader.worker"),
    sourceWorkerName: "query-reader.worker",
  },
  openAiRealtimeAudio: {
    ...pluginRuntimeProcess(
      "openai",
      "realtime-quicksilver-peer.runtime",
      "realtime-quicksilver-audio.worker",
    ),
    package: {
      name: "@openclaw/openai-provider",
      distWorkerPath: "realtime-quicksilver-audio.worker.js",
    },
  },
  openAiRealtimeSocket: {
    ...pluginRuntimeProcess(
      "openai",
      "realtime-quicksilver-socket",
      "realtime-quicksilver-socket.worker",
    ),
    package: {
      name: "@openclaw/openai-provider",
      distWorkerPath: "realtime-quicksilver-socket.worker.js",
    },
  },
  qaExecutionIdentityInspection: {
    ...pluginRuntimeProcess(
      "qa-lab",
      "src/execution-identity-storage-inspection",
      "src/execution-identity-storage-inspection.worker",
    ),
    sourceWorkerName: "execution-identity-storage-inspection.worker",
  },
  telegramIngress: {
    ...pluginRuntimeProcess(
      "telegram",
      "src/telegram-ingress-worker",
      "src/telegram-ingress-worker.runtime",
    ),
    sourceWorkerName: "telegram-ingress-worker.runtime",
    distWorkerPath: "telegram-ingress-worker.runtime.js",
  },
  onnxInference: pluginRuntimeProcess("onnx", "index", "src/inference.worker"),
  teamReportsStore: pluginRuntimeProcess("team-reports", "index", "src/store.worker"),
  teamReportsRun: pluginRuntimeProcess("team-reports", "index", "src/run.worker"),
  logbookStore: pluginRuntimeProcess("logbook", "index", "src/store.worker"),
  workboardSqlite: pluginRuntimeProcess("workboard", "index", "src/sqlite-store.worker"),
} as const;

export function createPluginRuntimeProcessEntrypoint<
  Name extends keyof typeof pluginRuntimeProcessManifest,
>(name: Name, currentModuleUrl: string) {
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

export function runtimeProcessDeployEntryFileName<
  Name extends keyof typeof runtimeProcessDeployManifest,
>(name: Name): `${Name}.mjs` {
  return `${name}.mjs`;
}

export const runtimeProcessHelperManifest = {
  "workspace-rsync-receiver": { source: "src/worker/workspace-rsync-receiver.ts", sealed: false },
  "github-exec-launcher": { source: "src/agents/github-exec-launcher.ts", sealed: false },
  "service-child-relay": { source: "src/process/supervisor/service-child-relay.ts", sealed: true },
  "service-child-group-anchor": {
    source: "src/process/supervisor/service-child-group-anchor.ts",
    sealed: true,
  },
} as const;

// Each sealed bootstrap selects only the sibling entries it owns.
export const runtimeProcessSealedManifest = {
  worker: {
    ownerSource: "src/worker/worker-deploy-runtime.ts",
    entries: [
      ["clientCredentials", "client-credential.worker"],
      ["codeModeNode", "code-mode-node.worker"],
      ["stateRead", "openclaw-state-read.worker"],
      ["workerNativeLifecycle", "worker-native-lifecycle.worker"],
      ["fileToolPlanning", "file-tool-planning.worker"],
      ["fileToolRead", "file-tool-read.worker"],
      ["gatewayStateOwnerHeartbeat", "gateway-state-owner-heartbeat.worker"],
      ["githubExec", "github-exec-launcher"],
      ["imageProcessor", "image-processor.worker"],
      ["serviceChildRelay", "service-child-relay"],
      ["sqliteSourceRevision", "sqlite-source-revision.worker"],
      ["sqliteStore", "sqlite-store.worker"],
      ["sharedStateStore", "sqlite-store.worker"],
    ],
  },
  serviceChildRelay: {
    ownerSource: "src/process/supervisor/service-child-relay.ts",
    entries: [["serviceChildGroupAnchor", "service-child-group-anchor"]],
  },
} as const satisfies Record<
  string,
  {
    ownerSource: string;
    entries: readonly (readonly [
      keyof ReturnType<typeof createRuntimeProcessEntrypoints>,
      keyof typeof runtimeProcessDeployManifest | keyof typeof runtimeProcessHelperManifest,
    ])[];
  }
>;

export function createSealedRuntimeProcessEntrypoints(
  group: keyof typeof runtimeProcessSealedManifest,
  currentModuleUrl: string,
) {
  return runtimeProcessSealedManifest[group].entries.map(([name, entry]) => ({
    name,
    url: new URL(`./${entry}.mjs`, currentModuleUrl),
  }));
}

/** Source-only build workers are declared without entering the packaged runtime graph. */
export const runtimeProcessToolingEntrypoints = {
  kyselyTypes: "scripts/generate-kysely-types.mts",
  npmPackageLock: "scripts/generate-npm-package-lock.worker.mts",
  testSelectorSourceScan: "scripts/lib/test-selector-source-facts.worker.mts",
} as const;

export function resolveRuntimeToolingEntrypointUrl(
  name: keyof typeof runtimeProcessToolingEntrypoints,
): URL {
  return new URL(`../../${runtimeProcessToolingEntrypoints[name]}`, import.meta.url);
}

// These programs belong to the selected external installation, not the running image.
export const runtimeProcessExternalPackageEntrypoints = {
  sourceCli: "src/entry.ts",
  sourceUiBuild: "scripts/ui.js",
  sourcePluginMetadata: "scripts/copy-bundled-plugin-metadata.mjs",
  sourceRunner: "scripts/run-node.mjs",
  cliLauncher: "openclaw.mjs",
  gatewayIndex: "dist/index.js",
  gatewayIndexModule: "dist/index.mjs",
  gatewayEntry: "dist/entry.js",
  gatewayEntryModule: "dist/entry.mjs",
  preinstall: "scripts/preinstall-package-manager-warning.mjs",
  postinstall: "scripts/postinstall-bundled-plugins.mjs",
  fsSafePrebuild: "scripts/lib/fs-safe-prebuild.mjs",
} as const;

/** Dependency programs retain their installed package topology and disk runtime. */
export const runtimeProcessDependencyEntrypoints = {
  npm: {
    specifier: "npm/bin/npm-cli.js",
    packageJsonSpecifier: "npm/package.json",
    relativePath: "bin/npm-cli.js",
    execution: "external-disk",
    kind: "standalone-package-manager",
  },
  npx: {
    specifier: "npm/bin/npx-cli.js",
    packageJsonSpecifier: "npm/package.json",
    relativePath: "bin/npx-cli.js",
    execution: "external-disk",
    kind: "standalone-package-manager",
  },
  chromeDevtoolsMcp: {
    specifier: "chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
    execution: "external-disk",
    kind: "package",
  },
  matrixCryptoDownload: {
    specifier: "@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js",
    execution: "external-disk",
    kind: "package",
  },
} as const;

// Keep installed CLI recovery compatible with the supported historical entry order.
export const runtimeProcessGatewayEntrypointNames = [
  "gatewayIndex",
  "gatewayIndexModule",
  "gatewayEntry",
  "gatewayEntryModule",
] as const satisfies readonly (keyof typeof runtimeProcessExternalPackageEntrypoints)[];

const runtimeProcessStandaloneModules = [
  "../runtime-process-scripts.generated.mjs",
  "../openclaw.mjs",
  "../node-compile-cache.mjs",
  "../runtime-process-bootstrap.generated.mjs",
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
  bunSqliteLibraryProbe: {
    buildSource: "src/infra/bun-sqlite-library-probe.entry.ts",
    sourceModule: "src/infra/bun-sqlite-library-probe.generated.ts",
    sourceBinding: "BUN_SQLITE_LIBRARY_PROBE_SOURCE",
    kind: "file",
    fileName: "bun-sqlite-library-probe.mjs",
    materialize: true,
  },
  packageCliNodeProbe: {
    buildSource: "scripts/lib/package-cli-node-probe.entry.mjs",
    sourceModule: "scripts/lib/package-cli-node-probe.generated.mjs",
    sourceBinding: "PACKAGE_CLI_NODE_PROBE_SOURCE",
    kind: "file",
    fileName: "package-cli-node-probe.mjs",
    materialize: true,
  },
  fsSafeNpmCliPreload: {
    buildSource: "scripts/lib/fs-safe-npm-cli-preload.entry.mjs",
    sourceModule: "scripts/lib/fs-safe-npm-cli-preload.generated.mjs",
    sourceBinding: "FS_SAFE_NPM_CLI_PRELOAD_DATA_URL",
    kind: "data-url",
  },
  repositoryPublicationRestoreRemote: {
    sourceModule: "src/gateway/github-repository-publication-restore.ts",
    sourceBinding: "RESTORE_PUBLICATION_INDEX_JS",
    kind: "source",
  },
  nodeRuntimeProbe: {
    buildSource: "src/infra/node-runtime-probe.entry.ts",
    sourceModule: "src/infra/node-runtime-probe.generated.mjs",
    sourceBinding: "NODE_RUNTIME_PROBE_SOURCE",
    kind: "file",
    fileName: "node-runtime-probe.mjs",
    materialize: true,
  },
  daemonRuntimeProbe: {
    buildSource: "src/infra/daemon-runtime-probe.entry.ts",
    sourceModule: "src/infra/daemon-runtime-probe.generated.mjs",
    sourceBinding: "DAEMON_RUNTIME_PROBE_SOURCE",
    kind: "file",
    fileName: "daemon-runtime-probe.mjs",
    materialize: true,
    runtimeEntrypoint: "daemonRuntimeProbe",
  },
  updateStateSizes: {
    sourceModule: "src/infra/update-state-sizes.generated.mjs",
    sourceBinding: "UPDATE_STATE_SIZES_SOURCE",
    kind: "file",
    fileName: "update-state-sizes.mjs",
    materialize: true,
    runtimeEntrypoint: "updateStateSizes",
  },
  updateNativeGate: {
    sourceModule: "src/cli/update-cli/update-command-native-gate.generated.ts",
    sourceBinding: "UPDATE_NATIVE_GATE_SOURCE",
    kind: "file",
    fileName: "update-native-gate.mjs",
  },
  managedUpdateHandoff: {
    sourceModule: "src/infra/update-managed-service-handoff.ts",
    sourceBinding: "HANDOFF_SCRIPT",
    kind: "file",
    fileName: "handoff.cjs",
  },
  workspaceQuiescence: {
    sourceModule: "src/gateway/worker-environments/workspace-quiescence-scripts.ts",
    export: "workspaceQuiescenceArgv",
    kind: "argv",
  },
} as const;
