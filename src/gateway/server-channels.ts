import { RetrySupervisor } from "../../packages/retry/src/index.js";
import { isChannelAccountExplicitlyDisabled } from "../channels/account-config-enabled.js";
import { describeChannelAccount, resolveChannelAccount } from "../channels/account-resolution.js";
import { getCredentialUnavailableDiagnostics } from "../channels/account-snapshot-fields.js";
import {
  buildChannelAccountSnapshotFromInspection,
  buildChannelAccountSnapshotFromRuntime,
} from "../channels/account-summary.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import {
  getLoadedChannelPluginEntryById,
  listLoadedChannelPluginsForRegistry,
} from "../channels/plugins/registry-loaded.js";
import type { ChannelGatewayContextV2 } from "../channels/plugins/types.adapters.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot, ChannelId } from "../channels/plugins/types.public.js";
import {
  applyChannelAccountState,
  resolveChannelAccountState,
  resolveUnavailableChannelAccountSnapshot,
} from "../channels/status/account-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withGatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalMethod } from "../infra/approval-gateway-runtime-methods.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import { startChannelApprovalHandlerBootstrap } from "../infra/approval-handler-bootstrap.js";
import { type BackoffPolicy, sleepWithAbort } from "../infra/backoff.js";
import {
  createTaskScopedChannelRuntime,
  registerChannelRuntimeContext,
} from "../infra/channel-runtime-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatGatewayCrashLoopManualChannelStartHint } from "../infra/gateway-boot-lifecycle.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import {
  createSubsystemLogger,
  runtimeForLogger,
  type SubsystemLogger,
} from "../logging/subsystem.js";
import { createPluginRuntimeCapabilityLease } from "../plugins/capability-lease.js";
import {
  createPluginHttpRouteHandoff,
  withPluginHttpRouteRegistry,
  type PluginHttpRouteHandoff,
} from "../plugins/http-registry.js";
import { runPluginCleanup } from "../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  withPluginRuntimeGatewayContextResolver,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntimeChannel } from "../plugins/runtime/types-channel.js";
import { withPluginServiceScheduler } from "../plugins/service-scheduler-binding.js";
import type { PluginServiceSchedulerV1 } from "../plugins/service-scheduler.types.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  assertSecretOwnerAvailable,
  clearActiveCredentialDegradedOwner,
  setActiveCredentialDegradedOwner,
} from "../secrets/runtime-degraded-state.js";
import { isAccountEnabled } from "../shared/account-enabled.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import {
  channelStartFailurePatch,
  sanitizeAbortedTaskStatusPatch,
} from "./channel-status-patches.js";
import { waitForChannelStopGracefully } from "./channel-stop-timeout.js";
import {
  createChannelAccountLifetime,
  resolveChannelAccountStopFallback,
  runChannelAccountStop,
  type ChannelAccountLifetime,
  type ChannelAccountStopOutcome,
} from "./server-channel-account-lifetime.js";
import { createChannelAutostartRecovery } from "./server-channel-autostart-recovery.js";
import type {
  ChannelAccountStartOutcome,
  ChannelRuntimeSnapshot,
  ChannelRuntimeSnapshotOptions,
  StartChannelOptions,
} from "./server-channel-runtime.types.js";
import { pauseChannelStarts, type ChannelStartFence } from "./server-channel-start-fence.js";
import {
  runChannelAccountMonitor,
  runChannelAccountStartup,
  waitForChannelStartupHandoff,
  waitForDeferredAccountStart,
} from "./server-channel-startup.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

const RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.1,
};
const MAX_RESTARTS = 10;
const CHANNEL_STABLE_RUN_MS = RESTART_POLICY.maxMs;
const CHANNEL_STOP_ABORT_TIMEOUT_MS = 5_000;
const CHANNEL_STARTUP_CONCURRENCY = 4;
// Private context key carried through the generic Plugin SDK registry. This is
// not a new public capability surface; only the host installs its authority.
const CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY = "approval.gateway";

type ChannelRuntimeStore = {
  startFence?: ChannelStartFence;
  lifetimes: Map<string, ChannelAccountLifetime>;
  routeHandoffs: Map<string, PluginHttpRouteHandoff>;
  starting: Map<string, Promise<void>>;
  stops: Map<string, ChannelAccountStopState>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ChannelAccountSnapshot>;
};

type HealthMonitorConfig = {
  healthMonitor?: {
    enabled?: boolean;
  };
};

type ChannelHealthMonitorConfig = HealthMonitorConfig & {
  accounts?: Record<string, HealthMonitorConfig>;
};

export type ChannelAutostartSuppression = {
  reason: "crash-loop-breaker";
  message: string;
};

type GatewayStartupTrace = {
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

type ChannelManagerOptions = {
  scheduler: GatewayScheduler;
  getRuntimeConfig: () => OpenClawConfig;
  getPluginRegistry: () => PluginRegistry;
  resolveGatewayContext?: GatewayContextResolver;
  channelLogs: Partial<Record<ChannelId, SubsystemLogger>>;
  channelRuntimeEnvs: Partial<Record<ChannelId, RuntimeEnv>>;
  /** Supply the complete createPluginRuntime().channel surface; partial stubs are unsupported. */
  channelRuntime?: PluginRuntimeChannel;
  /** Resolve the same complete surface only when a channel account starts. */
  resolveChannelRuntime?: () => PluginRuntimeChannel | Promise<PluginRuntimeChannel>;
  startupTrace?: GatewayStartupTrace;
  deferStartupAccountStartsUntil?: Promise<void>;
  getNativeApprovalRuntime?: () => GatewayNativeApprovalRuntime | undefined;
  ambientAutostartSuppressedChannelIds?: ReadonlySet<string>;
  tryRecoverAutostartSuppression?: (signal: AbortSignal) => Promise<number | undefined>;
  isClosing?: () => boolean;
};

type StopChannelOptions = {
  manual?: boolean;
  routeHandoff?: boolean;
  /** Report unfinished cleanup to the caller after the bounded stop attempt. */
  strict?: boolean;
};

type ChannelAccountStopState = (
  | { status: "stopping"; attempt: Promise<ChannelAccountStopOutcome>; settled: boolean }
  | Extract<ChannelAccountStopOutcome, { status: "rejected" }>
) & {
  cleanup?: Promise<ChannelAccountStopOutcome>;
};

export type ChannelManager = {
  getRuntimeSnapshot: (options?: ChannelRuntimeSnapshotOptions) => ChannelRuntimeSnapshot;
  pauseChannelStarts: (
    channelIds: Iterable<ChannelId>,
  ) => (outcome: "published" | "rollback" | "failed", channelIds?: ReadonlySet<ChannelId>) => void;
  startChannels: () => Promise<void>;
  startChannel: (
    channel: ChannelId,
    accountId?: string,
    opts?: StartChannelOptions,
  ) => Promise<ReadonlyMap<string, ChannelAccountStartOutcome>>;
  stopChannel: (channel: ChannelId, accountId?: string, opts?: StopChannelOptions) => Promise<void>;
  releaseChannelRouteHandoffs: (channel: ChannelId, accountId?: string) => void;
  setAutostartSuppression: (suppression: ChannelAutostartSuppression | null) => void;
  getAutostartSuppression: () => ChannelAutostartSuppression | null;
  recoverAutostartSuppression: (signal?: AbortSignal) => Promise<number | undefined> | undefined;
  setAmbientAutostartSuppressedChannelIds: (channelIds: ReadonlySet<string>) => void;
  isAmbientAutostartSuppressed: (channelId: string) => boolean;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
  isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
  isAccountListed: (channelId: ChannelId, accountId: string) => boolean;
  isAutoRestartScheduled: (channelId: ChannelId, accountId: string) => boolean;
  resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
  isHealthMonitorEnabled: (channelId: ChannelId, accountId: string) => boolean;
};

// Channel docking: lifecycle hooks (`plugin.gateway`) flow through this manager.
export function createChannelManager(opts: ChannelManagerOptions): ChannelManager & {
  pruneInactiveChannelAccountState: (activeChannelIds: ReadonlySet<ChannelId>) => void;
  resolveRuntimeAccountId: (channelId: ChannelId, accountId: string) => string | undefined;
  hasCurrentAccountTask: (channelId: ChannelId, accountId: string) => boolean;
} {
  const {
    getRuntimeConfig,
    channelLogs,
    channelRuntimeEnvs,
    channelRuntime,
    resolveChannelRuntime,
    getPluginRegistry,
    startupTrace,
  } = opts;

  // Each operation retains its Gateway's registry; later retries select its successor.
  // Ambient request or process registries may belong to another live Gateway.
  const withRegistry = <T>(run: (registry: PluginRegistry) => T): T => {
    const registry = getPluginRegistry();
    return withPluginRuntimeRegistryScope(registry, () => run(registry));
  };
  const getChannelPlugin = (channelId: ChannelId) =>
    getLoadedChannelPluginEntryById(channelId, getPluginRegistry())?.plugin;
  const channelStores = new Map<ChannelId, ChannelRuntimeStore>();
  const restarts = new Map<string, RetrySupervisor>();
  // Tracks accounts that were manually stopped so we don't auto-restart them.
  const manuallyStopped = new Set<string>();
  const recoveryStopTimedOut = new Set<string>();
  const recoveryStartRequested = new Set<string>();
  // Accounts whose crash recovery is already owned by the retry supervisor below
  // (backoff sleep plus its replacement start). `restartPending` cannot answer
  // this: the timed-out-stop recovery sets it too, and that one needs the health
  // monitor to keep driving it.
  const pendingAutoRestarts = new Set<string>();
  const clearRecoveryState = (key: string) => {
    recoveryStopTimedOut.delete(key);
    recoveryStartRequested.delete(key);
  };
  let autostartSuppression: ChannelAutostartSuppression | null = null;
  let ambientAutostartSuppressedChannelIds = new Set(
    opts.ambientAutostartSuppressedChannelIds ?? [],
  );

  const restartKey = (channelId: ChannelId, accountId: string) => `${channelId}:${accountId}`;
  const releaseRouteHandoff = (
    store: ChannelRuntimeStore,
    accountId: string,
    expected = store.routeHandoffs.get(accountId),
  ): void => {
    if (expected && store.routeHandoffs.get(accountId) === expected) {
      expected.release();
      store.routeHandoffs.delete(accountId);
    }
  };
  const releaseChannelRouteHandoffs = (channelId: ChannelId, accountId?: string): void => {
    const store = getStore(channelId);
    for (const id of accountId ? [accountId] : store.routeHandoffs.keys()) {
      // Partial rollback must preserve ingress owned by an admitted sibling.
      if (!store.tasks.has(id) || store.lifetimes.get(id)?.abort.signal.aborted !== false) {
        releaseRouteHandoff(store, id);
      }
    }
  };
  const ensureChannelLog = (channelId: ChannelId): SubsystemLogger => {
    channelLogs[channelId] ??= createSubsystemLogger("channels").child(channelId);
    return channelLogs[channelId];
  };
  const ensureChannelRuntime = (channelId: ChannelId): RuntimeEnv => {
    channelRuntimeEnvs[channelId] ??= runtimeForLogger(ensureChannelLog(channelId));
    return channelRuntimeEnvs[channelId];
  };

  const resolveAccountHealthMonitorOverride = (
    channelConfig: ChannelHealthMonitorConfig | undefined,
    channelId: ChannelId,
    accountId: string,
  ): boolean | undefined => {
    if (!channelConfig?.accounts) {
      return undefined;
    }
    const direct = resolveChannelAccountEntry(channelConfig.accounts, accountId, channelId);
    if (typeof direct?.healthMonitor?.enabled === "boolean") {
      return direct.healthMonitor.enabled;
    }
    const normalizedAccountId = normalizeOptionalAccountId(accountId);
    if (!normalizedAccountId) {
      return undefined;
    }
    const match = resolveChannelAccountEntry(
      channelConfig.accounts,
      normalizedAccountId,
      channelId,
      normalizeAccountId,
    );
    if (typeof match?.healthMonitor?.enabled !== "boolean") {
      return undefined;
    }
    return match.healthMonitor.enabled;
  };

  const isHealthMonitorEnabled = (channelId: ChannelId, accountId: string): boolean => {
    const cfg = getRuntimeConfig();
    const channelConfig = cfg.channels?.[channelId] as ChannelHealthMonitorConfig | undefined;
    const accountOverride = resolveAccountHealthMonitorOverride(
      channelConfig,
      channelId,
      accountId,
    );
    const channelOverride = channelConfig?.healthMonitor?.enabled;

    return accountOverride ?? (typeof channelOverride === "boolean" ? channelOverride : true);
  };

  const getStore = (channelId: ChannelId): ChannelRuntimeStore => {
    const existing = channelStores.get(channelId);
    if (existing) {
      return existing;
    }
    const next: ChannelRuntimeStore = {
      lifetimes: new Map(),
      routeHandoffs: new Map(),
      starting: new Map(),
      stops: new Map(),
      tasks: new Map(),
      runtimes: new Map(),
    };
    channelStores.set(channelId, next);
    return next;
  };

  const getRuntime = (channelId: ChannelId, accountId: string): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    return (
      store.runtimes.get(accountId) ?? {
        ...getChannelPlugin(channelId)?.status?.defaultRuntime,
        accountId,
      }
    );
  };

  const setRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: Omit<ChannelAccountSnapshot, "accountId">,
  ): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    const current = getRuntime(channelId, accountId);
    const hasExplicitReadyRecovery =
      Object.hasOwn(patch, "lifecycle") &&
      patch.lifecycle === "ready" &&
      Object.hasOwn(patch, "terminalDisconnect") &&
      patch.terminalDisconnect === undefined;
    // Weaker/derived signals never clear a terminal diagnosis. Gateway-owned starting still
    // begins a new lifecycle; a channel-authored explicit ready + terminal clear proves recovery.
    const lifecycle =
      current.lifecycle === "blocked" &&
      current.terminalDisconnect === true &&
      patch.lifecycle !== "starting" &&
      !hasExplicitReadyRecovery
        ? "blocked"
        : (patch.lifecycle ??
          (patch.restartPending === true
            ? "recovering"
            : patch.connected === true
              ? "ready"
              : undefined));
    const next = { ...current, ...patch, ...(lifecycle ? { lifecycle } : {}), accountId };
    store.runtimes.set(accountId, next);
    return next;
  };

  const setRuntimeFromTaskStatus = (
    channelId: ChannelId,
    accountId: string,
    patch: ChannelAccountSnapshot,
    abortSignal: AbortSignal,
  ): ChannelAccountSnapshot => {
    const safePatch = abortSignal.aborted
      ? sanitizeAbortedTaskStatusPatch(patch, getRuntime(channelId, accountId))
      : patch;
    const next = setRuntime(channelId, accountId, safePatch);
    // Ready follows all ingress registrations; terminal startup may wait for abort.
    // Retire on this task's terminal report, never an inherited diagnosis.
    if (!abortSignal.aborted && (next.lifecycle === "ready" || patch.terminalDisconnect === true)) {
      releaseRouteHandoff(getStore(channelId), accountId);
    }
    return next;
  };

  const setStoppedRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: Omit<ChannelAccountSnapshot, "accountId" | "running"> = {},
  ): ChannelAccountSnapshot => {
    const current = getRuntime(channelId, accountId);
    return setRuntime(channelId, accountId, {
      running: false,
      lifecycle: patch.restartPending === true ? "recovering" : "stopped",
      ...(typeof current.connected === "boolean" ? { connected: false } : {}),
      ...patch,
    });
  };

  const createAccountContext = (
    channelId: ChannelId,
    accountId: string,
    cfg: OpenClawConfig,
    account: unknown,
    abortSignal: AbortSignal,
    scheduler: PluginServiceSchedulerV1,
  ): Omit<ChannelGatewayContextV2, "setStatus"> => ({
    cfg,
    accountId,
    account,
    abortSignal,
    scheduler,
    runtime: ensureChannelRuntime(channelId),
    log: ensureChannelLog(channelId),
    getStatus: () => getRuntime(channelId, accountId),
  });
  const measureStartup = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
    return startupTrace ? startupTrace.measure(name, run) : await run();
  };

  const evictStaleChannelAccountState = (
    channelId: ChannelId,
    store: ChannelRuntimeStore,
    accountIds: readonly string[],
  ) => {
    const activeAccountIds = new Set(accountIds);
    for (const id of store.routeHandoffs.keys()) {
      if (!activeAccountIds.has(id)) {
        releaseRouteHandoff(store, id);
      }
    }
    for (const id of store.runtimes.keys()) {
      if (
        activeAccountIds.has(id) ||
        store.lifetimes.has(id) ||
        store.starting.has(id) ||
        store.stops.has(id) ||
        store.tasks.has(id)
      ) {
        continue;
      }
      store.runtimes.delete(id);
      clearActiveCredentialDegradedOwner("account", restartKey(channelId, normalizeAccountId(id)));
      const key = restartKey(channelId, id);
      restarts.delete(key);
      manuallyStopped.delete(key);
      recoveryStartRequested.delete(key);
    }
  };

  const pruneInactiveChannelAccountState = (activeChannelIds: ReadonlySet<ChannelId>): void => {
    for (const [channelId, store] of channelStores) {
      if (!activeChannelIds.has(channelId)) {
        evictStaleChannelAccountState(channelId, store, []);
      }
    }
  };

  const startChannelProcessOwned = async (
    registry: PluginRegistry,
    channelId: ChannelId,
    accountId?: string,
    optsValue: StartChannelOptions = {},
  ): Promise<ReadonlyMap<string, ChannelAccountStartOutcome>> => {
    const store = getStore(channelId);
    const registration = getLoadedChannelPluginEntryById(channelId, registry);
    // Unchanged instances keep pending starts across registry publication.
    const assertStartCurrent = () => {
      if (
        store.startFence?.state === "paused" ||
        getLoadedChannelPluginEntryById(channelId, getPluginRegistry())?.plugin !==
          registration?.plugin
      ) {
        throw new Error("Channel plugins are reloading; retry the start after reload completes.");
      }
    };
    assertStartCurrent();
    const plugin = registration?.plugin;
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) {
      for (const id of accountId ? [accountId] : store.routeHandoffs.keys()) {
        releaseRouteHandoff(store, id);
      }
      return accountId
        ? new Map([[accountId, { status: "skipped", reason: "unsupported" }]])
        : new Map();
    }
    const { preserveRestartAttempts = false, preserveManualStop = false } = optsValue;
    const cfg = getRuntimeConfig();
    resetDirectoryCache({ cfg, channel: channelId, accountId });
    const accountIds = accountId
      ? [accountId]
      : await measureStartup(`channels.${channelId}.list-accounts`, () =>
          plugin.config.listAccountIds(cfg),
        );
    assertStartCurrent();
    if (!accountId) {
      evictStaleChannelAccountState(channelId, store, accountIds);
    }
    if (accountIds.length === 0) {
      return new Map();
    }
    const suppression = optsValue.manual === true ? null : autostartSuppression;
    const ambientSuppressed =
      optsValue.manual !== true && ambientAutostartSuppressedChannelIds.has(channelId);
    if (suppression || ambientSuppressed) {
      // Safe mode must block every automatic channel start surface; otherwise
      // config reloads can undo the crash-loop breaker while operators inspect.
      if (suppression) {
        const suffix = accountId ? ` account ${accountId}` : "";
        ensureChannelLog(channelId).warn?.(
          `channel autostart suppressed by crash-loop breaker; refusing automatic start for ${channelId}${suffix}. ${formatGatewayCrashLoopManualChannelStartHint({ channelId, ...(accountId ? { accountId } : {}) })}`,
        );
      }
      for (const id of accountIds) {
        releaseRouteHandoff(store, id);
        setStoppedRuntime(channelId, id, {
          restartPending: false,
          lastError:
            suppression?.message ??
            "ambient channel credentials suppressed; configure the channel or start the gateway with --ambient-channels",
        });
      }
      return new Map(
        accountIds.map((id) => [
          id,
          {
            status: "skipped",
            reason: suppression ? "autostart-suppressed" : "ambient-suppressed",
          } as const,
        ]),
      );
    }

    const startOutcomes = new Map<string, ChannelAccountStartOutcome>();
    const startup = await runTasksWithConcurrency({
      limit: CHANNEL_STARTUP_CONCURRENCY,
      tasks: accountIds.map((id) => async () => {
        const rKey = restartKey(channelId, id);
        const setRestartState = (restartPending: boolean, reconnectAttempts = 0) =>
          setRuntime(channelId, id, { restartPending, reconnectAttempts });
        const explicitlyDisabled = isChannelAccountExplicitlyDisabled({
          cfg,
          channel: channelId,
          accountId: id,
        });
        // An operator disable ends ingress even when an aborted predecessor
        // still owns its task slot. Keep that slot for its separate cleanup.
        if (explicitlyDisabled) {
          releaseRouteHandoff(store, id);
        }
        // Record start intent before waiting; a later stop must survive cancelled preparation.
        if (!preserveManualStop && !store.stops.has(id)) {
          manuallyStopped.delete(rKey);
        }
        // A stopped preparation may never publish a task. Reacquire its slot only
        // after cleanup, rechecking ownership when other starts were also waiting.
        for (;;) {
          // An in-flight or failed plugin teardown may still own resources.
          if (store.stops.has(id)) {
            startOutcomes.set(id, { status: "retry", reason: "stop-in-flight" });
            return;
          }
          if (store.tasks.has(id)) {
            const timedOutRecovery = recoveryStopTimedOut.has(rKey);
            if (timedOutRecovery && manuallyStopped.has(rKey)) {
              startOutcomes.set(id, { status: "skipped", reason: "manual-stop" });
              return;
            }
            if (!timedOutRecovery || !recoveryStartRequested.has(rKey)) {
              if (timedOutRecovery) {
                recoveryStartRequested.add(rKey);
                setRuntime(channelId, id, { restartPending: true });
              }
              startOutcomes.set(id, { status: "retry", reason: "task-owned" });
              return;
            }
            // A repeated recovery request retires the stuck predecessor before replacement.
            clearRecoveryState(rKey);
            restarts.delete(rKey);
            store.lifetimes.get(id)?.capabilityLease.revoke();
            store.lifetimes.delete(id);
            store.tasks.delete(id);
            setRestartState(false);
          }
          const existingStart = store.starting.get(id);
          if (!existingStart) {
            break;
          }
          await existingStart;
        }

        const startGate = createDeferredCore();
        store.starting.set(id, startGate.promise);

        // Reserve the account before the first await so overlapping start calls
        // cannot race into duplicate provider boots for the same account.
        const routeHandoff = store.routeHandoffs.get(id);
        const lifetime = createChannelAccountLifetime(plugin, registry, opts.scheduler);
        const { abort, capabilityLease, scheduler } = lifetime;
        const startCancelled = () =>
          abort.signal.aborted || manuallyStopped.has(rKey) || opts.isClosing?.();
        store.lifetimes.set(id, lifetime);
        let handedOffTask = false;
        const log = ensureChannelLog(channelId);
        let scopedChannelRuntime: ReturnType<
          typeof createTaskScopedChannelRuntime<PluginRuntimeChannel>
        > | null = null;
        let stopApprovalBootstrap: () => Promise<void> = async () => {};
        const cleanupTaskScopedApprovalRuntime = async (label: string) => {
          try {
            const scopedRuntime = scopedChannelRuntime;
            scopedChannelRuntime = null;
            const stopBootstrap = stopApprovalBootstrap;
            stopApprovalBootstrap = async () => {};
            scopedRuntime?.dispose();
            await stopBootstrap();
          } catch (error) {
            log.error?.(`[${id}] ${label}: ${formatErrorMessage(error)}`);
          }
        };
        const skipAccount = (
          reason: "disabled" | "unconfigured" | "unlinked",
          patch: Omit<ChannelAccountSnapshot, "accountId">,
        ) => {
          setRuntime(channelId, id, { ...patch, running: false, restartPending: false });
          startOutcomes.set(id, { status: "skipped", reason });
        };

        try {
          // Reject active accounts before plugin resolution so an explicit failed SecretRef cannot
          // drift into a channel-specific environment or file fallback.
          const secretOwnerId = `${channelId}:${normalizeAccountId(id)}`;
          clearActiveCredentialDegradedOwner("account", secretOwnerId);
          // Explicitly disabled accounts need no credentials. Unlisted requests still go
          // through the plugin resolver so a disable cannot hide account-selection errors.
          if (
            explicitlyDisabled &&
            plugin.config
              .listAccountIds(cfg)
              .some((listed) => normalizeAccountId(listed) === normalizeAccountId(id))
          ) {
            skipAccount("disabled", { enabled: false });
            return;
          }
          try {
            assertSecretOwnerAvailable("account", secretOwnerId);
          } catch (error) {
            if (!optsValue.skipUnavailableAccounts) {
              throw error;
            }
            // Only this snapshot-owned assertion is an expected cold reload
            // outcome; plugin startup and credential-file inspection still fail.
            setStoppedRuntime(channelId, id, {
              restartPending: false,
              lastError: formatErrorMessage(error),
            });
            startOutcomes.set(id, { status: "skipped", reason: "secret-unavailable" });
            return;
          }
          const account = await resolveChannelAccount({ plugin, cfg, accountId: id });
          capabilityLease.assertActive("startup");
          const accountContext = createAccountContext(
            channelId,
            id,
            cfg,
            account,
            abort.signal,
            scheduler,
          );
          if (plugin.gateway?.stopAccount) {
            const stopAccount = plugin.gateway.stopAccount;
            const gateway = plugin.gateway;
            lifetime.teardown = {
              context: accountContext,
              run: (context) =>
                runPluginCleanup(stopAccount, () => stopAccount.call(gateway, context)),
            };
          }
          const described = await describeChannelAccount({ plugin, account, cfg });
          assertStartCurrent();
          capabilityLease.assertActive("startup");
          const enabled = plugin.config.isEnabled
            ? plugin.config.isEnabled(account, cfg)
            : isAccountEnabled(account);
          if (!enabled) {
            skipAccount("disabled", { enabled: false });
            return;
          }

          const credentialDiagnostics = getCredentialUnavailableDiagnostics(account);
          if (credentialDiagnostics.length > 0) {
            setActiveCredentialDegradedOwner({
              ownerKind: "account",
              ownerId: secretOwnerId,
              state: "unavailable",
              paths: credentialDiagnostics.map((diagnostic) => diagnostic.path),
              refKeys: [],
              reason: "credential file is unavailable",
            });
            assertSecretOwnerAvailable("account", secretOwnerId);
          }

          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await measureStartup(`channels.${channelId}.is-configured`, () =>
              plugin.config.isConfigured!(account, cfg),
            );
          }
          capabilityLease.assertActive("startup");
          if (!configured) {
            skipAccount("unconfigured", { enabled: true, configured: false, linked: undefined });
            return;
          }
          setRuntime(channelId, id, {
            enabled: true,
            configured: true,
            ...(plugin.config.isLinked ? { linked: undefined } : {}),
          });

          const fallbackLinked = described?.linked ?? getRuntime(channelId, id).linked;
          const linkState = plugin.config.isLinked
            ? await measureStartup(`channels.${channelId}.is-linked`, () =>
                plugin.config.isLinked!(account, cfg),
              )
            : fallbackLinked === true
              ? "linked"
              : fallbackLinked === false
                ? "not-linked"
                : undefined;
          capabilityLease.assertActive("startup");
          if (linkState === "not-linked" || linkState === "unknown") {
            skipAccount("unlinked", {
              enabled: true,
              linked: linkState === "not-linked" ? false : undefined,
            });
            return;
          }

          scopedChannelRuntime = await measureStartup(`channels.${channelId}.runtime`, async () =>
            createTaskScopedChannelRuntime({
              channelRuntime:
                registration?.resolveChannelRuntime?.() ??
                channelRuntime ??
                (await resolveChannelRuntime?.()),
            }),
          );
          capabilityLease.assertActive("startup");
          const channelRuntimeForTask = scopedChannelRuntime.channelRuntime;

          if (!preserveRestartAttempts) {
            restarts.delete(rKey);
          }
          try {
            stopApprovalBootstrap = await measureStartup(
              `channels.${channelId}.approval-bootstrap`,
              () =>
                startChannelApprovalHandlerBootstrap({
                  scheduler: opts.scheduler,
                  plugin,
                  cfg,
                  accountId: id,
                  channelRuntime: channelRuntimeForTask,
                  gatewayRuntime: opts.getNativeApprovalRuntime?.(),
                  logger: log,
                }),
            );
          } catch (error) {
            log.error?.(`[${id}] native approval bootstrap failed: ${formatErrorMessage(error)}`);
          }
          // Preparation can outlive a registry replacement or an operator stop. Never publish
          // its predecessor task after the replacement has admitted new account lifetimes.
          assertStartCurrent();
          capabilityLease.assertActive("startup");
          if (startCancelled()) {
            startOutcomes.set(id, { status: "skipped", reason: "manual-stop" });
            return;
          }
          let channelRunDurationMs: number | undefined;
          setRuntime(channelId, id, {
            enabled: true,
            ...(linkState === "linked" ? { linked: true } : {}),
            running: true,
            lifecycle: "starting",
            restartPending: false,
            lastStartAt: Date.now(),
            lastError: null,
            // Runtime rows are patch-merged; prior ingress or terminal verdicts
            // must not poison a new lifecycle before its plugin reports status.
            ingressUnavailable: undefined,
            terminalDisconnect: undefined,
            ...(getRuntime(channelId, id).healthState === "plugin-trust-refused"
              ? { healthState: undefined }
              : {}),
            reconnectAttempts: preserveRestartAttempts ? (restarts.get(rKey)?.attempts ?? 0) : 0,
          });
          const task = Promise.resolve().then(async () => {
            if (optsValue.deferAccountStartUntil) {
              await waitForDeferredAccountStart(optsValue.deferAccountStartUntil, abort.signal);
            } else if (startupTrace) {
              await waitForChannelStartupHandoff();
            }
            if (startCancelled()) {
              return;
            }
            const gatewayApprovalRuntime = opts.getNativeApprovalRuntime?.();
            if (channelRuntimeForTask && gatewayApprovalRuntime) {
              const approvalRuntime: Pick<GatewayNativeApprovalRuntime, "request"> = {
                request: async <T>(
                  method: GatewayNativeApprovalMethod,
                  requestParams: Record<string, unknown>,
                  requestOptions?: { clientDisplayName?: string },
                ): Promise<T> => {
                  if (method !== "approval.resolve") {
                    throw new Error(`channel approval runtime cannot dispatch ${method}`);
                  }
                  return await gatewayApprovalRuntime.request<T>(
                    "approval.resolve",
                    requestParams,
                    requestOptions,
                  );
                },
              };
              registerChannelRuntimeContext({
                channelRuntime: channelRuntimeForTask,
                channelId,
                accountId: id,
                capability: CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY,
                context: approvalRuntime,
                abortSignal: abort.signal,
              });
            }
            let startAccountTask: ReturnType<typeof startAccount> | undefined;
            await measureStartup(`channels.${channelId}.start-account-handoff`, () => {
              if (startCancelled()) {
                return;
              }
              log.info(
                `[${id}] starting account (reason: ${optsValue.reason ?? (optsValue.manual ? "manual" : "requested")})`,
              );
              const runStartAccount = async () => {
                const startedAt = Date.now();
                try {
                  return await withGatewayNativeApprovalRuntime(
                    opts.getNativeApprovalRuntime?.(),
                    () =>
                      startAccount({
                        ...accountContext,
                        setStatus: (next) =>
                          isCurrentTask()
                            ? setRuntimeFromTaskStatus(channelId, id, next, abort.signal)
                            : getRuntime(channelId, id),
                        invalidateDirectoryCache: () =>
                          resetDirectoryCache({ cfg, channel: channelId, accountId: id }),
                        ...(channelRuntimeForTask ? { channelRuntime: channelRuntimeForTask } : {}),
                      }),
                  );
                } finally {
                  channelRunDurationMs = Date.now() - startedAt;
                }
              };
              startAccountTask = withPluginHttpRouteRegistry(
                registry,
                () =>
                  withPluginServiceScheduler(accountContext.scheduler, () =>
                    runChannelAccountMonitor(registry, registration?.pluginId, runStartAccount),
                  ),
                capabilityLease,
              );
            });
            if (!startAccountTask) {
              return;
            }
            await startAccountTask;
          });
          // Recovery can replace a timed-out task before the old promise settles.
          // Only the task that still owns the store slot may write lifecycle state.
          const settledTask = async () => {
            try {
              await task;
            } finally {
              try {
                await scheduler.stop();
              } finally {
                capabilityLease.revoke();
              }
            }
          };
          const trackedPromise = settledTask()
            .then(() => {
              if (startCancelled() || !isCurrentTask()) {
                return;
              }
              if (getRuntime(channelId, id).terminalDisconnect) {
                // Terminal status carries the operator-facing diagnosis and restart policy.
                // Do not replace it with a generic clean-exit error before policy consumes it.
                return;
              }
              const message = "channel exited without an error";
              setRuntime(channelId, id, { lastError: message });
              log.error?.(`[${id}] ${message}`);
            })
            .catch((err: unknown) => {
              if (!isCurrentTask() || store.stops.has(id) || opts.isClosing?.()) {
                return;
              }
              const failure = channelStartFailurePatch(err);
              setRuntime(channelId, id, failure);
              log.error?.(`[${id}] channel exited: ${failure.lastError}`);
            })
            .then(async () => {
              await cleanupTaskScopedApprovalRuntime("channel cleanup failed");
              // stopChannel owns the failed-teardown snapshot until a later
              // successful stop proves replacement is safe.
              if (!isCurrentTask() || store.stops.has(id) || opts.isClosing?.()) {
                return;
              }
              setStoppedRuntime(channelId, id, {
                lastStopAt: Date.now(),
              });
            })
            .then(async () => {
              if (!isCurrentTask() || store.stops.has(id) || opts.isClosing?.()) {
                return;
              }
              if (manuallyStopped.has(rKey)) {
                clearRecoveryState(rKey);
                return;
              }
              if (getRuntime(channelId, id).terminalDisconnect) {
                // Terminal startup/session failures win over pending recovery.
                // Leaving recovery state behind would restart a channel that needs user action.
                clearRecoveryState(rKey);
                restarts.delete(rKey);
                setRestartState(false);
                log.info?.(`[${id}] auto-restart skipped, terminal disconnect`);
                return;
              }
              if (recoveryStopTimedOut.has(rKey)) {
                recoveryStopTimedOut.delete(rKey);
                if (!recoveryStartRequested.delete(rKey)) {
                  setRestartState(false);
                  releaseTask();
                  return;
                }
                restarts.delete(rKey);
                log.info?.(`[${id}] restarting after timed-out channel stop completed`);
                setRestartState(true);
                releaseTask();
                try {
                  await startChannelInternal(channelId, id, {
                    reason: "stop-recovery",
                    preserveManualStop: true,
                  });
                } catch {
                  // abort or startup failure — runtime state was recorded by startChannelInternal
                }
                return;
              }
              // Only plugin task lifetime counts. Deferred handoff and cleanup must not
              // make a short crash look stable and erase crash-loop attempts.
              if (
                channelRunDurationMs !== undefined &&
                channelRunDurationMs >= CHANNEL_STABLE_RUN_MS
              ) {
                restarts.delete(rKey);
              }
              const restart =
                restarts.get(rKey) ?? new RetrySupervisor(RESTART_POLICY, MAX_RESTARTS);
              restarts.set(rKey, restart);
              const retry = restart.next(abort.signal);
              if (!retry) {
                setRestartState(false, restart.attempts);
                log.error?.(`[${id}] giving up after ${MAX_RESTARTS} restart attempts`);
                return;
              }
              log.info?.(
                `[${id}] auto-restart attempt ${restart.attempts}/${MAX_RESTARTS} in ${Math.round(retry.delayMs / 1000)}s`,
              );
              setRestartState(true, restart.attempts);
              pendingAutoRestarts.add(rKey);
              try {
                await sleepWithAbort(retry.delayMs, retry.signal);
                if (manuallyStopped.has(rKey) || opts.isClosing?.()) {
                  return;
                }
                releaseTask();
                await startChannelInternal(channelId, id, {
                  reason: "auto-restart",
                  preserveRestartAttempts: true,
                  preserveManualStop: true,
                });
              } catch {
                // abort or startup failure — next crash will retry
              } finally {
                pendingAutoRestarts.delete(rKey);
              }
            })
            .finally(() => {
              const ownsHandoff = store.lifetimes.get(id) === lifetime && !abort.signal.aborted;
              releaseTask();
              // Retry ingress spans backoff and preparation. A successful retry
              // transfers admission to its signal before this predecessor ends.
              if (routeHandoff && ownsHandoff) {
                releaseRouteHandoff(store, id, routeHandoff);
              }
            });
          function releaseTask() {
            if (store.tasks.get(id) === trackedPromise) {
              store.tasks.delete(id);
            }
            // Failed or queued teardown retains the admitted context. Every terminal
            // task still aborts before replacement so no predecessor keeps authority.
            if (store.lifetimes.get(id) === lifetime && !store.stops.has(id)) {
              store.lifetimes.delete(id);
            }
            abort.abort();
          }
          function isCurrentTask() {
            return store.tasks.get(id) === trackedPromise;
          }
          handedOffTask = true;
          store.tasks.set(id, trackedPromise);
          startOutcomes.set(id, { status: "handed-off" });
        } catch (error) {
          if (!handedOffTask && capabilityLease.isActive()) {
            setStoppedRuntime(channelId, id, {
              restartPending: false,
              lastError: formatErrorMessage(error),
            });
          }
          throw error;
        } finally {
          if (!handedOffTask) {
            if (routeHandoff && capabilityLease.isActive()) {
              releaseRouteHandoff(store, id, routeHandoff);
            }
            try {
              await scheduler.stop();
            } finally {
              capabilityLease.revoke();
            }
            await cleanupTaskScopedApprovalRuntime("channel startup cleanup failed");
          }
          if (!handedOffTask && store.lifetimes.get(id) === lifetime && !store.stops.has(id)) {
            store.lifetimes.delete(id);
          }
          if (store.starting.get(id) === startGate.promise) {
            store.starting.delete(id);
          }
          startGate.resolve();
        }
      }),
    });
    if (startup.hasError) {
      throw startup.firstError;
    }
    return startOutcomes;
  };

  const startChannelInternal: ChannelManager["startChannel"] = (...args) =>
    runChannelAccountStartup(() =>
      withPluginRuntimeGatewayContextResolver(
        opts.resolveGatewayContext,
        () => withRegistry((registry) => startChannelProcessOwned(registry, ...args)),
        { inheritRequestScope: false },
      ),
    );

  const stopChannelInRegistry = async (
    registry: PluginRegistry,
    channelId: ChannelId,
    accountId?: string,
    optsLocal: StopChannelOptions = {},
  ) => {
    const manual = optsLocal.manual ?? true;
    const retainCleanupOwner = manual || !optsLocal.routeHandoff;
    const plugin = getLoadedChannelPluginEntryById(channelId, registry)?.plugin;
    const store = getStore(channelId);
    if (retainCleanupOwner) {
      releaseChannelRouteHandoffs(channelId, accountId);
    }
    const lifecycleIds = new Set<string>([
      ...store.lifetimes.keys(),
      ...store.starting.keys(),
      ...store.stops.keys(),
      ...store.tasks.keys(),
    ]);
    // Preserve no-enumeration channel-wide idle stops. An explicit account stop
    // must still commit manual intent before health monitoring can restart it.
    if (!accountId && lifecycleIds.size === 0) {
      return;
    }
    const cfg = getRuntimeConfig();
    // Enter the registered owner's cleanup scope before accessing config getters.
    const configuredAccountIds =
      !accountId || optsLocal.routeHandoff
        ? plugin
          ? runPluginCleanup(plugin, () => plugin.config.listAccountIds(cfg))
          : []
        : [];
    const knownIds = new Set<string>(
      accountId ? [accountId] : [...lifecycleIds, ...configuredAccountIds],
    );

    // Gate replacement starts before teardown begins. Failures still reject only
    // after every sibling account has finished its independent lifecycle cleanup.
    const stopOutcomes = await Promise.all(
      Array.from(knownIds.values()).map(async (id): Promise<ChannelAccountStopOutcome> => {
        const rKey = restartKey(channelId, id);
        if (manual) {
          manuallyStopped.add(rKey);
        }
        const currentStop = store.stops.get(id);
        if (currentStop?.status === "stopping") {
          const outcome = await currentStop.attempt;
          const unsettled = !currentStop.settled || (retainCleanupOwner && store.starting.has(id));
          return optsLocal.strict && unsettled && outcome.status === "fulfilled"
            ? {
                status: "rejected",
                error: new Error(`Channel ${channelId}/${id} still owns running work.`),
              }
            : outcome;
        }

        const runStopAttempt = async (): Promise<ChannelAccountStopOutcome> => {
          const lifetime = store.lifetimes.get(id);
          const abort = lifetime?.abort;
          const canHandoff =
            optsLocal.routeHandoff &&
            configuredAccountIds.includes(id) &&
            !isChannelAccountExplicitlyDisabled({ cfg, channel: channelId, accountId: id }) &&
            !manuallyStopped.has(rKey);
          if (!canHandoff) {
            releaseRouteHandoff(store, id);
          }
          const task =
            store.tasks.get(id) ??
            (optsLocal.strict && retainCleanupOwner ? store.starting.get(id) : undefined);
          const fallback = resolveChannelAccountStopFallback(lifetime, plugin, cfg, id, manual);
          if (!abort && !task && !lifetime?.teardown && !fallback) {
            stopState.settled = true;
            return { status: "fulfilled" };
          }
          const lease = lifetime?.capabilityLease;
          if (canHandoff && lease) {
            const handoff = store.routeHandoffs.get(id) ?? createPluginHttpRouteHandoff();
            handoff.park(lease);
            store.routeHandoffs.set(id, handoff);
          }
          // Parking transfers ingress ownership before cancellation. Retired
          // startup work must never reclaim it while its promise is settling.
          if (optsLocal.routeHandoff) {
            lease?.revoke();
          }
          abort?.abort();
          const log = ensureChannelLog(channelId);
          let outcome: ChannelAccountStopOutcome = { status: "fulfilled" };
          let stopAccountSettled = true;
          // Running and failed-stop accounts belong to their admitted plugin and config,
          // even after publication removes the account or replaces its registration.
          const teardown = lifetime?.teardown;
          if (teardown || fallback) {
            // Teardown can outlive the start task. Its own lease permits route and status
            // writes only until this stop attempt completes or times out.
            const stopLease = createPluginRuntimeCapabilityLease("channel account stop");
            try {
              // A plugin stopAccount that never settles must not wedge every
              // stop-driven flow (health monitor sweeps, thaw recovery, reload).
              // Ordinary recovery retains the timed-out owner; explicit handoff
              // retires its slots after revoking OpenClaw runtime authority.
              const retainedCleanup = store.stops.get(id)?.cleanup;
              let stopAccountStarted = retainedCleanup !== undefined;
              const stopAccountAttempt =
                retainedCleanup ??
                runChannelAccountStop({
                  registry,
                  rootScheduler: opts.scheduler,
                  lease: stopLease,
                  teardown,
                  fallback,
                  createFallbackContext: (account, scheduler) =>
                    createAccountContext(
                      channelId,
                      id,
                      cfg,
                      account,
                      new AbortController().signal,
                      scheduler,
                    ),
                  setStatus: (next) =>
                    stopLease.isActive()
                      ? setRuntime(channelId, id, next)
                      : getRuntime(channelId, id),
                  onCleanupStarted: () => {
                    stopAccountStarted = true;
                  },
                  onError: (error) =>
                    log.warn?.(`[${id}] stopAccount failed: ${formatErrorMessage(error)}`),
                });
              stopAccountSettled = await waitForChannelStopGracefully(
                stopAccountAttempt,
                CHANNEL_STOP_ABORT_TIMEOUT_MS,
              );
              const stopState = store.stops.get(id);
              if (!stopAccountSettled) {
                // Retain physical teardown; an expired account lookup admitted no cleanup.
                if (stopState && stopAccountStarted) {
                  stopState.cleanup = stopAccountAttempt;
                }
                log.warn?.(
                  `[${id}] stopAccount exceeded ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms; continuing stop`,
                );
              } else {
                outcome = await stopAccountAttempt;
                if (stopState?.cleanup === stopAccountAttempt) {
                  delete stopState.cleanup;
                }
              }
            } catch (error) {
              outcome = { status: "rejected", error };
              log.warn?.(`[${id}] stopAccount failed: ${formatErrorMessage(error)}`);
            } finally {
              stopLease.revoke();
            }
          }
          const stoppedCleanly = await waitForChannelStopGracefully(
            task,
            CHANNEL_STOP_ABORT_TIMEOUT_MS,
          );
          stopState.settled = stopAccountSettled && stoppedCleanly;
          if (!stoppedCleanly) {
            log.warn?.(
              `[${id}] channel stop exceeded ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms after abort; continuing shutdown`,
            );
          }
          if (
            (!stopAccountSettled && retainCleanupOwner) ||
            (optsLocal.strict && (!stopAccountSettled || !stoppedCleanly))
          ) {
            outcome = {
              status: "rejected",
              error: new Error(
                `Channel ${channelId}/${id} ${stoppedCleanly ? "stopAccount did not settle" : "still owns running work"}.`,
              ),
            };
          }
          if (outcome.status === "rejected" && retainCleanupOwner) {
            clearRecoveryState(rKey);
            if (stoppedCleanly && store.tasks.get(id) === task) {
              store.tasks.delete(id);
            }
            setRuntime(channelId, id, {
              running: true,
              restartPending: false,
              lastError: formatErrorMessage(outcome.error),
            });
            return outcome;
          }
          if (!stoppedCleanly && retainCleanupOwner) {
            const stoppedPatch = {
              restartPending: !manual,
              lastError: `channel stop timed out after ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms`,
            };
            if (manual) {
              setRuntime(channelId, id, {
                running: true,
                ...stoppedPatch,
              });
            } else {
              setStoppedRuntime(channelId, id, stoppedPatch);
              recoveryStopTimedOut.add(rKey);
            }
            return outcome;
          }
          clearRecoveryState(rKey);
          if (store.tasks.get(id) === task) {
            store.tasks.delete(id);
          }
          // Only the final stop releases the captured owner. Handoff retires pending
          // preparation too; its revoked lease fences late results and route writes.
          if (store.lifetimes.get(id) === lifetime) {
            store.lifetimes.delete(id);
            if (!retainCleanupOwner) {
              store.starting.delete(id);
            }
          }
          setStoppedRuntime(channelId, id, {
            restartPending: false,
            lastStopAt: Date.now(),
            ...(outcome.status === "rejected"
              ? { lastError: formatErrorMessage(outcome.error) }
              : {}),
          });
          return outcome;
        };

        const stopAttempt = Promise.resolve().then(runStopAttempt);
        const stopState: Extract<ChannelAccountStopState, { status: "stopping" }> = {
          status: "stopping",
          attempt: stopAttempt,
          settled: false,
          ...(currentStop?.cleanup ? { cleanup: currentStop.cleanup } : {}),
        };
        store.stops.set(id, stopState);
        const outcome = await stopAttempt;
        const latestStop = store.stops.get(id);
        if (latestStop?.status === "stopping" && latestStop.attempt === stopAttempt) {
          if (outcome.status === "rejected" && retainCleanupOwner) {
            store.stops.set(id, {
              ...outcome,
              ...(latestStop.cleanup ? { cleanup: latestStop.cleanup } : {}),
            });
          } else {
            store.stops.delete(id);
            if (!store.tasks.has(id) && !store.starting.has(id)) {
              store.lifetimes.delete(id);
            }
          }
        }
        return outcome;
      }),
    );
    const failedStop = stopOutcomes.find((outcome) => outcome.status === "rejected");
    if (failedStop?.status === "rejected") {
      throw failedStop.error;
    }
    if (accountId && !manual && plugin) {
      const currentAccountIds = runPluginCleanup(plugin, () =>
        plugin.config.listAccountIds(getRuntimeConfig()),
      );
      evictStaleChannelAccountState(channelId, store, currentAccountIds);
    }
  };

  const stopChannel: ChannelManager["stopChannel"] = (...args) =>
    withRegistry((registry) => stopChannelInRegistry(registry, ...args));

  const startChannelsWithOptions = async (startOptions: StartChannelOptions = {}) => {
    let releaseAccountStarts: (() => void) | undefined;
    const deferAccountStartUntil =
      opts.deferStartupAccountStartsUntil ??
      (startupTrace
        ? new Promise<void>((resolve) => {
            releaseAccountStarts = () => {
              const handle = setImmediate(resolve);
              handle.unref?.();
            };
          })
        : undefined);
    try {
      await runTasksWithConcurrency({
        limit: CHANNEL_STARTUP_CONCURRENCY,
        tasks: listLoadedChannelPluginsForRegistry(getPluginRegistry()).map(
          (plugin) => async () => {
            try {
              await measureStartup(`channels.${plugin.id}.start`, () =>
                startChannelInternal(plugin.id, undefined, {
                  reason: "startup",
                  ...startOptions,
                  ...(deferAccountStartUntil ? { deferAccountStartUntil } : {}),
                }),
              );
            } catch (err) {
              ensureChannelLog(plugin.id).error?.(
                `[${plugin.id}] channel startup failed: ${formatErrorMessage(err)}`,
              );
            }
          },
        ),
      });
    } finally {
      releaseAccountStarts?.();
    }
  };

  const recoverAutostartSuppression = createChannelAutostartRecovery({
    getSuppression: () => autostartSuppression,
    clearSuppression: () => {
      autostartSuppression = null;
    },
    tryRecover: opts.tryRecoverAutostartSuppression,
    signal: opts.scheduler.signal,
    isClosing: opts.isClosing,
    // Resuming deferred autostart preserves explicit operator stops.
    startChannels: () =>
      startChannelsWithOptions({ reason: "autostart-recovery", preserveManualStop: true }),
  });

  const markChannelLoggedOut = (channelId: ChannelId, cleared: boolean, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return;
    }
    const resolvedId =
      accountId ?? resolveChannelDefaultAccountId({ plugin, cfg: getRuntimeConfig() });
    const store = getStore(channelId);
    // A manual start can overtake logout while its credential hook settles.
    if (store.starting.has(resolvedId) || store.tasks.has(resolvedId)) {
      return;
    }
    const current = getRuntime(channelId, resolvedId);
    setStoppedRuntime(channelId, resolvedId, {
      ...(cleared ? { linked: false } : {}),
      restartPending: false,
      lastError: cleared ? "logged out" : current.lastError,
    });
  };

  const captureChannelSnapshot = (plugin: ChannelPlugin, inspectAccounts = true) => {
    const channelId = plugin.id;
    const store = getStore(channelId);
    const cfg = getRuntimeConfig();
    const registry = getPluginRegistry();
    const configuredAccountIds = [...plugin.config.listAccountIds(cfg)];
    const configuredAccountIdSet = new Set(configuredAccountIds);
    const accountIds = [...new Set([...configuredAccountIds, ...store.lifetimes.keys()])];
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg,
      accountIds: configuredAccountIds,
    });
    const defaultRuntime = { ...plugin.status?.defaultRuntime };
    const accounts = Object.fromEntries(
      accountIds.map((id): [string, ChannelAccountSnapshot] => {
        const runtime = store.runtimes.get(id) ?? { ...defaultRuntime, accountId: id };
        const current = configuredAccountIdSet.has(id)
          ? runtime
          : buildChannelAccountSnapshotFromRuntime(runtime);
        const unavailable = resolveUnavailableChannelAccountSnapshot(cfg, {
          registry,
          channelId,
          accountId: id,
          runtime: current,
        });
        if (unavailable || !configuredAccountIdSet.has(id) || !inspectAccounts) {
          return [id, unavailable ?? { ...current }];
        }
        const inspected = plugin.config.inspectAccount?.(cfg, id);
        if (inspected) {
          return [
            id,
            buildChannelAccountSnapshotFromInspection({
              account: inspected,
              accountId: id,
              runtime: current,
            }),
          ];
        }
        if (plugin.config.resolveAccountAsync || plugin.config.describeAccountAsync) {
          return [id, { ...current }];
        }
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        const described = plugin.config.describeAccount?.(account, cfg);
        const next = { ...current, accountId: id, enabled };
        applyChannelAccountState(
          next,
          resolveChannelAccountState({
            enabled,
            configured: described?.configured ?? current.configured ?? true,
            linked:
              plugin.config.isLinked || typeof current.linked === "boolean"
                ? current.linked
                : described?.linked,
            runtime: current,
            disabledReason: plugin.config.disabledReason?.(account, cfg),
            unconfiguredReason: plugin.config.unconfiguredReason?.(account, cfg),
            unlinkedReason: plugin.config.unlinkedReason?.(account, cfg),
          }),
        );
        if (described?.mode !== undefined) {
          next.mode = described.mode;
        }
        return [id, next];
      }),
    );
    return {
      listedAccountIds: configuredAccountIdSet,
      accounts,
      defaultAccountId,
      defaultAccount: accounts[defaultAccountId] ?? {
        ...defaultRuntime,
        accountId: defaultAccountId,
      },
    };
  };

  const getRuntimeSnapshot = (
    options: ChannelRuntimeSnapshotOptions = {},
  ): ChannelRuntimeSnapshot => {
    const { channelId, inspectAccounts = true } = options;
    const channels: ChannelRuntimeSnapshot["channels"] = {};
    const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
    const reloadingChannels = new Map<ChannelId, string | undefined>();
    for (const plugin of listLoadedChannelPluginsForRegistry(getPluginRegistry())) {
      if (channelId !== undefined && plugin.id !== channelId) {
        continue;
      }
      const fence = getStore(plugin.id).startFence;
      const snapshot =
        fence && fence.state !== "published"
          ? fence.snapshot
          : captureChannelSnapshot(plugin, inspectAccounts);
      if (fence?.state === "paused") {
        reloadingChannels.set(plugin.id, snapshot?.defaultAccountId);
      }
      if (snapshot) {
        const accounts =
          snapshot === fence?.snapshot
            ? Object.fromEntries(
                Object.entries(snapshot.accounts).map(
                  ([id, captured]): [string, ChannelAccountSnapshot] => {
                    const runtime = { ...captured, ...getStore(plugin.id).runtimes.get(id) };
                    return [
                      id,
                      buildChannelAccountSnapshotFromInspection({
                        account: runtime,
                        accountId: id,
                        runtime,
                      }),
                    ];
                  },
                ),
              )
            : snapshot.accounts;
        channels[plugin.id] = accounts[snapshot.defaultAccountId] ?? snapshot.defaultAccount;
        channelAccounts[plugin.id] = accounts;
      }
    }
    return { channels, channelAccounts, reloadingChannels };
  };

  return {
    getRuntimeSnapshot,
    pauseChannelStarts: (channelIds) =>
      pauseChannelStarts(channelIds, getStore, (channelId) => {
        const plugin = getChannelPlugin(channelId);
        return plugin ? captureChannelSnapshot(plugin) : undefined;
      }),
    startChannels: () => startChannelsWithOptions(),
    startChannel: startChannelInternal,
    stopChannel,
    releaseChannelRouteHandoffs,
    pruneInactiveChannelAccountState,
    setAutostartSuppression: (suppression) => {
      autostartSuppression = suppression;
    },
    getAutostartSuppression: () => autostartSuppression,
    recoverAutostartSuppression,
    setAmbientAutostartSuppressedChannelIds: (channelIds) => {
      ambientAutostartSuppressedChannelIds = new Set(channelIds);
    },
    isAmbientAutostartSuppressed: (channelId) =>
      ambientAutostartSuppressedChannelIds.has(channelId),
    markChannelLoggedOut,
    isManuallyStopped: (channelId, accountId) =>
      manuallyStopped.has(restartKey(channelId, accountId)),
    hasCurrentAccountTask: (channelId, accountId) => {
      const store = channelStores.get(channelId);
      const lifetime = store?.lifetimes.get(accountId);
      // A retained task slot can be an aborted predecessor or supervised backoff.
      return Boolean(
        store &&
        lifetime &&
        store.tasks.has(accountId) &&
        !store.stops.has(accountId) &&
        !lifetime.abort.signal.aborted &&
        lifetime.capabilityLease.isActive() &&
        lifetime.plugin === getChannelPlugin(channelId),
      );
    },
    isAccountListed: (channelId, accountId) => {
      const fence = channelStores.get(channelId)?.startFence;
      // Failed reloads retain diagnostic facts without calling unavailable plugin code.
      return fence && fence.state !== "published"
        ? (fence.snapshot?.listedAccountIds.has(accountId) ?? false)
        : withRegistry(
            (registry) =>
              getLoadedChannelPluginEntryById(channelId, registry)
                ?.plugin.config.listAccountIds(getRuntimeConfig())
                .includes(accountId) ?? false,
          );
    },
    resolveRuntimeAccountId: (channelId, accountId) => {
      const matches = [...(channelStores.get(channelId)?.runtimes.keys() ?? [])].filter(
        (id) => normalizeAccountId(id) === accountId,
      );
      return matches.length === 1 ? matches[0] : undefined;
    },
    isAutoRestartScheduled: (channelId, accountId) =>
      pendingAutoRestarts.has(restartKey(channelId, accountId)),
    resetRestartAttempts: (channelId, accountId) => {
      restarts.delete(restartKey(channelId, accountId));
    },
    isHealthMonitorEnabled,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
