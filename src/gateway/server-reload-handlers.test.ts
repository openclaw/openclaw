import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { prepareRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { addSession, markBackgrounded, markExited } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
  type PersistedPluginModelCatalog,
} from "../agents/plugin-model-catalog.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { prepareConfigRuntimeEnv } from "../config/config-env-vars.js";
import type { ConfigWriteNotification } from "../config/config.js";
import { applyModelDefaults } from "../config/defaults.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
  type RuntimeConfigWriteApplicationStatus,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCronJobsStore, resolveCronJobsStorePathFromConfigAsync } from "../cron/store.js";
import {
  consumeGatewayRestartIntent,
  isGatewayRestartExternallyAllowed,
  markGatewayRestartHandled,
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  setGatewayRestartPolicy,
  setPreRestartDeferralCheck,
} from "../infra/restart.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import {
  captureActivePluginRegistrySnapshot,
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { CommandLane } from "../process/lanes.js";
import { createSimpleChannelSecretContract } from "../secrets/channel-secret-basic-runtime.js";
import { providerResolutionError } from "../secrets/resolve-errors.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
import { listActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import {
  classifySecretOwnerDegradationState,
  listSecretAssignmentOwners,
  resolveAndApplySecretAssignments,
} from "../secrets/runtime-owner-assignments.js";
import { createResolverContext } from "../secrets/runtime-shared.js";
import {
  activateSecretsRuntimeSnapshot,
  activateSecretsRuntimeSnapshotIfCurrent,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { isRecord } from "../utils.js";
import { diffConfigPaths, diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
  type ChannelKind,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import type { GatewayHotReloadApplication } from "./config-reload-status.types.js";
import {
  createConfigReloadTestClock,
  createPluginLifecycleLeaseTestClock,
  createRecoveryRestartMock,
  createReloadWarningObserver,
  prepareConfigReloadTest,
  waitForReloadState,
} from "./config-reload.test-support.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";
import { applyHookMappings, commitHookTransformMappingReload } from "./hooks-mapping.js";
import { createChannelManager } from "./server-channels.js";
import { createLazyGatewayCronState } from "./server-cron-lazy.js";
import type { GatewayCronState } from "./server-cron.js";
import {
  GatewayConfigReloadSupersededError,
  type GatewayPluginReloadResult,
} from "./server-reload-contracts.js";
import { abortPendingChannelReloads } from "./server-reload-generation.js";
import {
  captureConfigWriteListener,
  createTestConfigRevisionProjector,
  createConfigWriteListenerRef,
  createManagedReloadAuthFixture,
  createMonitorPublicationFailure,
  createManagedRestartSequenceConfigs,
  createConfigWriteNotification,
  createRecordedChannelHandlers,
  createCronRestartPlan,
  createDirectConfigWriteFixture,
  createDefaultGatewayReloadState,
  createGatewayRestartPlan,
  createHotTailPlan,
  createPluginReloadPlan,
  createTestCronState,
  createValidConfigSnapshot,
  enableChannelReloadsForTest,
  makePluginReloadResult,
  publishConfigWrite,
} from "./server-reload-handlers.config.test-support.js";
import {
  createSupervisedExitWatcherFixture,
  fixtureLifetime,
  waitForFast,
} from "./server-reload-handlers.process.test-support.js";
import { registerGatewayTargetedServiceReloadTests } from "./server-reload-handlers.services.test-support.js";
import { registerGatewaySupersededReloadTests } from "./server-reload-handlers.supersession.test-support.js";
import { createGatewayReloadHandlers as createGatewayReloadHandlersImpl } from "./server-reload-hot.js";
import { createManagedReloadSecretHandlers } from "./server-reload-managed-secrets.js";
import { startManagedGatewayConfigReloader as startManagedGatewayConfigReloaderImpl } from "./server-reload-managed.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";
import {
  createMockRuntimeSecretsActivator,
  createTestRuntimeSecretsActivator,
  makePreparedSecretsSnapshot,
} from "./server-startup-config.test-support.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { createTerminalLaunchPolicy } from "./terminal/launch.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import {
  baseOpenRequest,
  expectTerminalOpen,
  makeFakePty,
} from "./terminal/session-manager.test-helpers.js";

type ReloadHandlerParams = Parameters<typeof createGatewayReloadHandlersImpl>[0];
type ManagedReloaderParams = Parameters<typeof startManagedGatewayConfigReloaderImpl>[0];
async function withChannelReloadsEnabled<T>(run: () => Promise<T>): Promise<T> {
  const restoreChannelReloadEnv = enableChannelReloadsForTest();
  try {
    return await run();
  } finally {
    restoreChannelReloadEnv();
  }
}

type ManagedReloaderTestParams = Pick<
  ManagedReloaderParams,
  "initialConfig" | "readSnapshot" | "subscribeToWrites"
> &
  Partial<ManagedReloaderParams>;

const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

const restartTesting = {
  resetRestartSignalState() {
    resetGatewayRestartStateForInProcessRestart();
    markGatewayRestartHandled();
    setGatewayRestartPolicy({ allowExternal: false });
    setPreRestartDeferralCheck(() => 0);
    resetGatewayWorkAdmission();
  },
};

function createGatewayReloadHandlers(
  params: Partial<Omit<ReloadHandlerParams, "requestRecoveryRestart">> & {
    requestRecoveryRestart?: NonNullable<ReloadHandlerParams["requestRecoveryRestart"]> | null;
  },
) {
  const { requestRecoveryRestart, ...handlerParams } = params;
  let state = createDefaultGatewayReloadState();
  return createGatewayReloadHandlersImpl({
    scheduler: createTestGatewayScheduler("fake-timers"),
    getPluginRegistry: requireActivePluginChannelRegistry,
    deps: {} as never,
    broadcast: vi.fn(),
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
    },
    startChannel: vi.fn(async () => new Map()),
    stopChannel: vi.fn(async () => {}),
    releaseChannelRouteHandoffs: vi.fn(),
    pruneInactiveChannelAccountState: vi.fn(),
    stopPostReadySidecars: vi.fn(),
    reloadPlugins: vi.fn<ReloadHandlerParams["reloadPlugins"]>(async ({ prepareConfigEffects }) => {
      prepareConfigEffects({ pluginIds: new Set(), channels: new Set() }).retire();
      return makePluginReloadResult();
    }),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload: { info: vi.fn(), warn: vi.fn() },
    ...handlerParams,
    cronReconciliation: params.cronReconciliation ?? createTestCronReconciliation(),
    ...(requestRecoveryRestart === null
      ? {}
      : {
          requestRecoveryRestart:
            requestRecoveryRestart ?? requestGatewayRestartWithSignalAdmission,
        }),
  });
}

function startManagedGatewayConfigReloader(params: ManagedReloaderTestParams) {
  let state = createDefaultGatewayReloadState();
  return startManagedGatewayConfigReloaderImpl({
    scheduler: createTestGatewayScheduler("fake-timers"),
    getPluginRegistry: requireActivePluginChannelRegistry,
    minimalTestGateway: false,
    initialPluginInstallRecords: {},
    initialCompareConfig: params.initialConfig,
    watchPath: "/tmp/openclaw.json",
    promoteSnapshot: vi.fn(async () => true) as never,
    deps: {} as never,
    broadcast: vi.fn(),
    getState: () => state,
    setState: (nextState) => {
      state = nextState;
    },
    startChannel: vi.fn(async () => new Map()),
    stopChannel: vi.fn(async () => {}),
    reloadPlugins: vi.fn<ReloadHandlerParams["reloadPlugins"]>(async ({ prepareConfigEffects }) => {
      prepareConfigEffects({ pluginIds: new Set(), channels: new Set() }).retire();
      return makePluginReloadResult();
    }),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    channelManager: {
      pruneInactiveChannelAccountState: vi.fn(),
      releaseChannelRouteHandoffs: vi.fn(),
    } as never,
    activateRuntimeSecrets: params.activateRuntimeSecrets ?? createMockRuntimeSecretsActivator(),
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
      current: undefined,
      required: null,
    }),
    clients: [],
    reconcileRuntimePolicy: vi.fn(),
    commitRuntimePolicy: vi.fn(),
    acceptTerminalConfig: vi.fn(),
    ...params,
    configRevisionProjector: params.configRevisionProjector ?? createTestConfigRevisionProjector(),
    initialSnapshotRawHash: params.initialSnapshotRawHash ?? null,
    initialAuthoredConfig: params.initialAuthoredConfig ?? {},
    initialSnapshotValid: params.initialSnapshotValid ?? true,
    initialSnapshotIssues: params.initialSnapshotIssues ?? [],
    cronReconciliation: params.cronReconciliation ?? createTestCronReconciliation(),
    prepareTerminalConfig: params.prepareTerminalConfig ?? vi.fn(),
    requestRecoveryRestart:
      params.requestRecoveryRestart ?? requestGatewayRestartWithSignalAdmission,
  });
}

type GmailWatcherRestartParams = {
  cfg: OpenClawConfig;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  onSkipped?: () => void;
  signal?: AbortSignal;
};

type StartGmailWatcherWithLogs = (params: GmailWatcherRestartParams) => Promise<void>;
type StopGmailWatcher = () => Promise<void>;

const hoisted = vi.hoisted(() => ({
  startGmailWatcherWithLogs: vi.fn<StartGmailWatcherWithLogs>(async () => {}),
  stopGmailWatcher: vi.fn<StopGmailWatcher>(async () => {}),
  activeAgentRunCount: { value: 0 },
  activeEmbeddedRunCount: { value: 0 },
  activeEmbeddedRunSessionIds: [] as string[],
  activeEmbeddedRunSessionKeys: [] as string[],
  markRestartAbortedMainSessions: vi.fn(async (_params: unknown) => ({ marked: 1, skipped: 0 })),
  runtimeConfig: { value: { session: { store: "/tmp/active-sessions.json" } } as OpenClawConfig },
  assertOpenClawDatabasesReady: vi.fn(() => {}),
  applyLoggingConfig: vi.fn(),
  resetSkillSnapshotConfigFingerprintCache: vi.fn(),
  reloadEvents: [] as string[],
  loadModelCatalog: vi.fn(async (_params: { config: OpenClawConfig }) => []),
  resetModelCatalogCache: vi.fn(() => {}),
  advancePreparedModelRuntimeConfig: vi.fn((_cfg: OpenClawConfig) => {}),
  markPreparedModelRuntimeSnapshotsStale: vi.fn(
    (
      _reason?: string,
      _options?: {
        waitForReplacement?: boolean;
        preserveReplacementWait?: boolean;
        agentIds?: ReadonlySet<string>;
      },
    ) => Symbol("prepared-model-runtime-replacement"),
  ),
  rejectPendingPreparedModelRuntimeReplacement: vi.fn(
    (_gateId: symbol | undefined, _error: unknown) => {},
  ),
  refreshPreparedModelRuntimeSnapshots: vi.fn(
    async (_cfg: OpenClawConfig, _options?: { catalogMode?: "live" | "static" }) => {},
  ),
  refreshContextWindowCache: vi.fn(async (_cfg: OpenClawConfig) => {}),
  reloadSessionMcpRuntimes: vi.fn(async () => {}),
  buildGatewayCronService: vi.fn((_params?: { env?: NodeJS.ProcessEnv }) => ({
    cron: { start: vi.fn(async () => {}), stop: vi.fn() },
    storePath: "/tmp/rebuilt-cron.json",
    cronEnabled: true,
    reconcileExitWatchers: vi.fn(async () => {}),
    reconcileStreamWatchers: vi.fn(async () => {}),
    stopStreamWatchers: vi.fn(async () => {}),
    reconcileSystemJobs: vi.fn<GatewayCronState["reconcileSystemJobs"]>(async () => "converged"),
  })),
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: hoisted.stopGmailWatcher,
}));

vi.mock("../hooks/gmail-watcher-lifecycle.js", () => ({
  startGmailWatcherWithLogs: hoisted.startGmailWatcherWithLogs,
}));

vi.mock(import("../infra/agent-run-registry.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  getActiveAgentRunContextCount: () => hoisted.activeAgentRunCount.value,
}));

vi.mock("../agents/embedded-agent-runner/active-run-projections.js", () => ({
  getActiveEmbeddedRunCount: () => hoisted.activeEmbeddedRunCount.value,
  listActiveEmbeddedRunSessionIds: () => hoisted.activeEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys: () => hoisted.activeEmbeddedRunSessionKeys,
}));

vi.mock("../agents/main-session-recovery/main-session-restart-recovery.js", () => ({
  markRestartAbortedMainSessions: hoisted.markRestartAbortedMainSessions,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => hoisted.runtimeConfig.value,
  };
});

vi.mock("../state/openclaw-database-preflight.js", () => ({
  assertOpenClawDatabasesReady: hoisted.assertOpenClawDatabasesReady,
}));

vi.mock("../logging/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/logger.js")>()),
  applyLoggingConfig: hoisted.applyLoggingConfig,
}));

vi.mock("../skills/runtime/snapshot-config-fingerprint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/runtime/snapshot-config-fingerprint.js")>()),
  resetSkillSnapshotConfigFingerprintCache: hoisted.resetSkillSnapshotConfigFingerprintCache,
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: (params: { config: OpenClawConfig }) => {
    hoisted.reloadEvents.push("load-model-catalog");
    return hoisted.loadModelCatalog(params);
  },
  resetModelCatalogCache: () => {
    hoisted.reloadEvents.push("reset-model-catalog");
    hoisted.resetModelCatalogCache();
  },
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  advancePreparedModelRuntimeConfig: hoisted.advancePreparedModelRuntimeConfig,
  beginPreparedModelRuntimePluginDrain: () => ({ pendingPublication: false, release: () => {} }),
  markPreparedModelRuntimeSnapshotsStale: (
    reason?: string,
    options?: { waitForReplacement?: boolean; preserveReplacementWait?: boolean },
  ) => {
    hoisted.reloadEvents.push("stale-prepared-model-runtime");
    return hoisted.markPreparedModelRuntimeSnapshotsStale(reason, options);
  },
  rejectPendingPreparedModelRuntimeReplacement:
    hoisted.rejectPendingPreparedModelRuntimeReplacement,
  refreshPreparedModelRuntimeSnapshots: (
    cfg: OpenClawConfig,
    options?: { catalogMode?: "live" | "static" },
  ) => {
    hoisted.reloadEvents.push("refresh-prepared-model-runtime");
    return hoisted.refreshPreparedModelRuntimeSnapshots(cfg, options);
  },
}));

vi.mock("../agents/context.js", () => ({
  resetContextWindowCache: vi.fn(),
  refreshContextWindowCache: async (cfg: OpenClawConfig) => {
    hoisted.reloadEvents.push("refresh-context-window");
    await hoisted.refreshContextWindowCache(cfg);
  },
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  reloadSessionMcpRuntimes: hoisted.reloadSessionMcpRuntimes,
}));

vi.mock("../plugins/installed-plugin-index-record-reader.js", () => ({
  clearLoadInstalledPluginIndexInstallRecordsCache: vi.fn(),
  loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
  loadInstalledPluginIndexInstallRecordsSync: vi.fn(() => ({})),
}));

vi.mock("./server-cron.js", async () => {
  const actual = await vi.importActual<typeof import("./server-cron.js")>("./server-cron.js");
  return {
    ...actual,
    buildGatewayCronService: hoisted.buildGatewayCronService,
  };
});

async function withReloadChannelManager(
  plugins: ChannelPlugin[],
  run: (fixture: {
    manager: ReturnType<typeof createChannelManager>;
    registry: { current: ReturnType<typeof createTestRegistry> };
    start: ReturnType<typeof vi.fn<ReloadHandlerParams["startChannel"]>>;
    stop: ReturnType<typeof vi.fn<ReloadHandlerParams["stopChannel"]>>;
  }) => Promise<void>,
  getRuntimeConfig: () => OpenClawConfig = () => ({}),
) {
  let closing = false;
  const monitors: Array<{ signal: AbortSignal; finished: Promise<void> }> = [];
  const registry = {
    current: createTestRegistry(
      plugins.map((plugin) => ({
        pluginId: plugin.id,
        source: "test",
        plugin: {
          ...plugin,
          gateway: {
            ...plugin.gateway,
            startAccount: async (context) => {
              const stopped = createDeferred();
              const finished = createDeferred();
              const onAbort = () => stopped.resolve();
              monitors.push({ signal: context.abortSignal, finished: finished.promise });
              context.abortSignal.addEventListener("abort", onAbort, { once: true });
              if (context.abortSignal.aborted) {
                onAbort();
              }
              try {
                await plugin.gateway?.startAccount?.(context);
                await stopped.promise;
              } finally {
                context.abortSignal.removeEventListener("abort", onAbort);
                finished.resolve();
              }
            },
            stopAccount: async (context) => {
              // Retire injected stop faults during fixture cleanup; the manager still aborts
              // and joins every real monitor before the registry is restored by afterEach.
              if (!closing) {
                await plugin.gateway?.stopAccount?.(context);
              }
            },
          },
        } satisfies ChannelPlugin,
      })),
    ),
  };
  setActivePluginRegistry(registry.current);
  const manager = createChannelManager({
    scheduler: createTestGatewayScheduler(),
    getRuntimeConfig,
    getPluginRegistry: () => registry.current,
    channelLogs: {},
    channelRuntimeEnvs: {},
    isClosing: () => closing,
  });
  try {
    await run({
      manager,
      registry,
      start: vi.fn(manager.startChannel),
      stop: vi.fn(manager.stopChannel),
    });
  } finally {
    closing = true;
    const stops = await Promise.allSettled(plugins.map(({ id }) => manager.stopChannel(id)));
    await Promise.all(monitors.map(({ finished }) => finished));
    expect(monitors.every(({ signal }) => signal.aborted)).toBe(true);
    for (const outcome of stops) {
      expect(outcome.status).toBe("fulfilled");
    }
  }
}

function createTestCronReconciliation() {
  const complete = vi.fn<() => Promise<void>>(async () => {});
  return {
    arm: vi.fn<() => { complete: () => Promise<void> }>(() => ({ complete })),
    invalidate: vi.fn(),
  };
}

function createReloadHandlersForTest(
  logReload = { info: vi.fn(), warn: vi.fn() },
  channels?: {
    start: ReloadHandlerParams["startChannel"];
    stop: ReloadHandlerParams["stopChannel"];
    pruneInactiveChannelAccountState?: ReloadHandlerParams["pruneInactiveChannelAccountState"];
  },
  reloadPlugins?: Parameters<typeof createGatewayReloadHandlers>[0]["reloadPlugins"],
  stopPostReadySidecars = vi.fn(),
  recovery: boolean | NonNullable<ReloadHandlerParams["requestRecoveryRestart"]> = true,
  options?: {
    getChannelAutostartSuppression?: ReloadHandlerParams["getChannelAutostartSuppression"];
  },
) {
  const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
  const reconcileSystemJobs = vi.fn<GatewayCronState["reconcileSystemJobs"]>(
    async () => "converged",
  );
  const heartbeatRunner = {
    stop: vi.fn(),
    updateConfig: vi.fn(),
  };
  let state: Parameters<ReloadHandlerParams["setState"]>[0] = {
    hooksConfig: {} as never,
    hookClientIpConfig: {} as never,
    heartbeatRunner: heartbeatRunner as never,
    cronState: createTestCronState({
      cron: cron as never,
      reconcileSystemJobs,
    }),
  };
  const setState = vi.fn((nextState: typeof state) => {
    state = nextState;
  });
  const cronReconciliation = createTestCronReconciliation();
  const logCron = { error: vi.fn() };
  const logChannels = { info: vi.fn(), error: vi.fn() };
  const handlers = createGatewayReloadHandlers({
    getState: () => state,
    setState,
    startChannel: channels?.start ?? vi.fn(async () => new Map()),
    stopChannel: channels?.stop ?? vi.fn(async () => {}),
    ...(channels?.pruneInactiveChannelAccountState
      ? { pruneInactiveChannelAccountState: channels.pruneInactiveChannelAccountState }
      : {}),
    ...(reloadPlugins ? { reloadPlugins } : {}),
    getChannelAutostartSuppression: options?.getChannelAutostartSuppression,
    stopPostReadySidecars,
    logChannels,
    logCron,
    logReload,
    cronReconciliation,
    requestRecoveryRestart:
      typeof recovery === "function"
        ? recovery
        : recovery
          ? requestGatewayRestartWithSignalAdmission
          : null,
    ...(typeof recovery === "boolean" ? { restartRecoveryAvailable: recovery } : {}),
  });
  return {
    ...handlers,
    cron,
    cronReconciliation,
    heartbeatRunner,
    logChannels,
    logCron,
    reconcileSystemJobs,
    setState,
  };
}

async function createManagedRestartSequenceHarness(
  options: {
    invalidateGenerationOnReconcile?: boolean;
    scheduler?: ManagedReloaderTestParams["scheduler"];
  } = {},
) {
  const watcher = installWatcherMock();
  onTestFinished(() => watcher.restore());
  const {
    initialConfig,
    deferredConfig,
    invalidConfig,
    invalidHotConfig,
    invalidNoopConfig,
    replacementConfig,
  } = createManagedRestartSequenceConfigs();
  setRuntimeConfigSnapshot(initialConfig, initialConfig);
  activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
  const terminalPolicy = createTerminalLaunchPolicy(initialConfig);
  const acceptTerminalConfig = vi.fn(terminalPolicy.acceptConfig);
  const writeListenerRef = createConfigWriteListenerRef();
  let snapshotConfig = initialConfig;
  let snapshotHash = "initial";
  const unavailableSecretIds = new Set(["MISSING_RESTART_TOKEN", "MISSING_HOT_TOKEN"]);
  let recordPromotion: ((hash: string) => void) | undefined;
  let recordReloadError: ((message: string) => void) | undefined;
  const reloadWarning = createReloadWarningObserver();
  const { requestRecoveryRestart, restartEmitted } = createRecoveryRestartMock();
  const nextPromotion = () =>
    new Promise<string>((resolve) => {
      recordPromotion = resolve;
    });
  const nextReloadError = () =>
    new Promise<string>((resolve) => {
      recordReloadError = resolve;
    });
  const promoteSnapshot = vi.fn(async (snapshot: { hash?: string }) => {
    recordPromotion?.(snapshot.hash ?? "");
    recordPromotion = undefined;
    return true;
  });
  const logReload = {
    info: vi.fn(),
    warn: vi.fn(reloadWarning.observe),
    error: vi.fn((message: string) => {
      recordReloadError?.(message);
      recordReloadError = undefined;
    }),
  };
  const activateRuntimeSecrets = createMockRuntimeSecretsActivator(async (config) => {
    const secretInputs = [
      config.gateway?.auth?.token,
      config.models?.providers?.test?.apiKey,
      (config.plugins?.entries?.brave?.config as { webSearch?: { apiKey?: unknown } } | undefined)
        ?.webSearch?.apiKey,
    ];
    for (const secretInput of secretInputs) {
      if (
        typeof secretInput === "object" &&
        secretInput !== null &&
        "id" in secretInput &&
        typeof secretInput.id === "string" &&
        unavailableSecretIds.has(secretInput.id)
      ) {
        throw new Error(`required SecretRef ${secretInput.id} is unavailable`);
      }
    }
    return makePreparedSecretsSnapshot(config);
  });
  const sharedGatewaySessionGenerationState = new SharedGatewaySessionGenerationState({
    current: undefined,
    required: null,
  });
  let generationInvalidated = false;
  const reloader = startManagedGatewayConfigReloader({
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    initialConfig,
    readSnapshot: vi.fn(async () =>
      createValidConfigSnapshot(snapshotConfig, snapshotHash),
    ) as never,
    promoteSnapshot: promoteSnapshot as never,
    subscribeToWrites: captureConfigWriteListener(writeListenerRef),
    logReload,
    activateRuntimeSecrets,
    prepareTerminalConfig: (plan, nextConfig) => {
      terminalPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
    },
    reconcileRuntimePolicy: vi.fn(() => {
      if (options.invalidateGenerationOnReconcile && !generationInvalidated) {
        generationInvalidated = true;
        enforceSharedGatewaySessionGenerationForConfigWrite({
          state: sharedGatewaySessionGenerationState,
          nextConfig: {},
          resolveRuntimeSnapshotGeneration: () => "concurrent-generation",
          clients: [],
        });
      }
    }),
    commitRuntimePolicy: terminalPolicy.commitConfig,
    acceptTerminalConfig,
    sharedGatewaySessionGenerationState,
    requestRecoveryRestart,
  });
  await reloader.ready;
  const writeConfig = (
    config: OpenClawConfig,
    hash: string,
    revision: number,
    runtimeConfig: OpenClawConfig = config,
  ) => {
    const listener = writeListenerRef.current;
    if (!listener) {
      throw new Error("Expected config write listener to be registered");
    }
    snapshotConfig = config;
    snapshotHash = hash;
    listener(
      createConfigWriteNotification(config, hash, revision, `runtime-${hash}`, `source-${hash}`, {
        runtimeConfig,
      }),
    );
  };

  return {
    acceptTerminalConfig,
    activateRuntimeSecrets,
    assertRestartReady: hoisted.assertOpenClawDatabasesReady,
    deferredConfig,
    initialConfig,
    invalidConfig,
    invalidHotConfig,
    invalidNoopConfig,
    logReload,
    nextPromotion,
    nextReloadError,
    nextReloadWarning: reloadWarning.next,
    restartEmitted,
    promoteSnapshot,
    reloader,
    replacementConfig,
    requestRecoveryRestart,
    sharedGatewaySessionGenerationState,
    terminalPolicy,
    watcher,
    setSecretAvailable: (id: string) => unavailableSecretIds.delete(id),
    setSecretUnavailable: (id: string) => unavailableSecretIds.add(id),
    writeConfig,
  };
}

async function withGatewayRestartSignal(
  run: (signalSpy: ReturnType<typeof vi.fn>) => Promise<void>,
) {
  const signalSpy = vi.fn();
  process.once("SIGUSR2", signalSpy);
  try {
    await run(signalSpy);
  } finally {
    process.removeListener("SIGUSR2", signalSpy);
    restartTesting.resetRestartSignalState();
  }
}

// Other gateway test helpers (test-helpers.mocks.ts, test-helpers.server.ts)
// set OPENCLAW_SKIP_CHANNELS / OPENCLAW_SKIP_PROVIDERS at module load. When a
// shared vitest worker imports those helpers before this file runs, the leaked
// env routes reloads into the skip branch and channel restarts never fire.
const testGatewayRestartListener = () => {};
let pluginRegistrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeEach((context) => {
  prepareConfigReloadTest(context);
  pluginRegistrySnapshot = captureActivePluginRegistrySnapshot();
  stageActivePluginRegistry(createTestRegistry([]), null, "default");
  process.on("SIGUSR2", testGatewayRestartListener);
  // Reset before handlers capture their lifecycle; resetting a live handler
  // deliberately revokes its authority to restart cron or channels.
  restartTesting.resetRestartSignalState();
  resetProcessRegistryForTests();
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
  hoisted.resetSkillSnapshotConfigFingerprintCache.mockClear();
  hoisted.applyLoggingConfig.mockClear();
});

afterEach(async () => {
  await fixtureLifetime.cleanup();
  restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
  process.removeListener("SIGUSR2", testGatewayRestartListener);
  setGatewayRestartPolicy({ allowExternal: false });
  resetGatewayWorkAdmission();
  vi.useRealTimers();
  resetProcessRegistryForTests();
  hoisted.startGmailWatcherWithLogs.mockClear();
  hoisted.stopGmailWatcher.mockClear();
  hoisted.activeAgentRunCount.value = 0;
  hoisted.activeEmbeddedRunCount.value = 0;
  hoisted.activeEmbeddedRunSessionIds.length = 0;
  hoisted.activeEmbeddedRunSessionKeys.length = 0;
  hoisted.markRestartAbortedMainSessions.mockClear();
  hoisted.runtimeConfig.value = { session: { store: "/tmp/active-sessions.json" } };
  hoisted.assertOpenClawDatabasesReady.mockClear();
  hoisted.reloadEvents.length = 0;
  hoisted.advancePreparedModelRuntimeConfig.mockClear();
  hoisted.markPreparedModelRuntimeSnapshotsStale.mockClear();
  hoisted.rejectPendingPreparedModelRuntimeReplacement.mockClear();
  hoisted.refreshPreparedModelRuntimeSnapshots.mockClear();
  hoisted.refreshContextWindowCache.mockClear();
  hoisted.reloadSessionMcpRuntimes.mockClear();
  hoisted.reloadSessionMcpRuntimes.mockResolvedValue(undefined);
  hoisted.buildGatewayCronService.mockClear();
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
});

async function runManagedOwnershipScenario(params: {
  kind: "noop" | "hot";
  getPluginMetadataSnapshot?: ManagedReloaderParams["getPluginMetadataSnapshot"];
  loggingChanged?: boolean;
  secretProviderChanged?: boolean;
  sharedAuthRotation?: boolean;
  resolvedProviderRotation?: "channel";
}) {
  const { auth, providerConfig, providerSource } = createManagedReloadAuthFixture(params);
  const initialConfig = {
    ...providerSource,
    gateway: {
      reload: {
        mode:
          params.sharedAuthRotation || params.resolvedProviderRotation
            ? ("hot" as const)
            : ("off" as const),
      },
      ...(auth ? { auth } : {}),
    },
    ...(params.secretProviderChanged
      ? { secrets: { providers: { default: { source: "file" as const, path: "/old" } } } }
      : {}),
    hooks: { enabled: true, token: "test-token", path: "/old" },
  } satisfies OpenClawConfig;
  const configA = {
    ...providerSource,
    gateway: {
      reload: {
        mode: "hot" as const,
      },
      ...(auth ? { auth } : {}),
    },
    hooks: {
      enabled: true,
      token: "test-token",
      path: params.kind === "noop" ? "/old" : "/a",
    },
    ...(params.kind === "noop" && !params.sharedAuthRotation && !params.resolvedProviderRotation
      ? { talk: { realtime: { instructions: "updated instructions" } } }
      : {}),
    ...(params.secretProviderChanged
      ? { secrets: { providers: { default: { source: "file" as const, path: "/new" } } } }
      : {}),
    ...(params.loggingChanged ? { logging: { level: "debug" as const } } : {}),
    ...(params.resolvedProviderRotation
      ? { channels: { slack: { streaming: { mode: "partial" as const } } } }
      : {}),
  } satisfies OpenClawConfig;
  const snapshot = (config: OpenClawConfig) => makePreparedSecretsSnapshot(config);
  const writeListenerRef = createConfigWriteListenerRef();
  const { promise: accepted, resolve: resolveAccepted } = createDeferred();
  const acceptTerminalConfig = vi.fn(() => resolveAccepted?.());
  const commitRuntimePolicy = vi.fn();
  const prepareTerminalConfig = vi.fn();
  const reconcileRuntimePolicy = vi.fn();
  const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
  const resolvedConfigs: OpenClawConfig[] = [];
  const activateRuntimeSecrets = createMockRuntimeSecretsActivator(async (config) => {
    if (!params.sharedAuthRotation && !params.resolvedProviderRotation) {
      return snapshot(config);
    }
    const resolved: OpenClawConfig = {
      ...config,
      ...(params.resolvedProviderRotation ? providerConfig("synthetic-new-provider-key") : {}),
      ...(params.sharedAuthRotation
        ? { gateway: { ...config.gateway, auth: { mode: "token", token: "new-shared-token" } } }
        : {}),
    };
    resolvedConfigs.push(resolved);
    return makePreparedSecretsSnapshot(config, { config: resolved });
  });
  const initialRuntimeConfig: OpenClawConfig = {
    ...initialConfig,
    ...(params.resolvedProviderRotation ? providerConfig("synthetic-old-provider-key") : {}),
    ...(params.sharedAuthRotation
      ? {
          gateway: { ...initialConfig.gateway, auth: { mode: "token", token: "old-shared-token" } },
        }
      : {}),
  };
  if (params.resolvedProviderRotation) {
    hoisted.runtimeConfig.value = initialRuntimeConfig;
  }
  const generation = (token: string | undefined) =>
    resolveSharedGatewaySessionGeneration({ mode: "token", token, allowTailscale: false });
  const sharedState = new SharedGatewaySessionGenerationState({
    current: generation(params.sharedAuthRotation ? "old-shared-token" : undefined),
    required: null,
  });
  const staleClose = vi.fn();
  const currentClose = vi.fn();
  const nonSharedClose = vi.fn();
  const startChannel = vi.fn(async () => new Map());
  const stopChannel = vi.fn(async () => {});
  const setState = vi.fn();
  const reloadPlugins = vi.fn(async () => makePluginReloadResult());
  activateSecretsRuntimeSnapshot(
    makePreparedSecretsSnapshot(initialConfig, { config: initialRuntimeConfig }),
  );
  const reloader = startManagedGatewayConfigReloader({
    initialConfig: initialRuntimeConfig,
    initialCompareConfig: initialConfig,
    startChannel,
    stopChannel,
    setState,
    reloadPlugins,
    sharedGatewaySessionGenerationState: sharedState,
    resolveSharedGatewaySessionGenerationForConfig: (config) =>
      generation(
        typeof config.gateway?.auth?.token === "string" ? config.gateway.auth.token : undefined,
      ),
    clients: params.sharedAuthRotation
      ? [
          {
            usesSharedGatewayAuth: true,
            sharedGatewaySessionGeneration: generation("old-shared-token"),
            socket: { close: staleClose },
          },
          {
            usesSharedGatewayAuth: true,
            sharedGatewaySessionGeneration: generation("new-shared-token"),
            socket: { close: currentClose },
          },
          {
            usesSharedGatewayAuth: false,
            sharedGatewaySessionGeneration: generation("old-shared-token"),
            socket: { close: nonSharedClose },
          },
        ]
      : [],
    getPluginMetadataSnapshot: params.getPluginMetadataSnapshot,
    readSnapshot: vi.fn(async () => createValidConfigSnapshot(configA, "hash-a")),
    subscribeToWrites: captureConfigWriteListener(writeListenerRef, false),
    activateRuntimeSecrets,
    prepareTerminalConfig,
    reconcileRuntimePolicy,
    commitRuntimePolicy,
    acceptTerminalConfig,
    requestRecoveryRestart,
  });
  await reloader.ready;
  writeListenerRef.current?.(
    createConfigWriteNotification(configA, "hash-a", 1, "runtime-a", "source-a"),
  );
  try {
    await accepted;
    return {
      acceptTerminalConfig,
      activateRuntimeSecrets,
      commitRuntimePolicy,
      configA,
      prepareTerminalConfig,
      resolvedConfigs,
      reconcileRuntimePolicy,
      requestRecoveryRestart,
      sharedState,
      expectedGeneration: generation("new-shared-token"),
      staleClose,
      currentClose,
      nonSharedClose,
      startChannel,
      stopChannel,
      setState,
      reloadPlugins,
    };
  } finally {
    await reloader.stop();
  }
}

async function withManagedChannelSecretFixture(
  options: {
    shape?: "named" | "default" | "shared";
    accountScopedRestart?: boolean;
  },
  run: (fixture: {
    initialSource: OpenClawConfig;
    nextSource: (providerPath: string, hot?: boolean) => OpenClawConfig;
    oldPath: string;
    newPath: string;
    missingPath: string;
    starts: Array<{ accountId: string; token: unknown }>;
    stops: string[];
    manager: ReturnType<typeof createChannelManager>;
    write: (config: OpenClawConfig) => Promise<RuntimeConfigWriteApplicationStatus>;
    reloadPlugin: () => Promise<void>;
    failStop: () => void;
    failStart: () => void;
    recoverDuringPreparation: () => void;
    prepareCount: () => number;
    commitRuntimePolicy: ReturnType<typeof vi.fn>;
    requestRecoveryRestart: ReturnType<typeof vi.fn>;
    restartEmitted: Promise<void>;
  }) => Promise<void>,
) {
  const fixtureDir = fs.realpathSync(autoCleanupTempDirs.make("openclaw-channel-secret-reload-"));
  const oldPath = path.join(fixtureDir, "old.json");
  const newPath = path.join(fixtureDir, "next.json");
  const missingPath = path.join(fixtureDir, "missing.json");
  const writeToken = (file: string, token: string) =>
    fs.writeFileSync(file, JSON.stringify({ token }), { mode: 0o600 });
  writeToken(oldPath, "old-channel-token");
  writeToken(newPath, "new-channel-token");
  const ref = { source: "file" as const, provider: "channel", id: "/token" };
  const shape = options.shape ?? "named";
  const initialSource: OpenClawConfig = {
    gateway: { reload: { mode: "hot" } },
    secrets: { providers: { channel: { source: "file", path: oldPath, mode: "json" } } },
    channels: {
      mattermost:
        shape === "shared"
          ? { botToken: ref, accounts: { root: {}, ada: {}, other: { botToken: "independent" } } }
          : shape === "default"
            ? { accounts: { default: { botToken: ref }, ada: { botToken: "independent" } } }
            : { accounts: { root: { botToken: "independent" }, ada: { botToken: ref } } },
    },
  };
  const readChannel = (config: OpenClawConfig) => {
    const channel = config.channels?.mattermost;
    if (!isRecord(channel) || !isRecord(channel.accounts)) {
      throw new Error("Expected channel-account fixture");
    }
    return { channel, accounts: channel.accounts };
  };
  const starts: Array<{ accountId: string; token: unknown }> = [];
  const stops: string[] = [];
  let rejectStop = false;
  let rejectStart = false;
  const plugin: ChannelPlugin<{ accountId: string; botToken: unknown; enabled: boolean }> = {
    ...createChannelTestPluginBase({ id: "mattermost" }),
    reload: {
      configPrefixes: ["channels.mattermost"],
      accountScopedRestart: options.accountScopedRestart ?? true,
    },
    config: {
      listAccountIds: (config) => Object.keys(readChannel(config).accounts),
      resolveAccount: (config, requestedAccountId) => {
        const accountId = requestedAccountId ?? "default";
        const { channel, accounts } = readChannel(config);
        // Teardown can still address a just-removed lifetime.
        const value = accounts[accountId];
        const account = isRecord(value) ? value : {};
        return {
          accountId,
          botToken: account.botToken ?? channel.botToken,
          enabled: channel.enabled !== false && account.enabled !== false,
        };
      },
      isConfigured: (account) => {
        if (rejectStart && account.accountId === "ada") {
          throw new Error("replacement start failed");
        }
        return typeof account.botToken === "string";
      },
    },
    gateway: {
      stopAccount: async () => {
        if (rejectStop) {
          throw new Error("account teardown failed");
        }
      },
      startAccount: async ({ accountId, account, abortSignal }) => {
        starts.push({ accountId, token: account.botToken });
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
          } else {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          }
        });
        stops.push(accountId);
      },
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "mattermost", plugin, source: "test" }]));
  const contract = createSimpleChannelSecretContract({
    channelKey: "mattermost",
    label: "Fixture",
    accountFields: ["botToken"],
    channelFields: ["botToken"],
    mode: "account-inheritance",
  });
  const prepare = async (sourceConfig: OpenClawConfig) => {
    const config = structuredClone(sourceConfig);
    const context = createResolverContext({ sourceConfig, env: {} });
    contract.collectRuntimeConfigAssignments({ config, context });
    const resolution = await resolveAndApplySecretAssignments({
      assignments: context.assignments,
      context,
      options: { config: sourceConfig, env: {}, cache: context.cache },
      allowOwnerIsolation: true,
    });
    return makePreparedSecretsSnapshot(sourceConfig, {
      config,
      warnings: context.warnings,
      degradedOwners: resolution.degradedOwners,
      secretOwners: listSecretAssignmentOwners(context.assignments, resolution.resolvedValues),
    });
  };
  const initialSnapshot = await prepare(initialSource);
  activateSecretsRuntimeSnapshot(initialSnapshot);
  const manager = createChannelManager({
    scheduler: createTestGatewayScheduler(),
    getRuntimeConfig: () => getActiveSecretsRuntimeSnapshot()?.config ?? initialSnapshot.config,
    getPluginRegistry: requireActivePluginChannelRegistry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  await manager.startChannel("mattermost");
  starts.length = 0;
  let recoverNextPreparation = false;
  let preparationCount = 0;
  const activateRuntimeSecrets = createMockRuntimeSecretsActivator(async (config) => {
    preparationCount += 1;
    const snapshot = await prepare(config);
    if (recoverNextPreparation) {
      recoverNextPreparation = false;
      writeToken(missingPath, "old-channel-token");
      activateSecretsRuntimeSnapshot(await prepare(initialSource));
    }
    return snapshot;
  });
  const writeListenerRef = createConfigWriteListenerRef();
  const commitRuntimePolicy = vi.fn();
  const { requestRecoveryRestart, restartEmitted } = createRecoveryRestartMock();
  let currentSource = initialSource;
  let revision = 0;
  // Explicit writes own these snapshots; native startup must not invent a competing revision.
  const watcher = installWatcherMock();
  const reloader = startManagedGatewayConfigReloader({
    initialConfig: initialSnapshot.config,
    initialCompareConfig: initialSource,
    readSnapshot: vi.fn(async () =>
      createValidConfigSnapshot(currentSource, `hash-${revision}`),
    ) as never,
    subscribeToWrites: captureConfigWriteListener(writeListenerRef),
    channelManager: manager,
    startChannel: manager.startChannel,
    stopChannel: manager.stopChannel,
    reloadPlugins: async ({ commitRuntime, prepareConfigEffects }) => {
      prepareConfigEffects({ pluginIds: new Set(["notes"]), channels: new Set() }).retire();
      await commitRuntime();
      return makePluginReloadResult({
        activeChannels: new Set(["mattermost"]),
      });
    },
    activateRuntimeSecrets,
    commitRuntimePolicy,
    requestRecoveryRestart,
  });
  await reloader.ready;
  try {
    await run({
      initialSource,
      nextSource: (providerPath, hot = false) =>
        structuredClone({
          ...initialSource,
          secrets: {
            providers: {
              channel: { source: "file" as const, path: providerPath, mode: "json" as const },
            },
          },
          ...(hot ? { tools: { elevated: { enabled: false } } } : {}),
        }),
      oldPath,
      newPath,
      missingPath,
      starts,
      stops,
      manager,
      reloadPlugin: async () => {
        currentSource = { ...initialSource, plugins: { entries: { notes: { enabled: true } } } };
        await reloader.applyPluginLifecycleChange({
          config: currentSource,
          pluginIds: ["notes"],
          reason: "enable",
        });
      },
      write: async (config) => {
        currentSource = config;
        revision += 1;
        const application = createRuntimeConfigWriteApplication();
        const notification = createConfigWriteNotification(
          config,
          `hash-${revision}`,
          revision,
          `runtime-${revision}`,
          `source-${revision}`,
        );
        if (!writeListenerRef.current) {
          throw new Error("Expected managed config writer");
        }
        writeListenerRef.current(attachRuntimeConfigWriteApplication(notification, application));
        return await application.result;
      },
      failStop: () => {
        rejectStop = true;
      },
      failStart: () => {
        rejectStart = true;
      },
      recoverDuringPreparation: () => {
        recoverNextPreparation = true;
      },
      prepareCount: () => preparationCount,
      commitRuntimePolicy,
      requestRecoveryRestart,
      restartEmitted,
    });
  } finally {
    await reloader.stop();
    watcher.restore();
    rejectStop = false;
    await manager.stopChannel("mattermost");
  }
}

describe("managed channel credential publication", () => {
  it("retains recovery for resolved channel startup failure during a plugin-only write", async () => {
    await withManagedChannelSecretFixture({}, async (fixture) => {
      fs.writeFileSync(fixture.oldPath, JSON.stringify({ token: "rotated-in-place" }));
      fixture.failStart();
      await expect(fixture.reloadPlugin()).rejects.toMatchObject({ details: { committed: true } });
      expect(fixture.commitRuntimePolicy).toHaveBeenCalledOnce();
      expect(fixture.stops).toEqual(["ada"]);
      await fixture.restartEmitted;
      expect(fixture.requestRecoveryRestart).toHaveBeenCalledOnce();
    });
  });

  it.each([
    { mode: "noop", cold: false },
    { mode: "hot", cold: true },
  ] as const)(
    "$mode provider rotation reconciles only Ada (cold=$cold)",
    async ({ mode, cold }) => {
      await withManagedChannelSecretFixture({}, async (fixture) => {
        const next = fixture.nextSource(
          cold ? fixture.missingPath : fixture.newPath,
          mode === "hot",
        );
        expect(await fixture.write(next)).toBe("applied");
        expect(fixture.stops).toEqual(["ada"]);
        expect(fixture.starts).toEqual(
          cold ? [] : [{ accountId: "ada", token: "new-channel-token" }],
        );
        const accounts = fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost;
        expect(accounts?.root?.running).toBe(true);
        expect(accounts?.ada?.running).toBe(!cold);
        expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(next);
        expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
        expect(fixture.commitRuntimePolicy).toHaveBeenCalledOnce();
        if (cold) {
          expect(listActiveDegradedSecretOwners()).toContainEqual(
            expect.objectContaining({ ownerId: "mattermost:ada", degradationState: "cold" }),
          );
          await expect(
            fixture.manager.startChannel("mattermost", "ada", {
              preserveManualStop: true,
              skipUnavailableAccounts: true,
            }),
          ).resolves.toEqual(
            new Map([["ada", { status: "skipped", reason: "secret-unavailable" }]]),
          );
          await expect(
            fixture.manager.startChannel("mattermost", "ada", { manual: true }),
          ).rejects.toMatchObject({
            code: "SECRET_SURFACE_UNAVAILABLE",
            ownerId: "mattermost:ada",
          });
        }
      });
    },
  );

  it("keeps unchanged LKG during an unrelated hot edit", async () => {
    await withManagedChannelSecretFixture({}, async (fixture) => {
      fs.unlinkSync(fixture.oldPath);
      const next = {
        ...fixture.nextSource(fixture.oldPath, true),
        logging: { level: "debug" as const },
      };
      expect(await fixture.write(next)).toBe("applied");
      expect(fixture.stops).toEqual([]);
      expect(fixture.starts).toEqual([]);
      expect(listActiveDegradedSecretOwners()).toContainEqual(
        expect.objectContaining({ ownerId: "mattermost:ada", degradationState: "stale" }),
      );
      expect(fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost?.ada?.running).toBe(
        true,
      );
      expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(fixture.commitRuntimePolicy).toHaveBeenCalledOnce();
    });
  });

  it.each([
    { shape: "named", accountScopedRestart: false, ids: ["ada", "root"], cold: false },
    { shape: "default", accountScopedRestart: true, ids: ["ada", "default"], cold: false },
    { shape: "shared", accountScopedRestart: true, ids: ["ada", "other", "root"], cold: false },
    { shape: "named", accountScopedRestart: false, ids: ["ada", "root"], cold: true },
  ] as const)(
    "preserves whole-channel contract for $shape (opt-in=$accountScopedRestart, cold=$cold)",
    async (entry) => {
      await withManagedChannelSecretFixture(entry, async (fixture) => {
        expect(
          await fixture.write(
            fixture.nextSource(entry.cold ? fixture.missingPath : fixture.newPath),
          ),
        ).toBe("applied");
        expect(fixture.stops.toSorted()).toEqual(entry.ids);
        if (entry.cold) {
          expect(fixture.starts).toEqual([{ accountId: "root", token: "independent" }]);
          expect(
            fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost?.ada?.running,
          ).toBe(false);
        } else {
          expect(fixture.starts.map(({ accountId }) => accountId).toSorted()).toEqual(entry.ids);
        }
        expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
      });
    },
  );

  it("prunes a removed account when its surviving sibling becomes cold", async () => {
    await withManagedChannelSecretFixture({}, async (fixture) => {
      const next = fixture.nextSource(fixture.missingPath);
      const channel = next.channels?.mattermost;
      if (!isRecord(channel) || !isRecord(channel.accounts)) {
        throw new Error("Expected account fixture");
      }
      delete channel.accounts.root;
      expect(await fixture.write(next)).toBe("applied");
      expect(fixture.stops.toSorted()).toEqual(["ada", "root"]);
      expect(fixture.starts).toEqual([]);
      expect(fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost).not.toHaveProperty(
        "root",
      );
      expect(fixture.manager.resolveRuntimeAccountId("mattermost", "root")).toBeUndefined();
      expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
    });
  });

  it.each([
    { cold: true, manualStop: false },
    { cold: true, manualStop: true },
    { cold: false, manualStop: true },
  ])(
    "recovers credentials without undoing manual stops (cold=$cold, manual=$manualStop)",
    async ({ cold, manualStop }) => {
      await withManagedChannelSecretFixture({}, async (fixture) => {
        if (cold) {
          expect(await fixture.write(fixture.nextSource(fixture.missingPath))).toBe("applied");
          expect(
            fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost?.ada?.running,
          ).toBe(false);
        }
        if (manualStop) {
          await fixture.manager.stopChannel("mattermost", "ada");
        }
        fixture.stops.length = 0;
        fixture.starts.length = 0;
        expect(await fixture.write(fixture.nextSource(fixture.newPath))).toBe("applied");
        expect(fixture.stops).toEqual([]);
        expect(fixture.starts).toEqual(
          manualStop ? [] : [{ accountId: "ada", token: "new-channel-token" }],
        );
        expect(fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost?.root?.running).toBe(
          true,
        );
        expect(fixture.manager.isManuallyStopped("mattermost", "ada")).toBe(manualStop);
        expect(listActiveDegradedSecretOwners()).toEqual([]);
        expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
      });
    },
  );

  it("rebuilds targets after a cold preparation loses its snapshot revision", async () => {
    await withManagedChannelSecretFixture({}, async (fixture) => {
      fixture.recoverDuringPreparation();
      expect(await fixture.write(fixture.nextSource(fixture.missingPath))).toBe("applied");
      expect(fixture.prepareCount()).toBe(2);
      expect(fixture.stops).toEqual([]);
      expect(fixture.starts).toEqual([]);
      expect(listActiveDegradedSecretOwners()).toEqual([]);
      expect(fixture.commitRuntimePolicy).toHaveBeenCalledOnce();
    });
  });

  it.each(["stop", "start"] as const)(
    "reports promoted no-op %s failure as recovery-required",
    async (failure) => {
      await withManagedChannelSecretFixture({}, async (fixture) => {
        if (failure === "stop") {
          fixture.failStop();
        } else {
          fixture.failStart();
        }
        const providerPath = failure === "stop" ? fixture.missingPath : fixture.newPath;
        expect(await fixture.write(fixture.nextSource(providerPath))).toBe(
          "applied-restart-required",
        );
        // Restart emission follows asynchronous secret preflight, after the write receipt.
        await fixture.restartEmitted;
        expect(fixture.requestRecoveryRestart).toHaveBeenCalledOnce();
        expect(fixture.commitRuntimePolicy).toHaveBeenCalledOnce();
      });
    },
  );
});

describe("managed reload transaction ownership", () => {
  it("rotates shared auth on a provider-only no-op without replacing services", async () => {
    const result = await runManagedOwnershipScenario({
      kind: "noop",
      secretProviderChanged: true,
      sharedAuthRotation: true,
    });
    expect(result.staleClose).toHaveBeenCalledExactlyOnceWith(4001, "gateway auth changed");
    expect(result.currentClose).not.toHaveBeenCalled();
    expect(result.nonSharedClose).not.toHaveBeenCalled();
    expect({ current: result.sharedState.current, required: result.sharedState.required }).toEqual({
      current: result.expectedGeneration,
      required: null,
    });
    expect(result.startChannel).not.toHaveBeenCalled();
    expect(result.stopChannel).not.toHaveBeenCalled();
    expect(result.reloadPlugins).not.toHaveBeenCalled();
    expect(result.requestRecoveryRestart).not.toHaveBeenCalled();
    expect(result.commitRuntimePolicy).toHaveBeenCalledOnce();
    expect(result.reconcileRuntimePolicy).toHaveBeenCalledOnce();
    const resolved = result.resolvedConfigs.at(-1);
    expect(resolved?.gateway?.auth?.token).toBe("new-shared-token");
    expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledOnce();
    expect(hoisted.refreshPreparedModelRuntimeSnapshots.mock.calls[0]?.[0]).toBe(resolved);
  });

  it("fences resolved provider credentials before committing a channel edit", async () => {
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "slack" }),
      reload: { configPrefixes: ["channels.slack"], noopPrefixes: ["channels.slack.streaming"] },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "slack", plugin, source: "test" }]));
    const pluginMetadataSnapshot = {} as never;
    const result = await runManagedOwnershipScenario({
      kind: "noop",
      secretProviderChanged: false,
      resolvedProviderRotation: "channel",
      getPluginMetadataSnapshot: () => pluginMetadataSnapshot,
    });

    expect(hoisted.markPreparedModelRuntimeSnapshotsStale).toHaveBeenCalledExactlyOnceWith(
      "prepared model runtime owner is stale before config publication",
      { waitForReplacement: true },
    );
    expect(hoisted.markPreparedModelRuntimeSnapshotsStale).toHaveBeenCalledBefore(
      result.commitRuntimePolicy,
    );
    expect(hoisted.advancePreparedModelRuntimeConfig).not.toHaveBeenCalled();
    expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledOnce();
    const [config, options] = hoisted.refreshPreparedModelRuntimeSnapshots.mock.calls[0]!;
    expect(config).toBe(result.resolvedConfigs.at(-1));
    expect(config).not.toBe(result.configA);
    expect(options).toEqual({
      catalogMode: "static",
      joinSupersedingPublication: true,
      allowGatewaySubagentBinding: true,
      pluginMetadataSnapshot,
    });
    expect(config.models?.providers?.fixture?.apiKey).toBe("synthetic-new-provider-key");
    expect(result.prepareTerminalConfig.mock.calls[0]?.[0].changedPaths).toEqual([
      "channels.slack.streaming.mode",
    ]);
    expect(result.startChannel).not.toHaveBeenCalled();
    expect(result.stopChannel).not.toHaveBeenCalled();
    expect(result.reloadPlugins).not.toHaveBeenCalled();
    expect(result.requestRecoveryRestart).not.toHaveBeenCalled();
  });

  it.each(["noop", "hot"] as const)(
    "publishes a current %s config without rebuilding models",
    async (kind) => {
      const result = await runManagedOwnershipScenario({
        kind,
        loggingChanged: kind === "hot",
      });

      expect(hoisted.advancePreparedModelRuntimeConfig).toHaveBeenCalledExactlyOnceWith(
        result.configA,
      );
      expect(hoisted.refreshPreparedModelRuntimeSnapshots).not.toHaveBeenCalled();
      expect(result.activateRuntimeSecrets.prepareSnapshot).toHaveBeenCalledOnce();
      expect(result.commitRuntimePolicy).toHaveBeenCalledOnce();
      expect(result.acceptTerminalConfig).toHaveBeenCalledOnce();
      expect(result.prepareTerminalConfig).toHaveBeenCalledOnce();
      expect(result.reconcileRuntimePolicy).toHaveBeenCalledOnce();
      if (kind === "hot") {
        expect(hoisted.applyLoggingConfig).toHaveBeenCalledExactlyOnceWith({ level: "debug" });
      }
      expect(hoisted.resetSkillSnapshotConfigFingerprintCache).toHaveBeenCalledOnce();
      expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(result.configA);
    },
  );
});

describe("gateway hot reload model state", () => {
  function expectPreparedModelRefresh(config: OpenClawConfig, agentIds?: Set<string>) {
    expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledWith(config, {
      allowGatewaySubagentBinding: true,
      catalogMode: "static",
      joinSupersedingPublication: true,
      ...(agentIds ? { agentIds } : {}),
    });
  }

  it.each([
    {
      name: "removes the normalized authored endpoint",
      providerKey: "ollama",
      nextProviderKey: undefined,
      authoredBaseUrl: "HTTPS://OLLAMA.EXAMPLE:443/v1/",
      cachedBaseUrl: "https://ollama.example/v1",
      removed: true,
    },
    {
      name: "retains a nonmatching local discovery endpoint",
      providerKey: "ollama",
      nextProviderKey: undefined,
      authoredBaseUrl: "https://ollama.example/v1",
      cachedBaseUrl: "http://127.0.0.1:11434",
      removed: false,
    },
    {
      name: "retains discovery when no endpoint was authored",
      providerKey: "ollama",
      nextProviderKey: undefined,
      authoredBaseUrl: undefined,
      cachedBaseUrl: "http://127.0.0.1:11434",
      removed: false,
    },
    {
      name: "removes a provider configured with an uppercase key",
      providerKey: "OLLAMA",
      nextProviderKey: undefined,
      authoredBaseUrl: "https://ollama.example/v1",
      cachedBaseUrl: "https://ollama.example/v1",
      removed: true,
    },
    {
      name: "retains discovery when only provider key spelling changes",
      providerKey: "ollama",
      nextProviderKey: "OLLAMA",
      authoredBaseUrl: "https://ollama.example/v1",
      cachedBaseUrl: "https://ollama.example/v1",
      removed: false,
    },
  ])(
    "$name before refreshing a removed provider without discovery",
    async ({ providerKey, nextProviderKey, authoredBaseUrl, cachedBaseUrl, removed }) => {
      const root = autoCleanupTempDirs.make("openclaw-provider-removal-reload-");
      const agentDirs = [path.join(root, "main"), path.join(root, "secondary")] as const;
      const initialConfig = {
        agents: {
          entries: {
            main: { agentDir: agentDirs[0] },
            secondary: { agentDir: agentDirs[1] },
          },
        },
        models: {
          providers: {
            [providerKey]: {
              ...(authoredBaseUrl ? { baseUrl: authoredBaseUrl } : {}),
              api: "ollama",
              models: [],
            },
          },
        },
      } as OpenClawConfig;
      const nextConfig: OpenClawConfig = {
        agents: initialConfig.agents,
        models: {
          providers: nextProviderKey
            ? { [nextProviderKey]: initialConfig.models!.providers![providerKey]! }
            : {},
        },
      };
      const contents = JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          ollama: {
            baseUrl: cachedBaseUrl,
            api: "ollama",
            models: [{ id: "cached-model", name: "Cached model" }],
          },
        },
      });
      const expected = [
        {
          pluginId: "ollama",
          contents: removed
            ? JSON.stringify({ generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY, providers: {} })
            : contents,
        },
      ];
      try {
        for (const agentId of ["main", "secondary"]) {
          const agentDir = resolveAgentDir(initialConfig, agentId);
          await replacePersistedPluginModelCatalogs({
            agentDir,
            pluginCatalogWrites: { [encodePluginModelCatalogRelativePath("ollama")]: contents },
          });
        }
        const loadedConfig = applyModelDefaults(initialConfig);
        if (!authoredBaseUrl) {
          expect(loadedConfig.models?.providers?.[providerKey]?.baseUrl).toBe(
            "http://127.0.0.1:11434",
          );
        }
        hoisted.runtimeConfig.value = loadedConfig;
        setRuntimeConfigSnapshot(loadedConfig, initialConfig);
        const logReload = { info: vi.fn(), warn: vi.fn() };
        const { applyHotReload, setState } = createReloadHandlersForTest(logReload);
        let catalogsAtRefresh: PersistedPluginModelCatalog[][] = [];
        // A static cache refresh must already see the removal even when discovery is unavailable.
        hoisted.refreshPreparedModelRuntimeSnapshots.mockImplementationOnce(async (config) => {
          expect(config).toBe(nextConfig);
          expect(setState).toHaveBeenCalledOnce();
          catalogsAtRefresh = agentDirs.map((agentDir) =>
            loadPersistedPluginModelCatalogsReadOnly(agentDir),
          );
        });

        const application = await applyHotReload(
          buildGatewayReloadPlan([`models.providers.${providerKey}`]),
          nextConfig,
        );
        expect(logReload.warn.mock.calls).toEqual([]);
        expect(application).toBe("applied");
        expectPreparedModelRefresh(nextConfig);
        expect(catalogsAtRefresh).toEqual(agentDirs.map(() => expected));
        for (const agentDir of agentDirs) {
          expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual(expected);
        }
      } finally {
        await closeOpenClawAgentDatabasesAsync();
      }
    },
  );

  it("keeps a supervised on-exit child alive exactly once across lazy cron reload", ({ signal }) =>
    fixtureLifetime.run(async () => {
      const fixtureDir = autoCleanupTempDirs.make("openclaw-cron-exit-reload-");
      const { markerPath, releasePath, command, childStarted, spawning, spawn } =
        await createSupervisedExitWatcherFixture(fixtureDir);
      const config = {
        // This fixture runs cron without a heartbeat wake handler.
        agents: { defaults: { heartbeat: { every: "0m" } } },
        session: { mainKey: "main", store: path.join(fixtureDir, "sessions.json") },
        cron: { enabled: true, store: path.join(fixtureDir, "jobs.json") },
      } as OpenClawConfig;
      const previousCronFactory = hoisted.buildGatewayCronService.getMockImplementation();
      assert(previousCronFactory, "expected the default cron test factory");
      let state: ReturnType<ReloadHandlerParams["getState"]> | undefined;

      vi.stubEnv("OPENCLAW_STATE_DIR", fixtureDir);
      vi.stubEnv("OPENCLAW_SKIP_CRON", "0");
      hoisted.runtimeConfig.value = config;
      setRuntimeConfigSnapshot(config, config);

      const scheduler = createTestGatewayScheduler("fake-timers");
      try {
        const actualCron =
          await vi.importActual<typeof import("./server-cron.js")>("./server-cron.js");
        hoisted.buildGatewayCronService.mockImplementation(
          (params) =>
            actualCron.buildGatewayCronService(
              params as Parameters<typeof actualCron.buildGatewayCronService>[0],
            ) as unknown as ReturnType<typeof hoisted.buildGatewayCronService>,
        );
        const initialCronState = createLazyGatewayCronState({
          storePath: await resolveCronJobsStorePathFromConfigAsync(config),
          scheduler,
          cfg: config,
          deps: {} as never,
          broadcast: vi.fn(),
        });
        state = {
          ...createDefaultGatewayReloadState(),
          cronState: initialCronState,
        };
        await initialCronState.cron.start();
        const job = await initialCronState.cron.add({
          name: "preserve the real watched child",
          enabled: true,
          schedule: { kind: "on-exit", command },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "watched child finished" },
        });
        await initialCronState.reconcileExitWatchers();
        expect(spawn).toHaveBeenCalledOnce();
        const watchedRun = await withinTest(spawning, signal);
        await withinTest(
          awaitGateBeforeSettlement(
            childStarted,
            watchedRun.wait(),
            "expected the supervised cron exit watcher to start",
          ),
          signal,
        );
        expect(await readFile(markerPath, "utf8")).toBe("run\n");

        const resolveGatewayContext = vi.fn(() => undefined);
        const handlers = createGatewayReloadHandlers({
          scheduler,
          resolveGatewayContext,
          getState: () => {
            if (!state) {
              throw new Error("expected gateway state");
            }
            return state;
          },
          setState: (nextState) => {
            state = nextState;
          },
        });

        await withGatewayRestartSignal(async () => {
          await handlers.applyHotReload(createCronRestartPlan(), config);

          expect(hoisted.buildGatewayCronService).toHaveBeenCalledWith(
            expect.objectContaining({ resolveGatewayContext }),
          );
          expect(watchedRun.activity.resultSettled).toBe(false);
          expect(await readFile(markerPath, "utf8")).toBe("run\n");
          expect(spawn).toHaveBeenCalledOnce();

          await writeFile(releasePath, "release");
          await expect(withinTest(watchedRun.wait(), signal)).resolves.toMatchObject({
            reason: "exit",
            exitCode: 0,
          });
          await waitForFast(
            () => expect(state?.cronState.cron.getJob(job.id)?.enabled).toBe(false),
            {
              timeout: 10_000,
            },
          );
          expect(await readFile(markerPath, "utf8")).toBe("run\n");
          expect(spawn).toHaveBeenCalledOnce();
        });
      } finally {
        await fixtureLifetime.verifyCleanup(async () => {
          hoisted.buildGatewayCronService.mockImplementation(previousCronFactory);
          await writeFile(releasePath, "release").catch(() => {});
          await state?.cronState.cron.stopAndDrain?.();
          await scheduler.stop();
          spawn.mockRestore();
          vi.unstubAllEnvs();
        });
      }
    }));

  it("passes an agent-entry-local refresh scope through the commit and rebuild", async () => {
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createReloadHandlersForTest(logReload);
    const nextConfig = {} as OpenClawConfig;
    setRuntimeConfigSnapshot(nextConfig, nextConfig);

    await applyHotReload(
      buildGatewayReloadPlan(["agents.entries.Alpha.model", "meta.lastTouchedAt"]),
      nextConfig,
    );

    expect(hoisted.markPreparedModelRuntimeSnapshotsStale).toHaveBeenCalledWith(
      "prepared model runtime owner is stale before config publication",
      { waitForReplacement: true, agentIds: new Set(["alpha"]) },
    );
    expectPreparedModelRefresh(nextConfig, new Set(["alpha"]));
  });

  it.each([
    { changedPath: "agents.defaults.compaction.model", modelChanged: true },
    { changedPath: "agents.defaults.compaction.maxActiveTranscriptBytes", modelChanged: false },
  ])(
    "refreshes only changed model inputs without restarting subsystems: $changedPath",
    async ({ changedPath, modelChanged }) => {
      const logReload = { info: vi.fn(), warn: vi.fn() };
      const channels = { start: vi.fn(async () => new Map()), stop: vi.fn(async () => {}) };
      const { applyHotReload, heartbeatRunner, cron } = createReloadHandlersForTest(
        logReload,
        channels,
      );
      const nextConfig = {
        agents: {
          defaults: {
            compaction: {
              ...(modelChanged ? { model: "mock-openai/gpt-5.6-luna-new" } : {}),
              maxActiveTranscriptBytes: "10b",
            },
          },
        },
      } satisfies OpenClawConfig;
      setRuntimeConfigSnapshot({ agents: { defaults: { compaction: {} } } });
      await applyHotReload(buildGatewayReloadPlan([changedPath]), nextConfig);

      if (modelChanged) {
        expect(hoisted.markPreparedModelRuntimeSnapshotsStale).toHaveBeenCalledOnce();
        expectPreparedModelRefresh(nextConfig);
      } else {
        expect(hoisted.markPreparedModelRuntimeSnapshotsStale).not.toHaveBeenCalled();
        expect(hoisted.refreshPreparedModelRuntimeSnapshots).not.toHaveBeenCalled();
        expect(hoisted.advancePreparedModelRuntimeConfig).toHaveBeenCalledExactlyOnceWith(
          nextConfig,
        );
      }
      expect(heartbeatRunner.updateConfig).not.toHaveBeenCalled();
      expect(cron.stop).not.toHaveBeenCalled();
      expect(channels.start).not.toHaveBeenCalled();
      expect(channels.stop).not.toHaveBeenCalled();
      expect(hoisted.reloadSessionMcpRuntimes).not.toHaveBeenCalled();
      expect(logReload.info).toHaveBeenCalledWith(`config hot reload applied (${changedPath})`);
    },
  );

  it.each([
    { phase: "reconcile", losesOwner: "replacement" },
    { phase: "drain", losesOwner: "shutdown" },
    { phase: "drain", losesOwner: "candidate" },
    { phase: "publication", losesOwner: "candidate" },
  ] as const)(
    "preserves cron ownership across $losesOwner during $phase",
    async ({ phase, losesOwner }) => {
      const restartCron = phase !== "publication";
      const started = createDeferred();
      const release = createDeferred();
      const hold = async () => {
        started.resolve();
        await release.promise;
      };
      const oldCron = {
        start: vi.fn(async () => {}),
        stop: vi.fn(),
        stopAndDrain: vi.fn(async () => {
          if (phase === "drain") {
            await hold();
          }
        }),
      };
      const replacement = {
        cron: { start: vi.fn(async () => {}), stop: vi.fn() },
        storePath: "/tmp/rebuilt-cron.json",
        cronEnabled: true,
        reconcileExitWatchers: vi.fn(async () => {}),
        reconcileStreamWatchers: vi.fn(async () => {}),
        stopStreamWatchers: vi.fn(async () => {}),
        reconcileSystemJobs: vi.fn(async () => {
          if (phase === "reconcile") {
            await hold();
            return "superseded";
          }
          return "converged";
        }),
      };
      let state = createDefaultGatewayReloadState({
        cronState: restartCron
          ? createTestCronState({ cron: oldCron as never })
          : createTestCronState({ ...replacement, cron: replacement.cron as never }),
      });
      const handlers = createGatewayReloadHandlers({
        getState: () => state,
        setState: (nextState) => {
          state = nextState;
        },
      });
      if (restartCron) {
        hoisted.buildGatewayCronService.mockReturnValueOnce(replacement);
      }
      let current = true;
      try {
        const reload = handlers.applyHotReload(
          buildGatewayReloadPlan([
            ...(restartCron ? ["cron.enabled"] : []),
            "agents.defaults.heartbeat.every",
          ]),
          { cron: { enabled: true }, agents: { defaults: { heartbeat: { every: "1h" } } } },
          {
            isCurrent: () => current,
            publish: async (commit) => {
              await commit();
              if (phase === "publication") {
                await hold();
              }
            },
            sourceConfig: {},
          },
        );
        await started.promise;
        if (losesOwner === "shutdown") {
          handlers.stopRestartRetries();
        } else if (losesOwner === "candidate") {
          current = false;
        } else {
          state = createDefaultGatewayReloadState();
        }
        release.resolve();
        await reload;
        expect(replacement.cron.start).toHaveBeenCalledTimes(
          restartCron && losesOwner === "candidate" ? 1 : 0,
        );
        expect(oldCron.stopAndDrain).toHaveBeenCalledTimes(restartCron ? 1 : 0);
        if (!restartCron) {
          expect(replacement.reconcileSystemJobs).toHaveBeenCalledTimes(
            losesOwner === "candidate" ? 1 : 0,
          );
        }
      } finally {
        release.resolve();
        handlers.stopRestartRetries();
      }
    },
  );

  it.each(["preparation", "policy"] as const)(
    "drains a replaced cron only after commit when managed %s fails",
    async (failure) => {
      const initialConfig = { cron: { enabled: false } } satisfies OpenClawConfig;
      const nextConfig = { cron: { enabled: true } } satisfies OpenClawConfig;
      activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
      const { requestRecoveryRestart, restartEmitted } = createRecoveryRestartMock();
      const handlers = createReloadHandlersForTest(
        undefined,
        undefined,
        undefined,
        undefined,
        requestRecoveryRestart,
      );
      const managed = createManagedReloadSecretHandlers({
        params: {
          activateRuntimeSecrets: createMockRuntimeSecretsActivator(),
          clients: [],
          sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
            current: undefined,
            required: null,
          }),
          resolveSharedGatewaySessionGenerationForConfig: () => undefined,
          commitRuntimePolicy: vi.fn(),
          reconcileRuntimePolicy: async () => {
            throw new Error("policy reconciliation failed");
          },
        },
        prepareRuntimeCandidate: (config) => config,
        tryPrepareRuntimeSecrets: async (config) => {
          if (failure === "preparation") {
            throw new Error("secrets preparation failed");
          }
          return {
            snapshot: makePreparedSecretsSnapshot(config),
            expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
          };
        },
        applyHotReload: handlers.applyHotReload,
        hasPendingModelRuntimeReload: handlers.hasPendingModelRuntimeReload,
      });
      // This unit scenario injects a stable config owner; lease custody has separate integration proof.
      const ownership: Parameters<typeof managed.onHotReload>[2] = {
        isCurrent: () => true,
        checkpoint: async () => {},
        withRestartPreparation: async (run) => await run(ownership),
        markRuntimeCommitted: vi.fn(),
        publishRuntimeEnv: vi.fn(),
        commitRuntimeEnv: vi.fn(),
        rollbackRuntimeEnv: vi.fn(),
        reapplyRuntimeOverlays: (config) => config,
      };
      try {
        const reload = managed.onHotReload(
          createCronRestartPlan(),
          nextConfig,
          ownership,
          nextConfig,
        );
        if (failure === "preparation") {
          await expect(reload).rejects.toThrow("secrets preparation failed");
        } else {
          await expect(reload).resolves.toBe("applied-restart-required");
          await restartEmitted;
        }
        expect(handlers.cron.stop).toHaveBeenCalledTimes(failure === "policy" ? 1 : 0);
        expect(requestRecoveryRestart).toHaveBeenCalledTimes(failure === "policy" ? 1 : 0);
        expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(
          failure === "policy" ? nextConfig : initialConfig,
        );
      } finally {
        handlers.stopRestartRetries();
      }
    },
  );

  it.each(["rejected", "noop"] as const)(
    "keeps partial monitor writes aligned with accepted config through a %s successor",
    async (successor) => {
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const fixtureDir = autoCleanupTempDirs.make("openclaw-monitor-publication-");
      const initialConfig = {
        agents: {
          entries: {
            first: { heartbeat: { every: "1h" } },
            second: { heartbeat: { every: "1h" } },
          },
        },
      } satisfies OpenClawConfig;
      const nextConfig = {
        ...initialConfig,
        agents: {
          entries: {
            first: { heartbeat: { every: "2h" } },
            second: { heartbeat: { every: "2h" } },
          },
        },
      } satisfies OpenClawConfig;
      activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
      const { buildGatewayCronService } =
        await vi.importActual<typeof import("./server-cron.js")>("./server-cron.js");
      const cronState = buildGatewayCronService({
        storePath: await resolveCronJobsStorePathFromConfigAsync(initialConfig, {
          ...process.env,
          OPENCLAW_STATE_DIR: fixtureDir,
        }),
        scheduler,
        cfg: initialConfig,
        deps: {} as never,
        env: { ...process.env, OPENCLAW_STATE_DIR: fixtureDir, OPENCLAW_SKIP_CRON: "0" },
        broadcast: vi.fn(),
      });
      cronState.cron.pauseScheduling();
      const publicationFailure = createMonitorPublicationFailure();
      let state = createDefaultGatewayReloadState({ cronState });
      const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
      const handlers = createGatewayReloadHandlers({
        getState: () => state,
        setState: (nextState) => {
          state = nextState;
        },
        requestRecoveryRestart,
      });
      const markRuntimeCommitted = vi.fn();
      const ownership: Parameters<typeof managed.onHotReload>[2] = {
        isCurrent: () => true,
        checkpoint: async () => {},
        withRestartPreparation: async (run) => await run(ownership),
        markRuntimeCommitted,
        publishRuntimeEnv: vi.fn(),
        commitRuntimeEnv: vi.fn(),
        rollbackRuntimeEnv: vi.fn(),
        reapplyRuntimeOverlays: (config: OpenClawConfig) => config,
      };
      const managed = createManagedReloadSecretHandlers({
        params: {
          activateRuntimeSecrets: createMockRuntimeSecretsActivator(),
          clients: [],
          sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
            current: undefined,
            required: null,
          }),
          resolveSharedGatewaySessionGenerationForConfig: () => undefined,
          commitRuntimePolicy: vi.fn(),
          reconcileRuntimePolicy: vi.fn(),
        },
        prepareRuntimeCandidate: (config) => config,
        tryPrepareRuntimeSecrets: async (config) => ({
          snapshot: makePreparedSecretsSnapshot(config),
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        }),
        applyHotReload: handlers.applyHotReload,
        hasPendingModelRuntimeReload: handlers.hasPendingModelRuntimeReload,
      });
      const readIntervals = async () =>
        (await loadCronJobsStore(cronState.storePath)).jobs
          .filter((job) => job.payload.kind === "heartbeat")
          .toSorted((left, right) => (left.agentId ?? "").localeCompare(right.agentId ?? ""))
          .map((job) => (job.schedule.kind === "every" ? job.schedule.everyMs : undefined));
      try {
        await expect(cronState.reconcileSystemJobs()).resolves.toBe("converged");
        publicationFailure.install();
        const result = await managed
          .onHotReload(
            buildGatewayReloadPlan(["agents.entries.first.heartbeat.every"]),
            nextConfig,
            ownership,
            nextConfig,
          )
          .catch((error: unknown) => error);
        expect(await readIntervals()).toEqual([7_200_000, 3_600_000]);
        expect(result).toBe("applied-restart-required");
        expect(markRuntimeCommitted).toHaveBeenCalledOnce();
        expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(nextConfig);
        publicationFailure.remove();
        const successorConfig = { ...nextConfig, logging: { level: "debug" as const } };
        if (successor === "rejected") {
          await expect(
            managed.onHotReload(
              buildGatewayReloadPlan(["logging.level"]),
              successorConfig,
              { ...ownership, isCurrent: () => false },
              successorConfig,
            ),
          ).rejects.toThrow("superseded");
        } else {
          await expect(
            managed.onHotReload(
              buildGatewayReloadPlan([]),
              successorConfig,
              ownership,
              successorConfig,
            ),
          ).resolves.toBe("applied");
        }
        await clock.advanceBy(30_000);
        expect(await readIntervals()).toEqual([7_200_000, 7_200_000]);
      } finally {
        try {
          publicationFailure.dispose();
        } finally {
          handlers.stopRestartRetries();
          cronState.cron.stop();
          await scheduler.stop();
        }
      }
    },
  );

  it("rejects an ownerless heartbeat update failure before runtime commit", async () => {
    const publish = vi.fn(async (commit: () => Promise<void>) => await commit());
    const { applyHotReload, heartbeatRunner, setState } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      vi.fn(),
      false,
    );
    heartbeatRunner.updateConfig.mockImplementationOnce(() => {
      throw new Error("heartbeat update failed");
    });
    setCommandLaneConcurrency(CommandLane.Main, 0);
    let queuedTaskStarted = false;
    const queuedTask = enqueueCommandInLane(CommandLane.Main, async () => {
      queuedTaskStarted = true;
    });

    try {
      await expect(
        applyHotReload(
          buildGatewayReloadPlan(["agents.defaults.heartbeat.every"]),
          { agents: { defaults: { maxConcurrent: 1 } } } as OpenClawConfig,
          {
            sourceConfig: { agents: { defaults: { maxConcurrent: 1 } } },
            publish,
            isCurrent: () => true,
          },
        ),
      ).rejects.toThrow("heartbeat update failed");

      expect(publish).toHaveBeenCalledOnce();
      expect(setState).not.toHaveBeenCalled();
      expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(0);
      expect(queuedTaskStarted).toBe(false);
    } finally {
      setCommandLaneConcurrency(CommandLane.Main, 1);
      await queuedTask;
    }
  });

  it.each(["start", "stop"] as const)(
    "restarts instead of rolling back when cron %s fails after commit",
    async (phase) => {
      await withGatewayRestartSignal(async (signalSpy) => {
        const logReload = { info: vi.fn(), warn: vi.fn() };
        const publish = vi.fn(async (commit: () => Promise<void>) => await commit());
        const { applyHotReload, cron, setState } = createReloadHandlersForTest(logReload);
        if (phase === "start") {
          hoisted.buildGatewayCronService.mockReturnValueOnce({
            cron: {
              start: vi.fn(async () => {
                throw new Error("cron start failed");
              }),
              stop: vi.fn(),
            },
            storePath: "/tmp/rebuilt-cron.json",
            cronEnabled: true,
            reconcileExitWatchers: vi.fn(async () => {}),
            reconcileStreamWatchers: vi.fn(async () => {}),
            stopStreamWatchers: vi.fn(async () => {}),
            reconcileSystemJobs: vi.fn(async () => "converged" as const),
          });
        } else {
          cron.stop.mockImplementation(() => {
            throw new Error("cron stop failed");
          });
        }
        await expect(
          applyHotReload(
            createCronRestartPlan(),
            { cron: { enabled: true } },
            { sourceConfig: { cron: { enabled: true } }, publish, isCurrent: () => true },
          ),
        ).resolves.toBe("applied-restart-required");
        expect(publish).toHaveBeenCalledOnce();
        expect(setState).toHaveBeenCalledOnce();
        if (phase === "start") {
          await waitForFast(() => expect(signalSpy).toHaveBeenCalledOnce());
        } else {
          expect(signalSpy).toHaveBeenCalledOnce();
        }
        expect(logReload.warn).toHaveBeenCalledWith(
          `${phase === "start" ? "cron reload" : "runtime commit"} failed after config commit: cron ${phase} failed; restarting gateway`,
        );
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        markGatewayRestartHandled();
      });
    },
  );

  it("ignores a delayed cron failure after a newer reload supersedes it", async () => {
    let rejectFirstStart: ((reason: Error) => void) | undefined;
    const firstCronState = {
      cron: {
        start: vi.fn(
          async () =>
            await new Promise<void>((_resolve, reject) => {
              rejectFirstStart = reject;
            }),
        ),
        stop: vi.fn(),
      },
      storePath: "/tmp/first-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: vi.fn(async () => {}),
      reconcileStreamWatchers: vi.fn(async () => {}),
      stopStreamWatchers: vi.fn(async () => {}),
      reconcileSystemJobs: vi.fn(async () => "converged" as const),
    };
    const secondCronState = {
      cron: { start: vi.fn(async () => {}), stop: vi.fn() },
      storePath: "/tmp/second-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: vi.fn(async () => {}),
      reconcileStreamWatchers: vi.fn(async () => {}),
      stopStreamWatchers: vi.fn(async () => {}),
      reconcileSystemJobs: vi.fn(async () => "converged" as const),
    };
    hoisted.buildGatewayCronService
      .mockReturnValueOnce(firstCronState)
      .mockReturnValueOnce(secondCronState);
    const { applyHotReload, logCron } = createReloadHandlersForTest();

    await withGatewayRestartSignal(async (signalSpy) => {
      await applyHotReload(createCronRestartPlan(), { cron: { enabled: true } });
      await waitForFast(() => expect(firstCronState.cron.start).toHaveBeenCalledOnce());
      await applyHotReload(createCronRestartPlan(), { cron: { enabled: true } });
      rejectFirstStart?.(new Error("superseded start failed"));
      await waitForFast(() =>
        expect(logCron.error).toHaveBeenCalledWith(
          "failed to start: Error: superseded start failed",
        ),
      );
      expect(signalSpy).not.toHaveBeenCalled();
    });
  });

  it("reconciles cached MCP owners on MCP config hot reloads", async () => {
    const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    hoisted.reloadSessionMcpRuntimes.mockRejectedValueOnce(new Error("dispose failed"));
    const { applyHotReload, setState } = createReloadHandlersForTest(
      logReload,
      undefined,
      undefined,
      vi.fn(),
    );
    const nextConfig = { mcp: { servers: {} } } as OpenClawConfig;

    await applyHotReload(
      createHotTailPlan({
        changedPaths: ["mcp.servers.context7.command"],
        hotReasons: ["mcp.servers.context7.command"],
        disposeMcpRuntimes: true,
      }),
      nextConfig,
    );

    expect(hoisted.reloadSessionMcpRuntimes).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledOnce();
    expect(logReload.warn).toHaveBeenCalledWith(
      "bundle-mcp runtime disposal during config reload failed: Error: dispose failed",
    );
  });

  it("rejects an ownerless context cache reload before runtime commit", async () => {
    const { applyHotReload, setState } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      vi.fn(),
      false,
    );

    await expect(
      applyHotReload(
        createHotTailPlan({
          changedPaths: ["agents.defaults.workspace"],
          hotReasons: ["agents.defaults.workspace"],
        }),
        { agents: { defaults: { workspace: "/tmp/next-workspace" } } } as OpenClawConfig,
      ),
    ).rejects.toThrow(
      "config reload requires a managed gateway restart owner for irreversible hot reload",
    );

    expect(setState).not.toHaveBeenCalled();
    expect(hoisted.refreshContextWindowCache).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "adds the agents object",
      previousConfig: {},
      nextConfig: { agents: { defaults: { workspace: "/tmp/next-workspace" } } },
      expectedPath: "agents",
    },
    {
      label: "removes the defaults object",
      previousConfig: { agents: { defaults: { workspace: "/tmp/previous-workspace" } } },
      nextConfig: { agents: {} },
      expectedPath: "agents.defaults",
    },
  ])("refreshes context metadata when a workspace change $label", async (testCase) => {
    const { applyHotReload } = createReloadHandlersForTest();
    const previousConfig = testCase.previousConfig as OpenClawConfig;
    const nextConfig = testCase.nextConfig as OpenClawConfig;
    const changedPaths = diffConfigPaths(previousConfig, nextConfig);
    expect(changedPaths).toEqual([testCase.expectedPath]);

    await applyHotReload(buildGatewayReloadPlan(changedPaths), nextConfig);

    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
  });
});

registerGatewayTargetedServiceReloadTests({
  createGatewayReloadHandlers,
  startManagedGatewayConfigReloader,
});

registerGatewaySupersededReloadTests({
  createGatewayReloadHandlers,
  startManagedGatewayConfigReloader,
  refreshContextWindowCache: hoisted.refreshContextWindowCache,
  refreshPreparedModelRuntimeSnapshots: hoisted.refreshPreparedModelRuntimeSnapshots,
});

describe("gateway hot reload commit policy", () => {
  it("reloads configured workspace hooks when expanding to an explicit multi-agent roster", async () => {
    const root = autoCleanupTempDirs.make("openclaw-hook-roster-reload-");
    const beforeWorkspace = path.join(root, "before");
    const afterWorkspace = path.join(root, "after");
    for (const [workspace, message] of [
      [beforeWorkspace, "before roster expansion"],
      [afterWorkspace, "after roster expansion"],
    ] as const) {
      const hookDir = path.join(workspace, "hooks", "roster-workspace");
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(
        path.join(hookDir, "HOOK.md"),
        [
          "---",
          "name: roster-workspace",
          "description: Configured workspace hook fixture",
          'metadata: {"openclaw":{"events":["command:new"]}}',
          "---",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(hookDir, "handler.js"),
        `export default async function(event) { event.messages.push(${JSON.stringify(message)}); }\n`,
      );
    }
    const beforeConfig: OpenClawConfig = {
      agents: { defaults: { workspace: beforeWorkspace }, entries: { main: {} } },
      hooks: { internal: { enabled: true, entries: { "roster-workspace": { enabled: true } } } },
    };
    const afterConfig: OpenClawConfig = {
      ...beforeConfig,
      agents: {
        ownership: "explicit",
        defaults: { workspace: afterWorkspace },
        entries: { main: {}, worker: {} },
      },
    };
    const { prepareInternalHooks } = await import("../hooks/loader.js");
    const { createInternalHookEvent, triggerInternalHook } =
      await import("../hooks/internal-hooks.js");
    const { applyHotReload } = createReloadHandlersForTest();
    let previousConfig: OpenClawConfig = {};
    try {
      for (const [config, message] of [
        [beforeConfig, "before roster expansion"],
        [afterConfig, "after roster expansion"],
      ] as const) {
        await applyHotReload(
          buildGatewayReloadPlan(
            diffGatewayReloadPaths(previousConfig, config, listConfigReloadRefinementPrefixes()),
            { previousConfig, candidateConfig: config },
          ),
          config,
        );
        const event = createInternalHookEvent("command", "new", "agent:main:main");
        await triggerInternalHook(event);
        expect(event.messages).toEqual([message]);
        previousConfig = config;
      }
    } finally {
      (await prepareInternalHooks({}, afterWorkspace)).commit();
    }
  });

  it("preserves the active hook transform cache across rejected and policy-only reloads", async () => {
    const configDir = autoCleanupTempDirs.make("openclaw-rejected-hook-reload-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const transformPath = path.join(transformsRoot, "reloadable.mjs");
    fs.writeFileSync(transformPath, 'export default () => ({ kind: "wake", text: "accepted" });');
    const activeMappings = [
      {
        id: "reloadable",
        matchPath: "reloadable",
        action: "agent" as const,
        messageTemplate: "unused",
        transform: { modulePath: transformPath },
      },
    ];
    commitHookTransformMappingReload();
    const applyActiveTransform = () =>
      applyHookMappings(activeMappings, {
        payload: {},
        headers: {},
        url: new URL("http://127.0.0.1:18789/hooks/reloadable"),
        path: "reloadable",
      });

    const first = await applyActiveTransform();
    expect(first?.ok).toBe(true);
    const firstAction = first?.ok ? first.actions[0] : undefined;
    if (firstAction?.kind === "wake") {
      expect(firstAction.text).toBe("accepted");
    }

    setGatewayRestartPolicy({ allowExternal: false });
    const { applyHotReload } = createReloadHandlersForTest();

    fs.writeFileSync(transformPath, 'export default () => ({ kind: "wake", text: "candidate" });');
    const nextTime = new Date(Date.now() + 5_000);
    fs.utimesSync(transformPath, nextTime, nextTime);

    await expect(
      applyHotReload(
        {
          changedPaths: ["hooks.token"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["hooks.token"],
          reloadHooks: true,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          reloadPlugins: false,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        { commands: { restart: true }, hooks: { enabled: true } },
      ),
    ).rejects.toThrow("hooks.enabled requires hooks.token");
    expect(isGatewayRestartExternallyAllowed()).toBe(false);

    const afterRejectedReload = await applyActiveTransform();
    expect(afterRejectedReload?.ok).toBe(true);
    const rejectedAction = afterRejectedReload?.ok ? afterRejectedReload.actions[0] : undefined;
    if (rejectedAction?.kind === "wake") {
      expect(rejectedAction.text).toBe("accepted");
    }

    await applyHotReload(
      createHotTailPlan({
        changedPaths: ["agents.entries"],
        hotReasons: ["agents.entries"],
        refreshHooksPolicy: true,
      }),
      {
        agents: { ownership: "explicit", entries: { next: {} } },
        hooks: { enabled: true, token: "hook-secret" },
      },
    );

    const afterPolicyReload = await applyActiveTransform();
    expect(afterPolicyReload?.ok).toBe(true);
    const policyAction = afterPolicyReload?.ok ? afterPolicyReload.actions[0] : undefined;
    if (policyAction?.kind === "wake") {
      expect(policyAction.text).toBe("accepted");
    }
  });
});

describe("gateway restart deferral preflight", () => {
  it("defers a restart emission retry while host suspension is prepared", async () => {
    const { promise: retryEmitted, resolve: recordRetryEmission } = createDeferred();
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockImplementationOnce(() => {
        recordRetryEmission?.();
        return { status: "emitted" };
      });
    const { requestGatewayRestart, stopRestartRetries } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
    vi.useFakeTimers();

    try {
      const initialResult = await runWithGatewayIndependentRootWorkAdmission(async () =>
        requestGatewayRestart(createGatewayRestartPlan(), {}),
      );
      expect(initialResult.status).toBe("recovery-pending");
      suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(1);

      expect(suspension?.release()).toBe(true);
      await retryEmitted;
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
    } finally {
      suspension?.release();
      stopRestartRetries();
    }
  });

  it("retires a rejected preflight after it supersedes committed restart work", async () => {
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValue({ status: "failed" });
    const {
      beginGatewayRestartLifecycle,
      requestGatewayRestart,
      acceptRestartConfig,
      stopRestartRetries,
    } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    const restartPlan = createGatewayRestartPlan() satisfies GatewayReloadPlan;
    vi.useFakeTimers();

    try {
      const rejected = requestGatewayRestart(restartPlan, {});
      rejected.settle("rejected");
      expect(acceptRestartConfig().retireRejectedRestart).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(1);

      const committed = requestGatewayRestart(restartPlan, {});
      committed.settle("committed");
      const rejectedPreflight = beginGatewayRestartLifecycle();
      rejectedPreflight.settle("rejected");
      expect(acceptRestartConfig().retireRejectedRestart).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
    } finally {
      stopRestartRetries();
    }
  });

  it("preserves rejected immediate writer-restart debt across an unrelated accepted config", () => {
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "emitted" });
    const { acceptRestartConfig, requestGatewayRestart, stopRestartRetries } =
      createReloadHandlersForTest(
        undefined,
        undefined,
        undefined,
        undefined,
        requestRecoveryRestart,
      );
    const configA = {
      hooks: { enabled: true, token: "test-token", path: "/a" },
    } as OpenClawConfig;
    const configB = {
      ...configA,
      logging: { level: "debug" },
    } as OpenClawConfig;
    const forcedRestartPlan = {
      changedPaths: ["hooks.path"],
      restartGateway: true,
      restartReasons: ["writer requires restart"],
      hotReasons: ["hooks.path"],
      reloadHooks: true,
      restartGmailWatcher: false,
      restartCron: false,
      restartHeartbeat: false,
      reloadPlugins: false,
      restartChannels: new Set<ChannelKind>(),
      disposeMcpRuntimes: false,
      noopPaths: [],
    } satisfies GatewayReloadPlan;

    try {
      const rejected = requestGatewayRestart(forcedRestartPlan, configA);
      expect(rejected.status).toBe("recovery-pending");
      rejected.settle("rejected");

      const accepted = acceptRestartConfig(configB);
      expect(accepted.debt).toBeDefined();
      if (!accepted.debt) {
        throw new Error("Expected rejected writer restart debt");
      }
      const rearmed = requestGatewayRestart(accepted.debt.plan, configB, {
        retainDebtAcrossConfigChanges: accepted.debt.retainDebtAcrossConfigChanges,
      });
      rearmed.settle("committed");

      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
      expect(requestRecoveryRestart.mock.calls[1]?.[0]).toBe(
        "config reload: writer requires restart",
      );
    } finally {
      stopRestartRetries();
    }
  });

  it("reports restart debt until a replacement config retires it", () => {
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValue({ status: "failed" });
    const handlers = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    const restartPlan = {
      ...createHotTailPlan(),
      changedPaths: ["gateway.port"],
      restartGateway: true,
      restartReasons: ["gateway.port"],
      hotReasons: [],
    } satisfies GatewayReloadPlan;

    try {
      expect(handlers.hasOutstandingGatewayRestart()).toBe(false);
      const restart = handlers.requestGatewayRestart(restartPlan, {
        gateway: { port: 19_001 },
      });
      restart.settle("rejected");
      expect(handlers.hasOutstandingGatewayRestart()).toBe(true);

      expect(handlers.acceptRestartConfig({})).toEqual({ retireRejectedRestart: true });
      expect(handlers.hasOutstandingGatewayRestart()).toBe(false);
    } finally {
      handlers.stopRestartRetries();
    }
  });

  it.each([false, true])(
    "retains hot-recovery debt until the replacement restart emits (%s)",
    async (emits) => {
      const requestRecoveryRestart = vi.fn<
        NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>
      >(() => ({ status: "emitted" }));
      const channels = {
        stop: vi.fn(async () => {}),
        start: vi.fn(async () => {
          hoisted.activeAgentRunCount.value = 1;
          throw new Error("discord restart failed");
        }),
      };
      const {
        acceptRestartConfig,
        applyHotReload,
        beginGatewayRestartLifecycle,
        hasOutstandingGatewayRestart,
        pauseGatewayRestartForConfigCandidate,
        requestGatewayRestart,
        stopRestartRetries,
      } = createReloadHandlersForTest(
        undefined,
        channels,
        undefined,
        undefined,
        requestRecoveryRestart,
      );
      const configA = {
        channels: { discord: { token: "discord-token-a" } },
        logging: { level: "info" },
      } as OpenClawConfig;
      const configC = {
        ...configA,
        logging: { level: "debug" },
      } as OpenClawConfig;
      const configB = {
        ...configA,
        gateway: { port: 19_001 },
      } as OpenClawConfig;
      const plan = createHotTailPlan({
        changedPaths: ["channels.discord.token", "logging.level"],
        hotReasons: ["channels.discord.token"],
        restartChannels: new Set<ChannelKind>(["discord"]),
        noopPaths: ["logging.level"],
      }) satisfies GatewayReloadPlan;
      const configRestartPlan = {
        ...createHotTailPlan(),
        changedPaths: ["gateway.port"],
        restartGateway: true,
        restartReasons: ["gateway.port"],
        hotReasons: [],
      } satisfies GatewayReloadPlan;
      vi.useFakeTimers();

      try {
        await applyHotReload(plan, configA);
        expect(requestRecoveryRestart).not.toHaveBeenCalled();

        pauseGatewayRestartForConfigCandidate();
        const replacementLifecycle = beginGatewayRestartLifecycle();
        const replacement = requestGatewayRestart(configRestartPlan, configB);
        replacement.settle("committed");
        replacementLifecycle.settle("committed");
        expect(requestRecoveryRestart).not.toHaveBeenCalled();

        // Hot C supersedes and retires B's config-owned restart. Recovery A must
        // remain independently debt-eligible until a real restart is accepted.
        if (!emits) {
          pauseGatewayRestartForConfigCandidate();
        }
        hoisted.activeAgentRunCount.value = 0;
        await vi.advanceTimersByTimeAsync(500);
        if (emits) {
          expect(requestRecoveryRestart).toHaveBeenCalledOnce();
          expect(requestRecoveryRestart).toHaveBeenCalledWith(
            "config reload: gateway.port",
            undefined,
          );
          pauseGatewayRestartForConfigCandidate();
          expect(acceptRestartConfig(configA)).toEqual({ retireRejectedRestart: true });
          expect(hasOutstandingGatewayRestart()).toBe(false);
          return;
        }
        expect(requestRecoveryRestart).not.toHaveBeenCalled();

        const accepted = acceptRestartConfig(configC);
        expect(accepted.retireRejectedRestart).toBe(false);
        expect(accepted.debt).toBeDefined();
        if (!accepted.debt) {
          throw new Error("Expected hot-recovery restart debt");
        }
        expect(accepted.debt.plan.restartReasons).toEqual([
          "hot reload recovery: channel restart (discord)",
        ]);
        const rearmed = requestGatewayRestart(accepted.debt.plan, configC, {
          retainDebtAcrossConfigChanges: accepted.debt.retainDebtAcrossConfigChanges,
        });
        rearmed.settle("committed");

        expect(requestRecoveryRestart.mock.calls).toEqual([
          ["config reload: hot reload recovery: channel restart (discord)"],
        ]);
      } finally {
        hoisted.activeAgentRunCount.value = 0;
        stopRestartRetries();
      }
    },
  );

  it("does not schedule post-commit hot recovery after restart handling stops", async () => {
    const { promise: channelStart, resolve: markChannelStart } = createDeferred();
    const { promise: channelStartBlocked, resolve: releaseChannelStart } = createDeferred();
    const requestRecoveryRestart = vi.fn<
      NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>
    >(() => ({ status: "emitted" }));
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload, stopRestartRetries } = createReloadHandlersForTest(
      logReload,
      {
        stop: vi.fn(async () => {}),
        start: vi.fn(async () => {
          markChannelStart?.();
          await channelStartBlocked;
          throw new Error("channel start failed during shutdown");
        }),
      },
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    const plan = {
      ...createHotTailPlan(),
      changedPaths: ["channels.discord.token"],
      hotReasons: ["channels.discord.token"],
      restartChannels: new Set<ChannelKind>(["discord"]),
    } satisfies GatewayReloadPlan;

    const reloadPromise = applyHotReload(plan, {
      channels: { discord: { token: "next-token" } },
    });
    await channelStart;
    stopRestartRetries();
    releaseChannelStart?.();
    await reloadPromise;

    expect(requestRecoveryRestart).not.toHaveBeenCalled();
    expect(logReload.warn).toHaveBeenCalledWith(
      "channel restart (discord) failed during gateway shutdown",
    );
  });

  it("cancels a failed restart retry when a newer restart supersedes it", async () => {
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "emitted" });
    const { requestGatewayRestart, stopRestartRetries } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    vi.useFakeTimers();

    try {
      expect(
        requestGatewayRestart(createGatewayRestartPlan(), { gateway: { port: 18790 } }).status,
      ).toBe("recovery-pending");

      expect(
        requestGatewayRestart(createGatewayRestartPlan("gateway.auth"), {
          gateway: { port: 18791 },
        }).status,
      ).toBe("accepted");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
    } finally {
      stopRestartRetries();
    }
  });

  it("holds root admission across an immediate config-reload restart signal", () => {
    restartTesting.resetRestartSignalState();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR2", signalSpy);
    const { requestGatewayRestart } = createReloadHandlersForTest();

    try {
      expect(requestGatewayRestart(createGatewayRestartPlan(), {}).status).toBe("accepted");

      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();

      markGatewayRestartHandled();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      process.removeListener("SIGUSR2", signalSpy);
      restartTesting.resetRestartSignalState();
      resetGatewayWorkAdmission();
    }
  });

  it("keeps retrying a deferred restart until signal admission succeeds", async () => {
    restartTesting.resetRestartSignalState();
    resetGatewayWorkAdmission();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "emitted" });
    const { requestGatewayRestart, stopRestartRetries } = createReloadHandlersForTest(
      logReload,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    const session = createProcessSessionFixture({
      id: "background-restart-retry",
      command: "private command",
      pid: 12346,
    });
    addSession(session);
    markBackgrounded(session);
    vi.useFakeTimers();

    try {
      expect(requestGatewayRestart(createGatewayRestartPlan(), {}).status).toBe("accepted");

      markExited(session, 0, null, "completed");
      await vi.advanceTimersByTimeAsync(500);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(1);
      expect(logReload.warn).toHaveBeenCalledWith(
        "gateway restart recovery emission failed; retrying",
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(3);
    } finally {
      stopRestartRetries();
      restartTesting.resetRestartSignalState();
      resetGatewayWorkAdmission();
    }
  });

  it("uses the default channel reload deferral timeout when config omits deferralTimeoutMs", async () => {
    const restoreChannelReloadEnv = enableChannelReloadsForTest();
    const startChannel = vi.fn(async () => new Map());
    const stopChannel = vi.fn(async () => {});
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload, getDeferredChannelReloads } = createGatewayReloadHandlers({
      startChannel,
      stopChannel,
      logReload,
    });
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();
    const reloadPromise = applyHotReload(
      createHotTailPlan({
        changedPaths: ["channels.telegram.botToken"],
        hotReasons: ["channels.telegram.botToken"],
        restartChannels: new Set(["telegram"]),
      }),
      {
        channels: { telegram: { botToken: "token" } },
      },
    );
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(299_500);
      expect(stopChannel).not.toHaveBeenCalled();
      expect(startChannel).not.toHaveBeenCalled();
      expect(getDeferredChannelReloads?.()).toEqual([
        { channel: "telegram", publicationPending: true },
      ]);

      await vi.advanceTimersByTimeAsync(500);
      await reloadPromise;
    } finally {
      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500).catch(() => {});
      vi.useRealTimers();
      await reloadPromise.catch(() => {});
      restoreChannelReloadEnv();
    }

    expect(stopChannel).toHaveBeenCalledWith("telegram", undefined, {
      manual: false,
      routeHandoff: true,
    });
    expect(startChannel).toHaveBeenCalledWith("telegram", undefined, {
      reason: "config-reload",
      preserveManualStop: true,
      skipUnavailableAccounts: true,
    });
    expect(logReload.warn).toHaveBeenCalledWith(
      expect.stringContaining("channel reload timeout after"),
    );
    expect(getDeferredChannelReloads?.()).toEqual([]);
  });

  it("reports admitted run blockers before waiting and when forcing after timeout", async () => {
    restartTesting.resetRestartSignalState();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { requestGatewayRestart } = createReloadHandlersForTest(logReload);
    hoisted.activeAgentRunCount.value = 1;
    hoisted.activeEmbeddedRunSessionIds.push("session-issue-82433");
    hoisted.activeEmbeddedRunSessionKeys.push("agent:main:issue-82433");
    const signalSpy = vi.fn();
    process.once("SIGUSR2", signalSpy);
    vi.useFakeTimers();

    try {
      requestGatewayRestart(createGatewayRestartPlan(), {
        gateway: { reload: {} },
      });

      expect(logReload.warn.mock.calls).toEqual(
        expect.arrayContaining([
          [
            "config change requires gateway restart (gateway.port) — deferring until 1 admitted agent run(s) complete",
          ],
        ]),
      );

      await vi.advanceTimersByTimeAsync(300_000);
      await Promise.resolve();

      expect(signalSpy).toHaveBeenCalledTimes(1);
      expect(consumeGatewayRestartIntent()).toEqual({
        force: true,
        waitMs: 300_000,
        reason: "config reload forced restart",
      });
      expect(hoisted.markRestartAbortedMainSessions).not.toHaveBeenCalled();
      expect(logReload.warn.mock.calls).toEqual(
        expect.arrayContaining([
          [
            "config change requires gateway restart (gateway.port) — deferring until 1 admitted agent run(s) complete",
          ],
          [
            "restart timeout after 300000ms with 1 admitted agent run(s) still active; forcing restart",
          ],
        ]),
      );
    } finally {
      hoisted.activeAgentRunCount.value = 0;
      vi.useRealTimers();
      process.removeListener("SIGUSR2", signalSpy);
      restartTesting.resetRestartSignalState();
    }
  });
});

describe("gateway channel hot reload handlers", () => {
  function createChannelReloadPlan(channels: ChannelKind[]): GatewayReloadPlan {
    return createHotTailPlan({
      changedPaths: channels.map((channel) => `channels.${channel}.enabled`),
      hotReasons: ["channels"],
      restartChannels: new Set(channels),
    });
  }

  function createAccountReloadPlan(
    accountIds: string[],
    overrides: Partial<GatewayReloadPlan> = {},
  ): GatewayReloadPlan {
    return {
      ...createChannelReloadPlan([]),
      changedPaths: accountIds.map((accountId) => `channels.discord.accounts.${accountId}`),
      restartChannelAccounts: new Map([["discord", new Set(accountIds)]]),
      ...overrides,
    };
  }

  async function withDiscordAccountResolver(
    listAccountIds: () => string[],
    run: () => Promise<void>,
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => unknown = () => ({}),
  ) {
    const registry = createTestRegistry([
      {
        pluginId: "discord",
        plugin: {
          ...createChannelTestPluginBase({
            id: "discord",
            config: { listAccountIds, resolveAccount },
          }),
        },
        source: "test",
      },
    ]);
    setActivePluginRegistry(registry);
    try {
      await run();
    } finally {
      resetPluginRuntimeStateForTest();
    }
  }

  async function withDiscordAccounts(accountIds: string[], run: () => Promise<void>) {
    await withDiscordAccountResolver(() => accountIds, run);
  }

  it("restarts only the changed account", async () => {
    const events: string[] = [];
    const startRootCounts: number[] = [];
    const accountStopSettled = createDeferred();
    let holdStop = false;
    await withReloadChannelManager(
      [
        {
          ...createChannelTestPluginBase({
            id: "discord",
            config: { listAccountIds: () => ["default", "alpha", "beta"] },
          }),
          gateway: {
            stopAccount: async ({ accountId }) => {
              events.push(`stop:discord:${accountId}`);
              if (holdStop) {
                await accountStopSettled.promise;
              }
            },
            startAccount: async ({ accountId }) => {
              events.push(`start:discord:${accountId}`);
              startRootCounts.push(getActiveGatewayRootWorkCount({ excludeCurrent: true }));
            },
          },
        },
      ],
      async (channels) => {
        await channels.manager.startChannel("discord");
        await waitForFast(() => expect(startRootCounts).toHaveLength(3));
        await channels.manager.stopChannel("discord", "beta");
        events.length = 0;
        startRootCounts.length = 0;
        holdStop = true;
        const { applyHotReload } = createReloadHandlersForTest(undefined, channels);
        const root = tryBeginGatewayRootWorkAdmission();
        expect(root).not.toBeNull();
        let reload: Promise<GatewayHotReloadApplication> | undefined;
        try {
          await root?.run(async () => {
            await withChannelReloadsEnabled(async () => {
              reload = applyHotReload(createAccountReloadPlan(["alpha"]), {});
              await waitForFast(() => expect(events).toEqual(["stop:discord:alpha"]));
              expect(channels.start).not.toHaveBeenCalled();
              accountStopSettled.resolve();
              await reload;
              await waitForFast(() => expect(startRootCounts).toEqual([1]));
            });
          });
        } finally {
          accountStopSettled.resolve();
          await reload?.catch(() => {});
          root?.release();
        }
        expect(events).toEqual(["stop:discord:alpha", "start:discord:alpha"]);
        expect(startRootCounts).toEqual([1]);
        expect(channels.stop).toHaveBeenCalledOnce();
        expect(channels.start).toHaveBeenCalledOnce();
        expect(channels.manager.isManuallyStopped("discord", "beta")).toBe(true);
        expect(channels.manager.getRuntimeSnapshot().channelAccounts.discord).toMatchObject({
          default: { running: true },
          alpha: { running: true },
          beta: { running: false },
        });
      },
    );
  });

  it.each(["unlisted", "unresolvable", "already whole-channel"] as const)(
    "restarts the whole channel once when account targets are %s",
    async (reason) => {
      const events: string[] = [];
      const channels = createRecordedChannelHandlers(events);
      const { applyHotReload, logChannels } = createReloadHandlersForTest(undefined, channels);
      await withChannelReloadsEnabled(async () => {
        await withDiscordAccountResolver(
          () => ["default", "alpha", "beta"],
          async () => {
            await applyHotReload(
              createAccountReloadPlan(
                reason === "unlisted" ? ["removed-account"] : ["alpha", "beta"],
                reason === "already whole-channel" ? { restartChannels: new Set(["discord"]) } : {},
              ),
              {},
            );
          },
          (_cfg, accountId) => {
            if (reason === "unresolvable" && accountId === "beta") {
              throw new Error("account resolution failed");
            }
            return {};
          },
        );
      });
      expect(events).toEqual(["stop:discord:undefined", "start:discord:undefined"]);
      if (reason === "unresolvable") {
        expect(logChannels.info).toHaveBeenCalledWith(
          "promoting discord account reload to whole-channel restart after account resolution failed: account resolution failed",
        );
      }
    },
  );

  it("requests recovery when account enumeration fails after config commit", async () => {
    const channels = {
      stop: vi.fn(async () => {}),
      start: vi.fn(async () => new Map()),
    };
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const { applyHotReload } = createReloadHandlersForTest(
      undefined,
      channels,
      undefined,
      undefined,
      requestRecoveryRestart,
    );

    await withChannelReloadsEnabled(async () => {
      await withDiscordAccountResolver(
        () => {
          throw new Error("account enumeration failed");
        },
        async () => {
          await applyHotReload(createAccountReloadPlan(["alpha"]), {});
        },
      );
    });

    expect(channels.stop).not.toHaveBeenCalled();
    expect(channels.start).not.toHaveBeenCalled();
    expect(requestRecoveryRestart).toHaveBeenCalledOnce();
  });

  it("stops account targets without restarting them while autostart is suppressed", async () => {
    const events: string[] = [];
    const channels = createRecordedChannelHandlers(events);
    const { applyHotReload } = createReloadHandlersForTest(
      undefined,
      channels,
      undefined,
      undefined,
      true,
      {
        getChannelAutostartSuppression: () => ({
          reason: "crash-loop-breaker",
          message: "safe mode",
        }),
      },
    );

    await withChannelReloadsEnabled(async () => {
      await withDiscordAccounts(["default", "alpha"], async () => {
        await applyHotReload(createAccountReloadPlan(["alpha"]), {});
      });
    });

    expect(events).toEqual(["stop:discord:alpha"]);
  });

  it.each([
    {
      name: "stop",
      expectedEvents: ["stop:telegram", "stop:discord", "start:discord"],
    },
    {
      name: "start",
      expectedEvents: ["stop:telegram", "start:telegram", "stop:discord", "start:discord"],
    },
  ])("continues restarting later channels after a hot-reload $name failure", async (testCase) => {
    const events: string[] = [];
    const setState = vi.fn();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const stopChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`stop:${channel}`);
      if (channel === "telegram" && testCase.name === "stop") {
        throw new Error("stop failed");
      }
    });
    const startChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`start:${channel}`);
      if (channel === "telegram" && testCase.name === "start") {
        throw new Error("start failed");
      }
      return new Map();
    });
    await withGatewayRestartSignal(async (signalSpy) => {
      const { applyHotReload } = createGatewayReloadHandlers({
        setState,
        startChannel,
        stopChannel,
        logChannels,
        logReload,
      });
      await withChannelReloadsEnabled(async () => {
        await expect(
          applyHotReload(createChannelReloadPlan(["telegram", "discord"]), {}),
        ).resolves.toBe("applied-restart-required");
      });
      expect(signalSpy).toHaveBeenCalledOnce();
    });

    expect(events).toEqual(testCase.expectedEvents);
    expect(logChannels.error).toHaveBeenCalledWith(
      `failed to restart telegram channel during hot reload: ${testCase.name} failed`,
    );
    expect(setState).toHaveBeenCalledTimes(1);
    expect(logReload.warn).toHaveBeenCalledWith(
      "channel restart (telegram) failed after config commit; restarting gateway",
    );
  });
});

describe("gateway Gmail hot reload handlers", () => {
  function createGmailConfig(account: string): OpenClawConfig {
    return {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", gmail: { account } },
    };
  }

  it("retries managed no-op reloads without publishing superseded secret failures", async () => {
    vi.useFakeTimers();
    const writeListenerRef = createConfigWriteListenerRef();
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {} },
      messages: { visibleReplies: "automatic" },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {} },
      messages: { visibleReplies: "message_tool" },
    };
    const snapshot = (config: OpenClawConfig) => makePreparedSecretsSnapshot(config);
    let preparationAttempt = 0;
    const prepareSnapshot = vi.fn<
      NonNullable<Parameters<typeof createTestRuntimeSecretsActivator>[0]>
    >(async ({ config }) => {
      const attempt = preparationAttempt++;
      if (attempt === 0) {
        activateSecretsRuntimeSnapshot(snapshot(initialConfig));
        throw providerResolutionError({
          source: "env",
          provider: "default",
          message: "superseded secret preparation failure",
        });
      }
      if (attempt === 1) {
        queueMicrotask(() => {
          queueMicrotask(() => activateSecretsRuntimeSnapshot(snapshot(initialConfig)));
        });
      }
      return snapshot(config);
    });
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = createRuntimeSecretsActivator({
      logSecrets: createInfoWarnErrorLogger(),
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: prepareSnapshot,
    });
    const heartbeatRunner = { stop: vi.fn(), updateConfig: vi.fn() };
    const acceptTerminalConfig = vi.fn();
    const commitRuntimePolicy = vi.fn();
    const reloader = startManagedGatewayConfigReloader({
      initialConfig,
      readSnapshot: vi.fn(async () => createValidConfigSnapshot(nextConfig, "hash-next")) as never,
      subscribeToWrites: captureConfigWriteListener(writeListenerRef),
      getState: () =>
        createDefaultGatewayReloadState({
          heartbeatRunner: heartbeatRunner as never,
          cronState: createTestCronState(),
        }),
      activateRuntimeSecrets,
      commitRuntimePolicy,
      acceptTerminalConfig,
    });
    await reloader.ready;
    const registeredWriteListener = writeListenerRef.current;
    assert(registeredWriteListener, "Expected config write listener to be registered");

    try {
      const application = publishConfigWrite(
        registeredWriteListener,
        createConfigWriteNotification(
          nextConfig,
          "hash-next",
          1,
          "runtime-hash-next",
          "source-hash-next",
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await application;

      expect(prepareSnapshot).toHaveBeenCalledTimes(3);
      expect(prepareSnapshot).toHaveBeenCalledWith(expect.objectContaining({ config: nextConfig }));
      expect(emitStateEvent).not.toHaveBeenCalled();
      expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(nextConfig);
      expect(acceptTerminalConfig).toHaveBeenCalledWith({
        retireRejectedRestart: true,
      });
      expect(heartbeatRunner.updateConfig).not.toHaveBeenCalled();
      expect(commitRuntimePolicy).toHaveBeenCalledWith(nextConfig);
    } finally {
      await reloader.stop();
    }
  });

  it("refreshes owner refs when only the resolved source snapshot changes", async () => {
    const authAgentDir = "/tmp/openclaw-source-only-auth-owner";
    const authProfileId = "openai:source-only";
    const authOwnerId = resolveAuthProfileSecretOwnerId({
      agentDir: authAgentDir,
      profileId: authProfileId,
    });
    const firstRef = { source: "env" as const, provider: "default", id: "TTS_FIRST" };
    const secondRef = { source: "env" as const, provider: "default", id: "TTS_SECOND" };
    const thirdRef = { source: "env" as const, provider: "default", id: "TTS_THIRD" };
    const fourthRef = { source: "env" as const, provider: "default", id: "TTS_FOURTH" };
    const sourceConfig = (ref: typeof firstRef): OpenClawConfig => ({
      gateway: { reload: {} },
      tts: { providers: { elevenlabs: { apiKey: ref } } },
    });
    const runtimeConfig: OpenClawConfig = {
      gateway: { reload: {} },
      tts: { providers: { elevenlabs: { apiKey: String(42) } } },
    };
    const ttsContractDigest = "tts-source-only-contract";
    const initialSourceConfig = sourceConfig(firstRef);
    const nextSourceConfig = sourceConfig(secondRef);
    const activeWarning = {
      code: "SECRETS_OWNER_UNAVAILABLE" as const,
      path: "tts.providers.elevenlabs.apiKey",
      message: "Text-to-speech remains unavailable.",
    };
    activateSecretsRuntimeSnapshot(
      makePreparedSecretsSnapshot(initialSourceConfig, {
        config: runtimeConfig,
        authStores: [
          {
            agentDir: authAgentDir,
            store: {
              version: 1,
              profiles: {
                [authProfileId]: {
                  type: "api_key",
                  provider: "openai",
                  key: String(42),
                  keyRef: { source: "env", provider: "default", id: "AUTH_FIRST" },
                },
              },
            },
          },
        ],
        warnings: [activeWarning],
        degradedOwners: [
          {
            ownerKind: "capability",
            ownerId: "tts",
            state: "unavailable",
            paths: ["tts.providers.elevenlabs.apiKey"],
            refKeys: ["env:default:TTS_FIRST"],
            reason: "secret reference was not found",
          },
          {
            ownerKind: "account",
            ownerId: authOwnerId,
            state: "unavailable",
            paths: [`${authAgentDir}.auth-profiles.${authProfileId}.key`],
            refKeys: ["env:default:AUTH_FIRST"],
            reason: "secret provider failed",
          },
        ],
        secretOwners: [
          {
            ownerKind: "capability",
            ownerId: "tts",
            refKeys: ["env:default:TTS_FIRST"],
            contractDigest: ttsContractDigest,
          },
          {
            ownerKind: "account",
            ownerId: authOwnerId,
            refKeys: ["env:default:AUTH_FIRST"],
          },
        ],
      }),
    );
    const writeListenerRef = createConfigWriteListenerRef();
    const activateRuntimeSecrets = createMockRuntimeSecretsActivator(async (config) =>
      makePreparedSecretsSnapshot(config, {
        config: runtimeConfig,
        authStores: [
          {
            agentDir: authAgentDir,
            store: {
              version: 1,
              profiles: {
                [authProfileId]: {
                  type: "api_key" as const,
                  provider: "openai",
                  key: String(42),
                  keyRef: { source: "env" as const, provider: "default", id: "AUTH_SECOND" },
                },
              },
            },
          },
        ],
        secretOwners: [
          {
            ownerKind: "capability" as const,
            ownerId: "tts",
            refKeys: ["env:default:TTS_SECOND"],
            contractDigest: ttsContractDigest,
          },
          {
            ownerKind: "account" as const,
            ownerId: authOwnerId,
            refKeys: ["env:default:AUTH_SECOND"],
          },
        ],
      }),
    );
    let persistedSourceConfig = initialSourceConfig;
    let persistedHash = "initial-source";
    const watcher = installWatcherMock();
    const initialPromoted = createDeferred();
    let supersededSource = createDeferred();
    const reloader = startManagedGatewayConfigReloader({
      initialConfig: runtimeConfig,
      initialCompareConfig: initialSourceConfig,
      readSnapshot: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: JSON.stringify(persistedSourceConfig),
        parsed: persistedSourceConfig,
        sourceConfig: persistedSourceConfig,
        resolved: runtimeConfig,
        valid: true,
        runtimeConfig,
        config: runtimeConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
        hash: persistedHash,
      })) as never,
      subscribeToWrites: captureConfigWriteListener(writeListenerRef),
      prepareConfigCandidate: async ({ runtimeConfig: candidateRuntime }) => ({
        runtimeConfig: candidateRuntime,
        compareConfig: candidateRuntime,
      }),
      activateRuntimeSecrets,
      promoteSnapshot: async (snapshot) => {
        if (snapshot.hash === "initial-source") {
          initialPromoted.resolve();
        }
        return true;
      },
      logReload: {
        info: (message) => {
          if (message.startsWith("config reload superseded:")) {
            supersededSource.resolve();
          }
        },
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
    await reloader.ready;

    try {
      const listener = writeListenerRef.current;
      if (!listener) {
        throw new Error("Expected config write listener to be registered");
      }
      const publishSourceWrite = (notification: ConfigWriteNotification) => {
        persistedSourceConfig = notification.sourceConfig;
        persistedHash = notification.persistedHash;
        return publishConfigWrite(listener, notification);
      };
      expect(watcher.adapter.start).toHaveBeenCalledOnce();
      watcher.emit("change", "/tmp/openclaw.json");
      await initialPromoted.promise;
      expect(activateRuntimeSecrets.prepareSnapshot).not.toHaveBeenCalled();

      const unrelatedSourceConfig = {
        ...initialSourceConfig,
        logging: { level: "info" as const },
      };
      const unrelatedWrite = publishSourceWrite(
        createConfigWriteNotification(
          unrelatedSourceConfig,
          "same-secrets-new-source",
          1,
          "same-runtime",
          "same-secrets-new-source",
          { runtimeConfig },
        ),
      );
      // Flush the write without advancing the database's recurring WAL maintenance.
      await unrelatedWrite;

      expect(activateRuntimeSecrets.prepareSnapshot).not.toHaveBeenCalled();
      expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(unrelatedSourceConfig);
      expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual([activeWarning]);
      expect(getActiveSecretsRuntimeSnapshot()?.secretOwners).toEqual([
        {
          ownerKind: "capability",
          ownerId: "tts",
          refKeys: ["env:default:TTS_FIRST"],
          contractDigest: ttsContractDigest,
        },
        {
          ownerKind: "account",
          ownerId: authOwnerId,
          refKeys: ["env:default:AUTH_FIRST"],
        },
      ]);

      const nextSourceWrite = publishSourceWrite(
        createConfigWriteNotification(
          nextSourceConfig,
          "same-runtime-next-source",
          2,
          "same-runtime",
          "next-source",
          { runtimeConfig },
        ),
      );
      await nextSourceWrite;

      expect(activateRuntimeSecrets.prepareSnapshot.mock.calls[0]?.[0]).toMatchObject({
        includeAuthStoreRefs: true,
      });
      expect(listActiveDegradedSecretOwners()).toEqual([]);
      expect(getActiveSecretsRuntimeSnapshot()?.secretOwners).toEqual([
        {
          ownerKind: "capability",
          ownerId: "tts",
          refKeys: ["env:default:TTS_SECOND"],
          contractDigest: ttsContractDigest,
        },
        {
          ownerKind: "account",
          ownerId: authOwnerId,
          refKeys: ["env:default:AUTH_SECOND"],
        },
      ]);
      expect(
        getActiveSecretsRuntimeSnapshot()?.authStores[0]?.store.profiles[authProfileId],
      ).toMatchObject({
        key: String(42),
        keyRef: { source: "env", provider: "default", id: "AUTH_SECOND" },
      });
      expect(
        classifySecretOwnerDegradationState({
          ownerKind: "capability",
          ownerId: "tts",
          refs: [secondRef],
          config: nextSourceConfig,
          contractDigest: ttsContractDigest,
        }),
      ).toBe("stale");

      activateRuntimeSecrets.prepareSnapshot.mockImplementationOnce(async ({ config }) =>
        makePreparedSecretsSnapshot(config, {
          config: { ...runtimeConfig, logging: { level: "debug" } },
          secretOwners: [
            {
              ownerKind: "capability" as const,
              ownerId: "tts",
              refKeys: ["env:default:TTS_THIRD"],
              contractDigest: ttsContractDigest,
            },
          ],
        }),
      );
      supersededSource = createDeferred();
      const changedResolution = publishSourceWrite(
        createConfigWriteNotification(
          sourceConfig(thirdRef),
          "changed-second-resolution",
          2,
          "same-runtime",
          "changed-second-resolution",
          { runtimeConfig },
        ),
      );
      await supersededSource.promise;

      expect(getActiveSecretsRuntimeSnapshot()?.secretOwners).toEqual([
        {
          ownerKind: "capability",
          ownerId: "tts",
          refKeys: ["env:default:TTS_SECOND"],
          contractDigest: ttsContractDigest,
        },
        {
          ownerKind: "account",
          ownerId: authOwnerId,
          refKeys: ["env:default:AUTH_SECOND"],
        },
      ]);

      const { promise: preparationStarted, resolve: markPreparationStarted } = createDeferred();
      const { promise: preparationGate, resolve: releasePreparation } = createDeferred();
      activateRuntimeSecrets.prepareSnapshot.mockImplementationOnce(async ({ config }) => {
        markPreparationStarted?.();
        await preparationGate;
        return makePreparedSecretsSnapshot(config, {
          config: runtimeConfig,
          secretOwners: [
            {
              ownerKind: "capability" as const,
              ownerId: "tts",
              refKeys: ["env:default:TTS_THIRD"],
              contractDigest: ttsContractDigest,
            },
          ],
        });
      });
      supersededSource = createDeferred();
      const supersededWrite = publishSourceWrite(
        createConfigWriteNotification(
          sourceConfig(thirdRef),
          "superseded-source-owner",
          3,
          "same-runtime",
          "superseded-source-owner",
          { runtimeConfig },
        ),
      );
      await expect(changedResolution).resolves.toBe("superseded");
      await preparationStarted;

      const concurrentSourceConfig = sourceConfig(fourthRef);
      persistedSourceConfig = concurrentSourceConfig;
      persistedHash = "concurrent-source-owner";
      activateSecretsRuntimeSnapshot(
        makePreparedSecretsSnapshot(concurrentSourceConfig, {
          config: runtimeConfig,
          secretOwners: [
            {
              ownerKind: "capability",
              ownerId: "tts",
              refKeys: ["env:default:TTS_FOURTH"],
            },
          ],
        }),
      );
      releasePreparation();
      await supersededSource.promise;

      expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(concurrentSourceConfig);
      expect(getActiveSecretsRuntimeSnapshot()?.secretOwners).toEqual([
        {
          ownerKind: "capability",
          ownerId: "tts",
          refKeys: ["env:default:TTS_FOURTH"],
        },
      ]);
      expect(hoisted.resetSkillSnapshotConfigFingerprintCache).not.toHaveBeenCalled();
      expect(hoisted.applyLoggingConfig).not.toHaveBeenCalled();
      await reloader.stop();
      await expect(supersededWrite).resolves.toBe("stopped");
    } finally {
      await reloader.stop();
      watcher.restore();
    }
  });

  it("rejects ownerless irreversible plans but applies safe hot plans", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: {
        port: 18789,
        reload: {},
        terminal: { enabled: true },
      },
      hooks: {
        enabled: true,
        token: "token-oversized",
        gmail: { account: "old@example.com" },
      },
      logging: { level: "info" },
    };
    const terminalPolicy = createTerminalLaunchPolicy(initialConfig);
    const prepareTerminalConfig = vi.fn((plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => {
      terminalPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
    });
    const reconcileRuntimePolicy = vi.fn();
    const setState = vi.fn();
    const promoted = createDeferred();
    const promoteSnapshot = vi.fn(async () => {
      promoted.resolve();
      return true;
    });
    const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const writeListenerRef = createConfigWriteListenerRef();
    let snapshotConfig = initialConfig;
    let snapshotHash = "initial";
    const activateRuntimeSecrets = createMockRuntimeSecretsActivator();
    const reloader = startManagedGatewayConfigReloader({
      initialConfig,
      readSnapshot: vi.fn(async () =>
        createValidConfigSnapshot(snapshotConfig, snapshotHash),
      ) as never,
      promoteSnapshot: promoteSnapshot as never,
      subscribeToWrites: captureConfigWriteListener(writeListenerRef, false),
      setState,
      logReload,
      activateRuntimeSecrets,
      prepareTerminalConfig,
      reconcileRuntimePolicy,
      commitRuntimePolicy: terminalPolicy.commitConfig,
      acceptTerminalConfig: terminalPolicy.acceptConfig,
      restartRecoveryAvailable: false,
    });
    await reloader.ready;
    let revision = 0;
    const writeConfig = (config: OpenClawConfig, hash: string) => {
      const listener = writeListenerRef.current;
      if (!listener) {
        throw new Error("Expected config write listener to be registered");
      }
      snapshotConfig = config;
      snapshotHash = hash;
      revision += 1;
      return publishConfigWrite(
        listener,
        createConfigWriteNotification(config, hash, revision, `runtime-${hash}`, `source-${hash}`),
      );
    };

    try {
      const rejectedConfigs = [
        {
          label: "restart",
          config: {
            ...initialConfig,
            gateway: { ...initialConfig.gateway, port: 18790, terminal: { enabled: false } },
          },
          surface: "gateway restart",
        },
        {
          label: "plugin",
          config: { ...initialConfig, plugins: { enabled: true } },
          surface: "irreversible hot reload",
        },
        {
          label: "cron",
          config: { ...initialConfig, cron: { enabled: true } },
          surface: "irreversible hot reload",
        },
        {
          label: "gmail",
          config: {
            ...initialConfig,
            hooks: { ...initialConfig.hooks, gmail: { account: "test@example.com" } },
          },
          surface: "irreversible hot reload",
        },
      ] satisfies Array<{ label: string; config: OpenClawConfig; surface: string }>;

      for (const testCase of rejectedConfigs) {
        const application = writeConfig(testCase.config, `${testCase.label}-unsupported`);
        await application;

        expect(prepareTerminalConfig).not.toHaveBeenCalled();
        expect(reconcileRuntimePolicy).not.toHaveBeenCalled();
        expect(activateRuntimeSecrets.prepareSnapshot).not.toHaveBeenCalled();
        expect(setState).not.toHaveBeenCalled();
        expect(promoteSnapshot).not.toHaveBeenCalled();
        expect(logReload.error).toHaveBeenCalledWith(
          expect.stringContaining(
            `config reload requires a managed gateway restart owner for ${testCase.surface}`,
          ),
        );
        expect(terminalPolicy.isEnabled()).toBe(true);
        logReload.error.mockClear();
      }

      const safeConfig: OpenClawConfig = {
        ...initialConfig,
        gateway: { ...initialConfig.gateway, terminal: { enabled: false } },
        logging: { level: "debug" },
      };
      const application = writeConfig(safeConfig, "safe-reload");
      await application;

      await promoted.promise;
      expect(prepareTerminalConfig).toHaveBeenCalledOnce();
      expect(reconcileRuntimePolicy).toHaveBeenCalledOnce();
      expect(promoteSnapshot).toHaveBeenCalledOnce();
      expect(logReload.error).not.toHaveBeenCalled();
      expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(safeConfig);
      expect(terminalPolicy.isEnabled()).toBe(false);
    } finally {
      await reloader.stop();
    }
  });

  it.each([
    { kind: "sandboxed", cronCleanupFails: false },
    { kind: "disabled", cronCleanupFails: true },
  ] as const)(
    "preserves terminals when a failed $kind restriction is replaced (cron cleanup fails: $cronCleanupFails)",
    async ({ kind, cronCleanupFails }) => {
      vi.useFakeTimers();
      const clock = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(clock.clock);
      const initialConfig: OpenClawConfig = {
        gateway: { reload: {}, terminal: { enabled: true } },
      };
      const disabledConfig: OpenClawConfig = {
        gateway: { reload: {}, terminal: { enabled: false } },
      };
      const rejectedConfig: OpenClawConfig =
        kind === "disabled"
          ? disabledConfig
          : {
              ...initialConfig,
              agents: { defaults: { sandbox: { mode: "all" } } },
            };
      const policy = createTerminalLaunchPolicy(initialConfig);
      const livePty = makeFakePty();
      const pendingPty = makeFakePty();
      const spawnStarted = createDeferred();
      const releaseSpawn = createDeferred();
      const manager = new TerminalSessionManager({
        emit: vi.fn(),
        spawn: async ({ cwd }) => {
          if (cwd === "/pending") {
            spawnStarted.resolve();
            await releaseSpawn.promise;
            return pendingPty;
          }
          return livePty;
        },
      });
      expectTerminalOpen(await manager.open(baseOpenRequest()));
      const pending = manager.open(
        baseOpenRequest({ owner: { kind: "conn", connId: "conn-2" }, cwd: "/pending" }),
      );
      await spawnStarted.promise;
      activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
      const writer = createDirectConfigWriteFixture(initialConfig);
      const writeListenerRef = writer.ref;
      const stopAndDrain = vi.fn(async () => {
        throw new Error("cron cleanup failed after publication");
      });
      let state: Parameters<ReloadHandlerParams["setState"]>[0] = createDefaultGatewayReloadState();
      state.cronState.cron.stopAndDrain = stopAndDrain;
      const setState = vi
        .fn((nextState: typeof state) => {
          state = nextState;
        })
        .mockImplementationOnce(() => {
          throw new Error("runtime publication refused");
        });
      const { requestRecoveryRestart, restartEmitted } = createRecoveryRestartMock();
      const reloader = startManagedGatewayConfigReloader({
        scheduler,
        initialConfig,
        readSnapshot: writer.readSnapshot,
        subscribeToWrites: writer.subscribeToWrites,
        getState: () => state,
        setState,
        prepareTerminalConfig: (plan, config) =>
          policy.prepareConfig(config, { restartPending: plan.restartGateway }),
        reconcileRuntimePolicy: () =>
          manager.closeDisallowedAgents((agentId) => policy.resolve(agentId).ok),
        commitRuntimePolicy: policy.commitConfig,
        acceptTerminalConfig: policy.acceptConfig,
        requestRecoveryRestart,
      });
      await reloader.ready;
      const writeConfig = (config: OpenClawConfig, revision: number) => {
        const application = createRuntimeConfigWriteApplication();
        if (!writeListenerRef.current) {
          throw new Error("Expected managed config writer");
        }
        writeListenerRef.current(
          attachRuntimeConfigWriteApplication(
            createConfigWriteNotification(
              config,
              `terminal-disable-${revision}`,
              revision,
              `runtime-${revision}`,
              `source-${revision}`,
            ),
            application,
          ),
        );
        return application.result;
      };

      try {
        const rejected = writeConfig(rejectedConfig, 1);
        await clock.wake();
        await expect(rejected).resolves.toBe("failed");
        expect(policy.resolve()).toMatchObject({ ok: false, block: { kind } });
        expect(livePty.killed).toBe(false);
        expect(manager.size).toBe(1);
        // This spawn was admitted before the candidate; failed publication must
        // not abort it through irreversible session cleanup.
        releaseSpawn.resolve();
        expectTerminalOpen(await pending);
        expect(pendingPty.killed).toBe(false);
        expect(manager.size).toBe(2);

        const recovered = writeConfig(
          {
            gateway: { ...initialConfig.gateway, terminal: { enabled: true, shell: "/bin/bash" } },
          },
          2,
        );
        await clock.wake();
        await expect(recovered).resolves.toBe("applied");
        expect(livePty.killed).toBe(false);
        expect(pendingPty.killed).toBe(false);
        expect(manager.size).toBe(2);
        expect(policy.resolve().ok).toBe(true);

        const accepted = writeConfig(
          { ...disabledConfig, ...(cronCleanupFails ? { cron: { enabled: true } } : {}) },
          3,
        );
        await clock.wake();
        await expect(accepted).resolves.toBe(
          cronCleanupFails ? "applied-restart-required" : "applied",
        );
        expect(livePty.killed).toBe(true);
        expect(pendingPty.killed).toBe(true);
        expect(manager.size).toBe(0);
        expect(policy.isEnabled()).toBe(false);
        expect(stopAndDrain).toHaveBeenCalledTimes(cronCleanupFails ? 1 : 0);
        if (cronCleanupFails) {
          // Drive the idle poll without tying fake-clock progress to real polling ticks.
          await vi.advanceTimersByTimeAsync(500);
          await restartEmitted;
        }
        expect(requestRecoveryRestart).toHaveBeenCalledTimes(cronCleanupFails ? 1 : 0);
      } finally {
        releaseSpawn.resolve();
        await pending;
        manager.disposeAll();
        await reloader.stop();
        await scheduler.stop();
      }
    },
  );

  it("retires terminal restrictions after restart secrets preflight rejects and config reverts", async () => {
    vi.useFakeTimers();
    const { clock, scheduler } = createConfigReloadTestClock();
    const initialConfig = {
      gateway: {
        port: 18789,
        reload: {},
        terminal: { enabled: true },
      },
    } as OpenClawConfig;
    const rejectedConfig = {
      gateway: {
        port: 18790,
        reload: {},
        terminal: { enabled: false },
      },
    } as OpenClawConfig;
    const writer = createDirectConfigWriteFixture(initialConfig);
    const writeListenerRef = writer.ref;
    const terminalPolicy = createTerminalLaunchPolicy(initialConfig);
    const expectedReloadError = "config reload failed: Error: restart secrets preflight failed";
    const { promise: reloadFailed, resolve: recordReloadFailure } = createDeferred();
    const { promise: restartRetired, resolve: recordRestartRetired } = createDeferred();
    const logReload = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((message: string) => {
        if (message === expectedReloadError) {
          recordReloadFailure?.();
        }
      }),
    };
    const acceptTerminalConfig = (options: { retireRejectedRestart: boolean }) => {
      terminalPolicy.acceptConfig(options);
      if (options.retireRejectedRestart) {
        recordRestartRetired?.();
      }
    };
    const activateRuntimeSecrets = createMockRuntimeSecretsActivator(async (config) => {
      if (config.gateway?.port === rejectedConfig.gateway?.port) {
        throw new Error("restart secrets preflight failed");
      }
      return makePreparedSecretsSnapshot(config);
    });
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
    const reloader = startManagedGatewayConfigReloader({
      scheduler,
      initialConfig,
      readSnapshot: writer.readSnapshot,
      subscribeToWrites: writer.subscribeToWrites,
      logReload,
      activateRuntimeSecrets,
      prepareTerminalConfig: (plan, nextConfig) => {
        terminalPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
      },
      commitRuntimePolicy: terminalPolicy.commitConfig,
      acceptTerminalConfig,
      requestRecoveryRestart,
    });
    await reloader.ready;
    const registeredWriteListener = writeListenerRef.current;
    assert(registeredWriteListener, "Expected config write listener to be registered");

    try {
      registeredWriteListener(
        createConfigWriteNotification(
          rejectedConfig,
          "rejected-restart",
          1,
          "runtime-rejected-restart",
          "source-rejected-restart",
        ),
      );
      await clock.wake();
      await reloadFailed;

      expect(terminalPolicy.isEnabled()).toBe(false);
      expect(logReload.error).toHaveBeenCalledWith(expectedReloadError);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();

      registeredWriteListener(
        createConfigWriteNotification(
          initialConfig,
          "accepted-revert",
          2,
          "runtime-accepted-revert",
          "source-accepted-revert",
        ),
      );
      await clock.wake();
      await restartRetired;

      expect(terminalPolicy.isEnabled()).toBe(true);
    } finally {
      await reloader.stop();
    }
  });

  it("does not emit a restart after shared-generation ownership rejects the candidate", async () => {
    const harness = await createManagedRestartSequenceHarness({
      invalidateGenerationOnReconcile: true,
    });

    try {
      const reloadError = harness.nextReloadError();
      harness.writeConfig(harness.deferredConfig, "stale-generation-restart", 1);

      await expect(reloadError).resolves.toBe(
        "config restart failed: GatewayHotReloadStaleSecretsError: runtime secrets changed while config hot reload was deferred",
      );
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
      expect({
        current: harness.sharedGatewaySessionGenerationState.current,
        required: harness.sharedGatewaySessionGenerationState.required,
      }).toEqual({
        current: "concurrent-generation",
        required: null,
      });
    } finally {
      await harness.reloader.stop();
    }
  });

  it("cancels a deferred restart when a newer config fails required SecretRef preflight", async () => {
    vi.useFakeTimers();
    const { clock, scheduler } = createConfigReloadTestClock();
    const harness = await createManagedRestartSequenceHarness({ scheduler });
    hoisted.activeAgentRunCount.value = 1;

    try {
      const deferredPromotion = harness.nextPromotion();
      harness.writeConfig(harness.deferredConfig, "deferred-a", 1);
      await clock.wake();
      await expect(deferredPromotion).resolves.toBe("deferred-a");
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(harness.reloader.isConfigReloadSettled()).toBe(false);

      const reloadError = harness.nextReloadError();
      harness.writeConfig(harness.invalidConfig, "invalid-b", 2);
      await clock.wake();
      await expect(reloadError).resolves.toBe(
        "config restart failed: Error: required SecretRef MISSING_RESTART_TOKEN is unavailable",
      );

      expect(harness.activateRuntimeSecrets.prepareSnapshot.mock.calls[0]?.[0].config).toEqual(
        harness.deferredConfig,
      );
      expect(harness.activateRuntimeSecrets.prepareSnapshot.mock.calls[1]?.[0].config).toEqual(
        harness.invalidConfig,
      );
      expect(harness.terminalPolicy.isEnabled()).toBe(false);
      expect(harness.promoteSnapshot.mock.calls.map(([snapshot]) => snapshot.hash)).not.toContain(
        "invalid-b",
      );

      hoisted.activeAgentRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(harness.reloader.isConfigReloadSettled()).toBe(false);

      const acceptedWithLogging = {
        ...harness.deferredConfig,
        logging: { level: "debug" },
      } as OpenClawConfig;
      const revertPromotion = harness.nextPromotion();
      harness.writeConfig(acceptedWithLogging, "accepted-a-plus-logging", 3);
      await clock.wake();
      await expect(revertPromotion).resolves.toBe("accepted-a-plus-logging");
      await clock.wake();
      expect(harness.reloader.isConfigReloadSettled()).toBe(false);
      expect(harness.terminalPolicy.isEnabled()).toBe(false);
      expect(harness.activateRuntimeSecrets.prepareSnapshot.mock.calls[2]?.[0].config).toEqual(
        acceptedWithLogging,
      );
      expect(harness.activateRuntimeSecrets.prepareSnapshot.mock.calls[3]?.[0].config).toEqual(
        acceptedWithLogging,
      );
      await vi.advanceTimersByTimeAsync(500);
      await harness.restartEmitted;
      expect(harness.requestRecoveryRestart.mock.calls).toEqual([
        ["config reload: gateway.port, gateway.auth.mode", undefined],
      ]);
    } finally {
      hoisted.activeAgentRunCount.value = 0;
      await harness.reloader.stop();
    }
  });

  it("keeps unchanged config unsettled until metadata hot replacement completes", async () => {
    vi.useFakeTimers();
    const watcher = installWatcherMock();
    const config: OpenClawConfig = { gateway: { reload: {} } };
    const started = createDeferred();
    const release = createDeferred();
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const reloadPlugins = vi.fn<ReloadHandlerParams["reloadPlugins"]>(async (params) => {
      started.resolve();
      await release.promise;
      await params.commitRuntime();
      return makePluginReloadResult({
        runtime: {
          operationId: params.pluginLifecycle!.operationId,
          generation: 2,
          pluginIds: [],
        },
      });
    });
    const reloader = startManagedGatewayConfigReloader({
      initialConfig: config,
      readSnapshot: vi.fn(async () => createValidConfigSnapshot(config, "same")),
      subscribeToWrites: captureConfigWriteListener(createConfigWriteListenerRef()),
      reloadPlugins,
      requestRecoveryRestart,
    });
    await reloader.ready;
    try {
      expect(reloader.isConfigReloadSettled()).toBe(true);
      const application = reloader.applyPluginLifecycleChange({
        config,
        pluginIds: [],
        reason: "metadata",
      });
      expect(reloader.isConfigReloadSettled()).toBe(false);
      await started.promise;
      expect(reloader.isConfigReloadSettled()).toBe(false);
      release.resolve();
      await application;
      expect(reloader.isConfigReloadSettled()).toBe(true);
      expect(reloadPlugins).toHaveBeenCalledOnce();
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      watcher.emit("change", "/tmp/openclaw.json");
      await vi.advanceTimersByTimeAsync(300);
      await waitForFast(() => expect(reloader.isConfigReloadSettled()).toBe(true));
      expect(reloadPlugins).toHaveBeenCalledOnce();
      expect(reloader.isConfigReloadSettled()).toBe(true);
    } finally {
      release.resolve();
      await reloader.stop();
      watcher.restore();
    }
  });

  it("stops managed config reload while its Gateway admission is suspended", async () => {
    vi.useFakeTimers();
    const harness = await createManagedRestartSequenceHarness();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    let stopping: Promise<void> | undefined;
    try {
      harness.writeConfig(harness.deferredConfig, "suspended-restart", 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(harness.activateRuntimeSecrets.prepareSnapshot).not.toHaveBeenCalled();
      let stopped = false;
      stopping = harness.reloader.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      await stopping;
      expect(stopped).toBe(true);

      suspension?.rollback();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.activateRuntimeSecrets.prepareSnapshot).not.toHaveBeenCalled();
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(harness.promoteSnapshot).not.toHaveBeenCalled();
      expect(harness.reloader.isConfigReloadSettled()).toBe(false);
      expect(harness.logReload.error).not.toHaveBeenCalled();
    } finally {
      suspension?.rollback();
      await (stopping ?? harness.reloader.stop());
    }
  });

  it.each(["completion", "AbortError"] as const)(
    "joins admitted config restart %s after managed shutdown starts",
    async (outcome) => {
      vi.useFakeTimers();
      const harness = await createManagedRestartSequenceHarness();
      const { promise: preflightStarted, resolve: markPreflightStarted } = createDeferred();
      const { promise: preflightBlocked, resolve: releasePreflight } = createDeferred();
      harness.activateRuntimeSecrets.prepareSnapshot.mockImplementationOnce(async ({ config }) => {
        markPreflightStarted?.();
        await preflightBlocked;
        if (outcome === "AbortError") {
          const error = new Error("admitted secret read aborted");
          error.name = "AbortError";
          throw error;
        }
        return makePreparedSecretsSnapshot(config);
      });

      try {
        expect(harness.reloader.isConfigReloadSettled()).toBe(true);
        harness.writeConfig(harness.deferredConfig, "shutdown-restart", 1);
        expect(harness.reloader.isConfigReloadSettled()).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        await preflightStarted;
        expect(harness.reloader.isConfigReloadSettled()).toBe(false);

        let stopped = false;
        const stopPromise = harness.reloader.stop().then(() => {
          stopped = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        expect(harness.reloader.isConfigReloadSettled()).toBe(false);
        releasePreflight?.();
        await stopPromise;
        expect(harness.reloader.isConfigReloadSettled()).toBe(false);

        expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
        expect(harness.promoteSnapshot).not.toHaveBeenCalled();
        if (outcome === "AbortError") {
          expect(harness.logReload.error).toHaveBeenCalledWith(
            "config restart failed: AbortError: admitted secret read aborted",
          );
        }
      } finally {
        releasePreflight?.();
        await harness.reloader.stop();
      }
    },
  );

  it("pauses deferred restart A before external hot config B fails SecretRef preflight", async () => {
    vi.useFakeTimers();
    const { clock, scheduler } = createConfigReloadTestClock();
    const harness = await createManagedRestartSequenceHarness({ scheduler });
    const invalidConfig = harness.invalidHotConfig;
    const invalidPlan = buildGatewayReloadPlan(
      diffConfigPaths(harness.deferredConfig, invalidConfig),
    );
    expect(invalidPlan.restartGateway).toBe(false);
    hoisted.activeAgentRunCount.value = 1;

    try {
      const deferredPromotion = harness.nextPromotion();
      harness.writeConfig(harness.deferredConfig, "deferred-hot-noop-a", 1);
      await clock.wake();
      await deferredPromotion;

      const reloadError = harness.nextReloadError();
      harness.writeConfig(invalidConfig, "invalid-hot-b", 2);
      await clock.wake();
      await expect(reloadError).resolves.toBe(
        "config reload failed: Error: required SecretRef MISSING_HOT_TOKEN is unavailable",
      );

      hoisted.activeAgentRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();

      const acceptedConfig = {
        ...harness.deferredConfig,
        logging: { level: "debug" },
      } as OpenClawConfig;
      const acceptedPromotion = harness.nextPromotion();
      harness.writeConfig(acceptedConfig, "accepted-after-hot", 3);
      await clock.wake();
      await acceptedPromotion;
      await vi.advanceTimersByTimeAsync(500);
      await harness.restartEmitted;

      expect(harness.requestRecoveryRestart).toHaveBeenCalledOnce();
    } finally {
      hoisted.activeAgentRunCount.value = 0;
      await harness.reloader.stop();
    }
  });

  it("revalidates canonical SecretRefs instead of trusting direct-write runtime literals", async () => {
    vi.useFakeTimers();
    const harness = await createManagedRestartSequenceHarness();
    const resolvedRuntimeConfig = {
      ...harness.deferredConfig,
      logging: { level: "info" },
      gateway: {
        ...harness.deferredConfig.gateway,
        auth: { mode: "token" as const, token: "resolved-restart-token" },
      },
    } as OpenClawConfig;
    harness.setSecretUnavailable("RESTART_A_TOKEN");

    try {
      const reloadError = harness.nextReloadError();
      harness.writeConfig(
        harness.deferredConfig,
        "direct-runtime-literal",
        1,
        resolvedRuntimeConfig,
      );
      await vi.advanceTimersByTimeAsync(0);

      await expect(reloadError).resolves.toBe(
        "config restart failed: Error: required SecretRef RESTART_A_TOKEN is unavailable",
      );
      expect(harness.activateRuntimeSecrets.prepareSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {
            ...resolvedRuntimeConfig,
            gateway: harness.deferredConfig.gateway,
          },
        }),
      );
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
    } finally {
      await harness.reloader.stop();
    }
  });

  it.each(["absent", "during acceptance"])(
    "revalidates restart secrets after held promotion and before emission retries (watcher readiness: %s)",
    async (readiness) => {
      vi.useFakeTimers();
      const harness = await createManagedRestartSequenceHarness();
      if (readiness === "during acceptance") {
        harness.acceptTerminalConfig.mockImplementationOnce((acceptance) => {
          harness.terminalPolicy.acceptConfig(acceptance);
          // The accepted restart target exists, but its config audit write has not settled.
          harness.watcher.emit("ready");
        });
      }
      const leaseClock = createPluginLifecycleLeaseTestClock();
      const promotionGate = createDeferred();
      const promote = harness.promoteSnapshot.getMockImplementation();
      assert.isDefined(promote);
      harness.promoteSnapshot.mockImplementationOnce(async (...args) => {
        const accepted = await promote(...args);
        await promotionGate.promise;
        return accepted;
      });
      hoisted.activeAgentRunCount.value = 1;

      try {
        const promotion = harness.nextPromotion();
        harness.writeConfig(harness.deferredConfig, "deferred-emission-preflight", 1);
        await vi.advanceTimersByTimeAsync(0);
        await leaseClock.waitFor(promotion);

        harness.setSecretUnavailable("RESTART_A_TOKEN");
        expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
        hoisted.activeAgentRunCount.value = 0;
        await vi.advanceTimersByTimeAsync(500);
        expect(harness.assertRestartReady).not.toHaveBeenCalled();
        expect(harness.logReload.warn).not.toHaveBeenCalledWith(
          "gateway restart recovery emission failed; retrying",
        );
        expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
        hoisted.activeAgentRunCount.value = 1;
        promotionGate.resolve();
        // Restart preparation reacquires the outer plugin lease after reload root admission ends.
        await leaseClock.waitForFirstLease();
        expect(harness.assertRestartReady).not.toHaveBeenCalled();
        hoisted.activeAgentRunCount.value = 0;
        const retryScheduled = harness.nextReloadWarning(
          "gateway restart recovery emission failed; retrying",
        );
        await vi.advanceTimersByTimeAsync(500);
        await leaseClock.waitFor(retryScheduled);
        expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
        expect(harness.assertRestartReady).toHaveBeenCalledOnce();
        expect(harness.logReload.warn).toHaveBeenCalledWith(
          expect.stringContaining("gateway restart preflight failed"),
        );

        harness.setSecretAvailable("RESTART_A_TOKEN");
        await vi.advanceTimersByTimeAsync(1_000);
        await leaseClock.waitFor(harness.restartEmitted);
        expect(harness.requestRecoveryRestart).toHaveBeenCalledOnce();
        expect(harness.assertRestartReady).toHaveBeenCalledTimes(2);
        expect(harness.activateRuntimeSecrets.prepareSnapshot).toHaveBeenCalledTimes(3);
      } finally {
        promotionGate.resolve();
        hoisted.activeAgentRunCount.value = 0;
        await harness.reloader.stop();
      }
    },
  );

  it("supersedes a blocked emission preflight without marking sessions or signaling", async () => {
    vi.useFakeTimers();
    const { clock, scheduler } = createConfigReloadTestClock();
    const harness = await createManagedRestartSequenceHarness({ scheduler });
    const leaseClock = createPluginLifecycleLeaseTestClock();
    const { promise: emissionPreflightStarted, resolve: recordEmissionPreflightStarted } =
      createDeferred();
    const { promise: emissionPreflightGate, resolve: releaseEmissionPreflight } = createDeferred();
    const originalActivateRuntimeSecrets =
      harness.activateRuntimeSecrets.prepareSnapshot.getMockImplementation();
    if (!originalActivateRuntimeSecrets) {
      throw new Error("Expected managed secrets activation implementation");
    }
    let restartCheckCount = 0;
    harness.activateRuntimeSecrets.prepareSnapshot.mockImplementation(async (...args) => {
      if (++restartCheckCount === 2) {
        recordEmissionPreflightStarted?.();
        await emissionPreflightGate;
      }
      return await originalActivateRuntimeSecrets(...args);
    });
    hoisted.activeAgentRunCount.value = 1;

    try {
      const deferredPromotion = harness.nextPromotion();
      harness.writeConfig(harness.deferredConfig, "deferred-a", 1);
      const deferredAdvance = clock.wake();
      await expect(deferredPromotion).resolves.toBe("deferred-a");
      await deferredAdvance;

      hoisted.activeAgentRunCount.value = 0;
      const emissionAdvance = vi.advanceTimersByTimeAsync(500);
      await emissionPreflightStarted;

      harness.writeConfig(harness.invalidConfig, "invalid-b", 2);
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();

      // The write listener supersedes the blocked preflight synchronously. Release it before
      // draining fake timers so Vitest does not need to nest timer advances around the gate.
      releaseEmissionPreflight();
      await emissionAdvance;
      await leaseClock.waitFor(Promise.resolve(clock.wake()));
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(hoisted.markRestartAbortedMainSessions).not.toHaveBeenCalled();
    } finally {
      releaseEmissionPreflight();
      hoisted.activeAgentRunCount.value = 0;
      await harness.reloader.stop();
    }
  });

  it("revalidates paused restart secrets before rearming an exact config revert", async () => {
    vi.useFakeTimers();
    const { clock, scheduler } = createConfigReloadTestClock();
    const harness = await createManagedRestartSequenceHarness({ scheduler });
    hoisted.activeAgentRunCount.value = 1;

    try {
      const deferredPromotion = harness.nextPromotion();
      harness.writeConfig(harness.deferredConfig, "deferred-a", 1);
      await clock.wake();
      await expect(deferredPromotion).resolves.toBe("deferred-a");

      const replacementError = harness.nextReloadError();
      harness.writeConfig(harness.invalidConfig, "invalid-b", 2);
      await clock.wake();
      await replacementError;
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();

      hoisted.activeAgentRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(5_000);
      harness.setSecretUnavailable("RESTART_A_TOKEN");

      const revalidationError = harness.nextReloadError();
      harness.writeConfig(harness.deferredConfig, "unavailable-revert-a", 3);
      await clock.wake();
      await expect(revalidationError).resolves.toBe(
        "config reload failed: Error: required SecretRef RESTART_A_TOKEN is unavailable",
      );

      expect(harness.activateRuntimeSecrets.prepareSnapshot.mock.calls[2]?.[0].config).toEqual(
        harness.deferredConfig,
      );
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(harness.promoteSnapshot.mock.calls.map(([snapshot]) => snapshot.hash)).not.toContain(
        "unavailable-revert-a",
      );
      expect(harness.terminalPolicy.isEnabled()).toBe(false);
    } finally {
      hoisted.activeAgentRunCount.value = 0;
      await harness.reloader.stop();
    }
  });

  it("lets a newer valid restart config replace the deferred restart owner", async () => {
    vi.useFakeTimers();
    const { clock, scheduler } = createConfigReloadTestClock();
    const harness = await createManagedRestartSequenceHarness({ scheduler });
    hoisted.activeAgentRunCount.value = 1;

    try {
      const deferredPromotion = harness.nextPromotion();
      harness.writeConfig(harness.deferredConfig, "deferred-a", 1);
      await clock.wake();
      await expect(deferredPromotion).resolves.toBe("deferred-a");

      const replacementPromotion = harness.nextPromotion();
      harness.writeConfig(harness.replacementConfig, "replacement-b", 2);
      await clock.wake();
      await expect(replacementPromotion).resolves.toBe("replacement-b");
      expect(harness.activateRuntimeSecrets.prepareSnapshot.mock.calls[1]?.[0].config).toEqual(
        harness.replacementConfig,
      );
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();

      hoisted.activeAgentRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500);
      await harness.restartEmitted;

      expect(harness.requestRecoveryRestart.mock.calls).toEqual([
        ["config reload: gateway.bind", undefined],
      ]);
    } finally {
      hoisted.activeAgentRunCount.value = 0;
      await harness.reloader.stop();
    }
  });

  it("retries managed hot reload when secrets change before publication", async () => {
    const writeListenerRef = createConfigWriteListenerRef();
    const initialConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", path: "/old" },
    } as OpenClawConfig;
    const nextConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", path: "/next" },
    } as OpenClawConfig;
    const initialSnapshot = makePreparedSecretsSnapshot(initialConfig);
    const refreshedSnapshot: PreparedSecretsRuntimeSnapshot = {
      ...initialSnapshot,
      authStores: prepareRuntimeAuthProfileStoreSnapshots([
        {
          agentDir: "/tmp/refreshed-agent",
          store: { version: 1, profiles: {} },
        },
      ]),
    };
    activateSecretsRuntimeSnapshot(initialSnapshot);
    const initialSnapshotRevision = getActiveSecretsRuntimeSnapshotRevision();
    let preparationCount = 0;
    const activateRuntimeSecrets = createMockRuntimeSecretsActivator(async (config) => {
      preparationCount += 1;
      if (preparationCount === 1) {
        expect(
          activateSecretsRuntimeSnapshotIfCurrent(
            refreshedSnapshot,
            getActiveSecretsRuntimeSnapshotRevision(),
            { preserveActivationLineage: true },
          ),
        ).toBe(true);
      }
      return makePreparedSecretsSnapshot(config);
    });
    const commitRuntimePolicy = vi.fn();
    type ReloadOutcome = { status: "promoted" } | { status: "failed"; message: string };
    const { promise: reloadOutcome, resolve: settleReload } = createDeferred<ReloadOutcome>();
    const promoteSnapshot = vi.fn(async () => {
      settleReload?.({ status: "promoted" });
      return true;
    });
    const logReload = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((message: string) => settleReload?.({ status: "failed", message })),
    };
    const setState = vi.fn();
    const reloader = startManagedGatewayConfigReloader({
      initialConfig,
      readSnapshot: vi.fn(async () =>
        createValidConfigSnapshot(nextConfig, "hot-reload-next"),
      ) as never,
      promoteSnapshot: promoteSnapshot as never,
      subscribeToWrites: captureConfigWriteListener(writeListenerRef),
      setState,
      logReload,
      activateRuntimeSecrets,
      commitRuntimePolicy,
    });
    await reloader.ready;
    const registeredWriteListener = writeListenerRef.current;
    assert(registeredWriteListener, "Expected config write listener to be registered");

    registeredWriteListener(
      createConfigWriteNotification(
        nextConfig,
        "hot-reload-next",
        1,
        "runtime-hot-reload-next",
        "source-hot-reload-next",
      ),
    );
    try {
      expect(await reloadOutcome).toEqual({ status: "promoted" });
      expect(activateRuntimeSecrets.prepareSnapshot).toHaveBeenCalledTimes(2);
      expect(getActiveSecretsRuntimeSnapshotRevision()).toBeGreaterThan(initialSnapshotRevision);
      expect(setState).toHaveBeenCalledOnce();
      expect(commitRuntimePolicy).toHaveBeenCalledOnce();
      expect(promoteSnapshot).toHaveBeenCalledOnce();
      expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(nextConfig);
    } finally {
      await reloader.stop();
    }
  });

  it.each(["preparation", "watcher"] as const)(
    "stops managed Gmail reload during %s without leaving a watcher running",
    async (phase) => {
      const writeListenerRef = createConfigWriteListenerRef();
      const entered = createDeferred<"preparation" | "watcher">();
      const release = createDeferred();
      let restartSignal: AbortSignal | undefined;
      const stopPostReadySidecars = vi.fn();
      const initialConfig = createGmailConfig("old@example.com");
      const nextConfig = createGmailConfig("next@example.com");
      const activateRuntimeSecrets = createMockRuntimeSecretsActivator(async (config) => {
        if (phase === "preparation") {
          entered.resolve("preparation");
          await release.promise;
        }
        return makePreparedSecretsSnapshot(config, { webTools: {} as never });
      });
      if (phase === "watcher") {
        hoisted.startGmailWatcherWithLogs.mockImplementationOnce(async (params) => {
          restartSignal = params.signal;
          entered.resolve("watcher");
          await new Promise<void>((resolve) => {
            params.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        });
      }
      const reloader = startManagedGatewayConfigReloader({
        initialConfig,
        readSnapshot: vi.fn(async () => createValidConfigSnapshot(nextConfig, "hash-next")),
        subscribeToWrites: captureConfigWriteListener(writeListenerRef),
        activateRuntimeSecrets,
        stopPostReadySidecars,
      });
      await reloader.ready;
      const listener = writeListenerRef.current;
      assert(listener, "Expected config write listener to be registered");
      try {
        listener(
          createConfigWriteNotification(
            nextConfig,
            "hash-next",
            1,
            "runtime-hash-next",
            "source-hash-next",
          ),
        );
        expect(await entered.promise).toBe(phase);
        if (phase === "watcher") {
          expect(restartSignal?.aborted).toBe(false);
          expect(getActiveGatewayRootWorkHolders()).toEqual(["reload:config"]);
          expect(hoisted.refreshContextWindowCache).not.toHaveBeenCalled();
          expect(stopPostReadySidecars).toHaveBeenCalledBefore(hoisted.stopGmailWatcher);
          expect(hoisted.startGmailWatcherWithLogs).toHaveBeenCalledWith(
            expect.objectContaining({ cfg: nextConfig }),
          );
        }
        const stopping = reloader.stop();
        release.resolve();
        await stopping;
        if (phase === "watcher") {
          expect(restartSignal?.aborted).toBe(true);
        } else {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(hoisted.stopGmailWatcher).not.toHaveBeenCalled();
          expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await reloader.stop();
      }
    },
  );

  it("keeps committed config after a Gmail watcher follow-up fails", async () => {
    await withGatewayRestartSignal(async (signalSpy) => {
      const signaled = createDeferred();
      signalSpy.mockImplementation(() => signaled.resolve());
      const writeListenerRef = createConfigWriteListenerRef();
      const initialConfig = createGmailConfig("old@example.com");
      const nextConfig: OpenClawConfig = {
        ...createGmailConfig("next@example.com"),
        models: { providers: {} },
      };
      const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
      hoisted.startGmailWatcherWithLogs.mockRejectedValueOnce(new Error("start failed"));
      const reloader = startManagedGatewayConfigReloader({
        initialConfig,
        readSnapshot: vi.fn(async () =>
          createValidConfigSnapshot(nextConfig, "hash-next"),
        ) as never,
        subscribeToWrites: captureConfigWriteListener(writeListenerRef),
        logReload,
      });
      await reloader.ready;
      try {
        const registeredWriteListener = writeListenerRef.current;
        assert(registeredWriteListener, "Expected config write listener to be registered");

        const application = publishConfigWrite(
          registeredWriteListener,
          createConfigWriteNotification(
            nextConfig,
            "hash-next",
            1,
            "runtime-hash-next",
            "source-hash-next",
          ),
        );
        await application;
        await signaled.promise;

        expect(hoisted.refreshContextWindowCache).toHaveBeenCalledTimes(1);
        expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
        expect(logReload.warn).toHaveBeenCalledWith(
          "gmail watcher reload failed after config commit: start failed; restarting gateway",
        );
        expect(logReload.error).not.toHaveBeenCalled();
        expect(signalSpy).toHaveBeenCalledOnce();
      } finally {
        await reloader.stop();
      }
    });
  });
});

describe("gateway plugin hot reload handlers", () => {
  it("skips channel work when the candidate env adds a skip flag", async () => {
    const envKey = "OPENCLAW_SKIP_PROVIDERS";
    const previousValue = process.env[envKey];
    delete process.env[envKey];
    const targetEnv: NodeJS.ProcessEnv = {};
    const nextConfig = { env: { vars: { [envKey]: "1" } } } satisfies OpenClawConfig;
    const runtimeEnv = prepareConfigRuntimeEnv({
      previousConfig: {},
      nextConfig,
      env: targetEnv,
    });
    const startChannel = vi.fn(async () => new Map());
    const stopChannel = vi.fn(async () => {});
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const handlers = createGatewayReloadHandlers({
      startChannel,
      stopChannel,
      logChannels,
    });

    try {
      await handlers.applyHotReload(
        createHotTailPlan({
          changedPaths: [`env.vars.${envKey}`, "channels.discord.token"],
          hotReasons: [`env.vars.${envKey}`, "channels.discord.token"],
          restartChannels: new Set(["discord"]),
        }),
        nextConfig,
        {
          sourceConfig: nextConfig,
          runtimeEnv: runtimeEnv.env,
          isCurrent: () => true,
          publish: async (commit) => {
            const publication = runtimeEnv.publish();
            try {
              await commit();
              publication.commit();
            } catch (error) {
              publication();
              throw error;
            }
          },
        },
      );
    } finally {
      if (previousValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previousValue;
      }
    }

    expect(runtimeEnv.env[envKey]).toBe("1");
    expect(targetEnv[envKey]).toBe("1");
    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel).not.toHaveBeenCalled();
    expect(logChannels.info).toHaveBeenCalledWith(
      "skipping channel reload (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
    );
  });

  it("passes isolated candidate env to plugin planning and publishes it with cron", async () => {
    const envKey = "OPENCLAW_TEST_HOT_RELOAD_SERVICE_ENV";
    const targetEnv: NodeJS.ProcessEnv = { [envKey]: "old" };
    const initialConfig = {
      gateway: { reload: {} },
      cron: { enabled: false },
      plugins: { enabled: false },
      env: { vars: { [envKey]: "old" } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      ...initialConfig,
      cron: { enabled: true },
      plugins: { enabled: true },
      env: { vars: { [envKey]: "candidate" } },
    } satisfies OpenClawConfig;
    const compareConfig = {
      ...nextConfig,
      env: initialConfig.env,
    } satisfies OpenClawConfig;
    const runtimeEnv = prepareConfigRuntimeEnv({
      previousConfig: initialConfig,
      nextConfig,
      env: targetEnv,
      previousOwnedEnv: { [envKey]: "old" },
    });
    const events: string[] = [];
    const rebuiltCronState = {
      cron: {
        start: vi.fn(async () => {
          events.push(`cron:${targetEnv[envKey]}`);
        }),
        stop: vi.fn(),
      },
      storePath: "/tmp/rebuilt-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: vi.fn(async () => {}),
      reconcileStreamWatchers: vi.fn(async () => {}),
      stopStreamWatchers: vi.fn(async () => {}),
      reconcileSystemJobs: vi.fn(async () => "converged" as const),
    };
    hoisted.buildGatewayCronService.mockImplementationOnce((params) => {
      events.push(`cron-build:${params?.env?.[envKey]}:${targetEnv[envKey]}`);
      return rebuiltCronState;
    });
    const writeListenerRef = createConfigWriteListenerRef();
    const reloadPlugins = vi.fn(
      async (params: {
        commitRuntime: () => Promise<void>;
        env: NodeJS.ProcessEnv;
      }): Promise<GatewayPluginReloadResult> => {
        events.push(`lookup:${params.env[envKey]}:${targetEnv[envKey]}`);
        await params.commitRuntime();
        events.push(`plugin:${targetEnv[envKey]}`);
        return makePluginReloadResult({
          activeChannels: new Set(["discord"]),
        });
      },
    );
    const reloader = startManagedGatewayConfigReloader({
      initialConfig,
      readSnapshot: vi.fn(async () => createValidConfigSnapshot(nextConfig, "hot-env")),
      subscribeToWrites: captureConfigWriteListener(writeListenerRef, false),
      reloadPlugins,
    });
    await reloader.ready;
    try {
      const listener = writeListenerRef.current;
      if (!listener) {
        throw new Error("Expected config write listener to be registered");
      }
      const application = createRuntimeConfigWriteApplication();
      listener(
        attachRuntimeConfigWriteApplication(
          createConfigWriteNotification(
            nextConfig,
            "hot-env",
            1,
            "runtime-hot-env",
            "source-hot-env",
            {
              preparedCandidate: { runtimeConfig: nextConfig, compareConfig, runtimeEnv },
            },
          ),
          application,
        ),
      );
      await expect(application.result).resolves.toBe("applied");

      expect(events).toEqual([
        "cron-build:candidate:old",
        "lookup:candidate:old",
        "cron:candidate",
        "plugin:candidate",
      ]);
      expect(targetEnv[envKey]).toBe("candidate");
    } finally {
      await reloader.stop();
    }
  });

  it("keeps mixed reload state old until the plugin replacement commit", async () => {
    const events: string[] = [];
    const started = createDeferred();
    const release = createDeferred();
    const sourceConfig: OpenClawConfig = {
      plugins: { enabled: true },
      hooks: { enabled: true, token: "token", path: "/next" },
    };
    const nextConfig: OpenClawConfig = {
      ...sourceConfig,
      plugins: {
        enabled: true,
        allow: ["external-plugin"],
        entries: { "external-plugin": { enabled: true } },
      },
    };
    const reloadPlugins = vi.fn<ReloadHandlerParams["reloadPlugins"]>(async (params) => {
      events.push("reload:start");
      hoisted.reloadEvents.push("prepare-plugins");
      started.resolve();
      await release.promise;
      await params.commitRuntime();
      events.push("registry:replace");
      hoisted.reloadEvents.push("replace-plugins");
      return makePluginReloadResult();
    });
    const handlers = createReloadHandlersForTest(
      undefined,
      {
        start: vi.fn(async () => new Map()),
        stop: vi.fn(async (channel) => {
          events.push(`stop:${channel}`);
        }),
      },
      reloadPlugins,
    );

    const reload = handlers.applyHotReload(
      createHotTailPlan({
        changedPaths: ["hooks.path", "plugins.enabled"],
        hotReasons: ["hooks.path", "plugins.enabled"],
        reloadHooks: true,
        reloadPlugins: true,
      }),
      nextConfig,
      {
        sourceConfig,
        isCurrent: () => true,
        publish: async (commit) => {
          events.push("runtime:publish");
          await commit();
        },
      },
    );

    await started.promise;
    expect(events).toEqual(["reload:start"]);
    expect(handlers.setState).not.toHaveBeenCalled();

    release.resolve();
    await reload;

    expect(events).toEqual(["reload:start", "runtime:publish", "registry:replace"]);
    expect(handlers.setState).toHaveBeenCalledTimes(1);
    expect(reloadPlugins.mock.calls[0]?.[0].nextConfig).toBe(nextConfig);
    expect(reloadPlugins.mock.calls[0]?.[0].sourceConfig).toBe(sourceConfig);
    const firstPrepareIndex = hoisted.reloadEvents.indexOf("prepare-plugins");
    expect(firstPrepareIndex).toBeGreaterThanOrEqual(0);
    expect(hoisted.reloadEvents.slice(firstPrepareIndex)).toEqual([
      "prepare-plugins",
      "stale-prepared-model-runtime",
      "replace-plugins",
      "refresh-prepared-model-runtime",
      "refresh-context-window",
    ]);
    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
    expect(hoisted.markPreparedModelRuntimeSnapshotsStale).toHaveBeenCalledWith(
      "prepared model runtime owner is stale before config publication",
      { waitForReplacement: true },
    );
    expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledWith(nextConfig, {
      allowGatewaySubagentBinding: true,
      catalogMode: "static",
      joinSupersedingPublication: true,
    });
  });

  it("reports committed state when the plugin afterCommit callback fails", async () => {
    const failure = new Error("plugin afterCommit failed");
    const events: string[] = [];
    let committed = false;
    const setState = vi.fn(() => events.push("config"));
    const handlers = createGatewayReloadHandlers({
      setState,
      reloadPlugins: async ({ commitRuntime }) => {
        await commitRuntime({
          publish: () => {
            events.push("plugin");
          },
          afterCommit: () => {
            events.push("notification");
            throw failure;
          },
        });
        return makePluginReloadResult();
      },
    });
    await expect(
      handlers.applyHotReload(
        createHotTailPlan({ reloadPlugins: true }),
        {},
        {
          sourceConfig: {},
          isCurrent: () => true,
          publish: async (commit, isCommitted) => {
            try {
              await commit();
            } finally {
              committed = isCommitted();
            }
          },
        },
      ),
    ).rejects.toBe(failure);
    expect(committed).toBe(true);
    expect(events).toEqual(["plugin", "config", "notification"]);
  });

  it("returns the plugin owner's receipt and finishes remaining targets after supersession", async () => {
    let current = true;
    const runtime = { operationId: "reload-owner", generation: 7, pluginIds: ["notes"] };
    const pluginLifecycle = {
      pluginIds: ["notes"],
      reason: "reload" as const,
      operationId: runtime.operationId,
    };
    const channels = { start: vi.fn(async () => new Map()), stop: vi.fn(async () => {}) };
    const pruneInactiveChannelAccountState = vi.fn();
    const reloadPlugins = vi.fn<ReloadHandlerParams["reloadPlugins"]>(async (params) => {
      params
        .prepareConfigEffects({
          pluginIds: new Set(runtime.pluginIds),
          channels: new Set(["discord"]),
        })
        .retire();
      await params.commitRuntime();
      current = false;
      return makePluginReloadResult({
        activeChannels: new Set(["discord", "slack"]),
        runtime,
      });
    });
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const handlers = createReloadHandlersForTest(
      undefined,
      {
        ...channels,
        pruneInactiveChannelAccountState,
      },
      reloadPlugins,
      undefined,
      requestRecoveryRestart,
    );
    await withChannelReloadsEnabled(async () => {
      await expect(
        handlers.applyHotReload(
          createHotTailPlan({
            ...createPluginReloadPlan(),
            pluginLifecycle,
            restartChannels: new Set(["discord", "slack"]),
            restartChannelAccounts: new Map([["discord", new Set(["default"])]]),
          }),
          {},
          {
            sourceConfig: {},
            isCurrent: () => current,
            publish: async (commit) => await commit(),
          },
        ),
      ).resolves.toEqual({ status: "applied", runtime });
    });
    expect(reloadPlugins.mock.calls[0]?.[0].pluginLifecycle).toBe(pluginLifecycle);
    expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledOnce();
    expect(hoisted.rejectPendingPreparedModelRuntimeReplacement).not.toHaveBeenCalled();
    expect(channels.stop).toHaveBeenCalledExactlyOnceWith("slack", undefined, {
      manual: false,
      routeHandoff: true,
    });
    expect(channels.start).toHaveBeenCalledExactlyOnceWith("slack", undefined, {
      reason: "config-reload",
      preserveManualStop: true,
      skipUnavailableAccounts: true,
    });
    expect(pruneInactiveChannelAccountState).toHaveBeenCalledExactlyOnceWith(
      new Set(["discord", "slack"]),
    );
    expect(requestRecoveryRestart).not.toHaveBeenCalled();
  });
});

describe("deferred channel reload abort generation", () => {
  const abortChannelReloadPlan: GatewayReloadPlan = createHotTailPlan({
    changedPaths: ["channels.whatsapp.enabled"],
    hotReasons: ["channels"],
    restartChannels: new Set(["whatsapp"]),
  });

  afterEach(() => {
    hoisted.activeAgentRunCount.value = 0;
    vi.useRealTimers();
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
  });

  const createTestHandlers = (
    logChannels: any,
    channels: any,
    options?: Pick<
      Partial<ReloadHandlerParams>,
      "reloadPlugins" | "requestRecoveryRestart" | "releaseChannelRouteHandoffs" | "logReload"
    >,
  ) =>
    createGatewayReloadHandlers({
      startChannel: channels.start,
      stopChannel: channels.stop,
      ...options,
      logChannels,
    });

  it("cancels the old reload at restart without aborting its successor", async () => {
    const oldChannels = { start: vi.fn(async () => new Map()), stop: vi.fn(async () => {}) };
    const nextChannels = { start: vi.fn(async () => new Map()), stop: vi.fn(async () => {}) };
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const oldHandlers = createTestHandlers(logChannels, oldChannels);
    hoisted.activeAgentRunCount.value = 1;
    vi.useFakeTimers();
    const oldReload = oldHandlers
      .applyHotReload(abortChannelReloadPlan, {})
      .catch((error: unknown) => error);

    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(oldHandlers.getDeferredChannelReloads?.()).toEqual([
        { channel: "whatsapp", publicationPending: true },
      ]);
      resetGatewayRestartStateForInProcessRestart();
      expect(oldHandlers.getDeferredChannelReloads?.()).toEqual([]);
      hoisted.activeAgentRunCount.value = 0;
      const nextHandlers = createTestHandlers(logChannels, nextChannels);
      expect(nextHandlers.getDeferredChannelReloads?.()).toEqual([]);
      const nextReload = nextHandlers
        .applyHotReload({ ...abortChannelReloadPlan, reloadInternalHooks: true }, {})
        .then(
          () => null,
          (error: unknown) => error,
        );
      await vi.advanceTimersByTimeAsync(500);

      const oldError = await oldReload;
      expect(oldError).toBeInstanceOf(Error);
      expect(oldError).toHaveProperty("name", "GatewayHotReloadCancelledError");
      expect(await nextReload).toBeNull();
      expect(oldChannels.stop).not.toHaveBeenCalled();
      expect(oldChannels.start).not.toHaveBeenCalled();
      expect(nextChannels.stop).toHaveBeenCalledExactlyOnceWith("whatsapp", undefined, {
        manual: false,
        routeHandoff: true,
      });
      expect(nextChannels.start).toHaveBeenCalledExactlyOnceWith("whatsapp", undefined, {
        reason: "config-reload",
        preserveManualStop: true,
        skipUnavailableAccounts: true,
      });
    } finally {
      hoisted.activeAgentRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500);
      await oldReload;
    }
  });

  it("cancels committed active-work deferral and releases model readers on shutdown", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const deferralStarted = createDeferred();
    const logReload = createInfoWarnErrorLogger();
    logReload.warn.mockImplementation(() => deferralStarted.resolve());
    const channels = {
      start: vi.fn(async () => new Map()),
      stop: vi.fn(async () => {}),
    };
    const reloadPlugins: ReloadHandlerParams["reloadPlugins"] = async (params) => {
      await params.commitRuntime();
      return makePluginReloadResult({
        activeChannels: new Set(["whatsapp"]),
      });
    };
    const { applyHotReload, getDeferredChannelReloads } = createTestHandlers(
      logChannels,
      channels,
      { reloadPlugins, logReload },
    );
    hoisted.activeAgentRunCount.value = 1;
    vi.useFakeTimers();

    try {
      const reloadPromise = applyHotReload(
        { ...createPluginReloadPlan(), restartChannels: new Set(["whatsapp"]) },
        {},
        {
          sourceConfig: {},
          isCurrent: () => true,
          publish: async (commit) => await commit(),
        },
      );
      const reloadError = reloadPromise.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(10);
      await deferralStarted.promise;
      expect(getDeferredChannelReloads?.()).toEqual([
        { channel: "whatsapp", publicationPending: false },
      ]);

      abortPendingChannelReloads();
      // Status follows the live owner immediately, not the next 500 ms poll.
      expect(getDeferredChannelReloads?.()).toEqual([]);
      await vi.advanceTimersByTimeAsync(500);
      const error = await reloadError;
      expect(getDeferredChannelReloads?.()).toEqual([]);
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty("name", "GatewayHotReloadCancelledError");

      expect(channels.stop).not.toHaveBeenCalled();
      expect(channels.start).not.toHaveBeenCalled();
      const gate = hoisted.markPreparedModelRuntimeSnapshotsStale.mock.results[0]?.value;
      expect(gate).toBeDefined();
      expect(hoisted.rejectPendingPreparedModelRuntimeReplacement).toHaveBeenCalledWith(
        gate,
        error,
      );
    } finally {
      vi.useRealTimers();
      hoisted.activeAgentRunCount.value = 0;
    }
  });

  it.each(["shutdown", "publication failure"] as const)(
    "settles a pending channel reload receipt after %s",
    async (outcome) => {
      const { clock, scheduler } = createConfigReloadTestClock();
      const initialConfig = {
        gateway: { reload: {} },
        channels: { whatsapp: { enabled: true, selfChatMode: false } },
      } satisfies OpenClawConfig;
      const nextConfig = {
        ...initialConfig,
        channels: { whatsapp: { enabled: true, selfChatMode: true } },
      } satisfies OpenClawConfig;
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "whatsapp",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "whatsapp" }),
              reload: {
                configPrefixes: ["channels.whatsapp.selfChatMode"],
                noopPrefixes: ["channels.whatsapp"],
              },
            },
          },
        ]),
      );
      const writer = createDirectConfigWriteFixture(initialConfig);
      const watcher = installWatcherMock();
      const setState = vi.fn();
      const commitRuntimePolicy = vi.fn();
      const startChannel = vi.fn(async () => new Map());
      const stopChannel = vi.fn(async () => {});
      const deferralStarted = createDeferred();
      const logReload = createInfoWarnErrorLogger();
      logReload.warn.mockImplementation(() => deferralStarted.resolve());
      const reloader = startManagedGatewayConfigReloader({
        scheduler,
        initialConfig,
        readSnapshot: writer.readSnapshot,
        subscribeToWrites: writer.subscribeToWrites,
        setState,
        commitRuntimePolicy,
        startChannel,
        stopChannel,
        logReload,
      });
      await reloader.ready;
      const blocker = tryBeginGatewayRootWorkAdmission();
      assert(blocker, "Expected unrelated gateway request admission");
      const application = createRuntimeConfigWriteApplication();
      vi.useFakeTimers();

      try {
        writer.ref.current!(
          attachRuntimeConfigWriteApplication(
            createConfigWriteNotification(nextConfig, "pending-write", 1, "runtime", "source"),
            application,
          ),
        );
        const reload = clock.wake();
        await deferralStarted.promise;
        expect(application.claimed).toBe(true);
        expect(reloader.getDeferredChannelReloads?.()).toEqual([
          { channel: "whatsapp", publicationPending: true },
        ]);
        expect(setState).not.toHaveBeenCalled();

        if (outcome === "shutdown") {
          const stopping = reloader.stop();
          await vi.advanceTimersByTimeAsync(500);
          await expect(application.result).resolves.toBe("stopped");
          await stopping;
          expect(setState).not.toHaveBeenCalled();
        } else {
          setState.mockImplementation(() => {
            throw new Error("runtime publication refused");
          });
          blocker.release();
          await vi.advanceTimersByTimeAsync(500);
          await expect(application.result).resolves.toBe("failed");
        }
        await reload;
        expect(reloader.getDeferredChannelReloads?.()).toEqual([]);
        expect(commitRuntimePolicy).not.toHaveBeenCalled();
        expect(startChannel).not.toHaveBeenCalled();
        expect(stopChannel).not.toHaveBeenCalled();
      } finally {
        blocker.release();
        const stopping = reloader.stop();
        await vi.advanceTimersByTimeAsync(500);
        await stopping;
        watcher.restore();
      }
    },
  );

  it("finishes committed runtime work before settling its receipt", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {} },
      channels: { whatsapp: { enabled: true, selfChatMode: false } },
    };
    const nextConfig: OpenClawConfig = {
      ...initialConfig,
      channels: { whatsapp: { enabled: true, selfChatMode: true } },
      plugins: { entries: { fixture: { enabled: true } } },
    };
    activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "whatsapp" }),
            reload: {
              configPrefixes: ["channels.whatsapp.selfChatMode"],
              noopPrefixes: ["channels.whatsapp"],
            },
          },
        },
      ]),
    );
    const watcher = installWatcherMock();
    const writer = createDirectConfigWriteFixture(initialConfig);
    const writeListenerRef = writer.ref;
    const channels = { start: vi.fn(async () => new Map()), stop: vi.fn(async () => {}) };
    const commitRuntimePolicy = vi.fn();
    const deferredChannels = createDeferred();
    const logReload = {
      info: vi.fn(),
      warn: vi.fn((message: string) => {
        if (message.includes("deferring until")) {
          deferredChannels.resolve();
        }
      }),
      error: vi.fn(),
    };
    const continuePlugin = createDeferred();
    const pluginCommitted = createDeferred();
    let blocker: ReturnType<typeof tryBeginGatewayRootWorkAdmission> = null;
    const submitWrite = () =>
      runWithGatewayIndependentRootWorkAdmission(async () => {
        const application = createRuntimeConfigWriteApplication(
          captureGatewayRootWorkAdmissionContinuationScope()?.run,
        );
        writeListenerRef.current!(
          attachRuntimeConfigWriteApplication(
            createConfigWriteNotification(nextConfig, "same-write", 1, "runtime", "source"),
            application,
          ),
        );
        return await application.result;
      });
    const reloader = startManagedGatewayConfigReloader({
      initialConfig,
      readSnapshot: writer.readSnapshot,
      subscribeToWrites: writer.subscribeToWrites,
      startChannel: channels.start,
      stopChannel: channels.stop,
      reloadPlugins: async (params) => {
        if (params.isAborted?.()) {
          throw new PluginRuntimeApplicationError(
            "Plugin reload cancelled",
            { ...makePluginReloadResult().runtime, phase: "prepare", committed: false },
            { cause: new GatewayConfigReloadSupersededError() },
          );
        }
        await params.commitRuntime();
        pluginCommitted.resolve();
        await continuePlugin.promise;
        return makePluginReloadResult({ activeChannels: new Set(["whatsapp"]) });
      },
      commitRuntimePolicy,
      logReload,
    });
    await reloader.ready;
    let request: Promise<RuntimeConfigWriteApplicationStatus> | undefined;

    try {
      expect(reloader.isConfigReloadSettled()).toBe(true);
      request = submitWrite();
      expect(reloader.isConfigReloadSettled()).toBe(false);
      await pluginCommitted.promise;
      expect(channels.stop).not.toHaveBeenCalled();
      expect(reloader.isConfigReloadSettled()).toBe(false);
      blocker = tryBeginGatewayRootWorkAdmission();
      if (!blocker) {
        throw new Error("Expected unrelated gateway request admission");
      }
      continuePlugin.resolve();
      await deferredChannels.promise;
      expect(logReload.warn).toHaveBeenCalledWith(expect.stringContaining("deferring until"));
      watcher.emit("change", "/tmp/openclaw.json");
      blocker.release();
      await expect(request).resolves.toBe("applied");
      expect(channels.stop).toHaveBeenCalledOnce();
      expect(channels.start).toHaveBeenCalledOnce();
      expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledWith(
        nextConfig,
        expect.anything(),
      );
      expect(hoisted.rejectPendingPreparedModelRuntimeReplacement).not.toHaveBeenCalled();
      expect(commitRuntimePolicy).toHaveBeenCalledWith(nextConfig);
      expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(nextConfig);
      expect(logReload.error).not.toHaveBeenCalled();
      await waitForReloadState(reloader.isConfigReloadSettled);
      expect(reloader.isConfigReloadSettled()).toBe(true);
    } finally {
      continuePlugin.resolve();
      blocker?.release();
      const stopping = reloader.stop();
      await stopping;
      await request;
      watcher.restore();
    }
  });

  it("requests recovery when prepared model refresh fails after commit", async () => {
    const failure = new Error("prepared runtime refresh failed");
    hoisted.refreshPreparedModelRuntimeSnapshots.mockRejectedValueOnce(failure);
    const channels = { start: vi.fn(async () => new Map()), stop: vi.fn(async () => {}) };
    const logReload = createInfoWarnErrorLogger();
    const { requestRecoveryRestart, restartEmitted } = createRecoveryRestartMock();
    const handlers = createTestHandlers(createInfoWarnErrorLogger(), channels, {
      logReload,
      requestRecoveryRestart,
      reloadPlugins: async (params) => {
        await params.commitRuntime();
        return makePluginReloadResult({ activeChannels: new Set(["whatsapp"]) });
      },
    });

    try {
      await withChannelReloadsEnabled(async () => {
        await expect(
          handlers.applyHotReload(
            { ...createPluginReloadPlan(), restartChannels: new Set(["whatsapp"]) },
            {},
            {
              sourceConfig: {},
              isCurrent: () => true,
              publish: async (commit) => await commit(),
            },
          ),
        ).resolves.toBe("applied-restart-required");
      });
      await restartEmitted;
      expect(requestRecoveryRestart).toHaveBeenCalledOnce();
      expect(hoisted.rejectPendingPreparedModelRuntimeReplacement).toHaveBeenCalledOnce();
      expect(channels.stop).not.toHaveBeenCalled();
      expect(channels.start).not.toHaveBeenCalled();
      expect(logReload.warn).toHaveBeenCalledWith(
        "prepared model runtime reload failed after config commit: prepared runtime refresh failed; restarting gateway",
      );
    } finally {
      handlers.stopRestartRetries();
    }
  });

  it("forwards cancellation to the plugin owner and leaves channel cleanup there", async () => {
    const channels = { start: vi.fn(async () => new Map()), stop: vi.fn(async () => {}) };
    const pruneInactiveChannelAccountState = vi.fn();
    const started = createDeferred();
    const release = createDeferred();
    const failure = new PluginRuntimeApplicationError(
      "Plugin reload cancelled",
      { ...makePluginReloadResult().runtime, phase: "prepare", committed: false },
      { cause: new GatewayConfigReloadSupersededError() },
    );
    const reloadPlugins = vi.fn<ReloadHandlerParams["reloadPlugins"]>(async (params) => {
      expect(params.isAborted?.()).toBe(false);
      started.resolve();
      await release.promise;
      expect(params.isAborted?.()).toBe(true);
      throw failure;
    });
    const handlers = createGatewayReloadHandlers({
      startChannel: channels.start,
      stopChannel: channels.stop,
      pruneInactiveChannelAccountState,
      reloadPlugins,
    });
    const reload = handlers.applyHotReload(createPluginReloadPlan(), {});
    const rejected = expect(reload).rejects.toBe(failure);
    await started.promise;
    abortPendingChannelReloads();
    release.resolve();
    await rejected;
    expect(channels.start).not.toHaveBeenCalled();
    expect(channels.stop).not.toHaveBeenCalled();
    expect(pruneInactiveChannelAccountState).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
