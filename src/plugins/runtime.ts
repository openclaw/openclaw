import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  AsyncWorkScope,
  isAsyncWorkScopeActiveHere,
  trackAsyncWork,
} from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  drainGlobalSingletonLifecycleState,
  resolveGlobalSingleton,
} from "../shared/global-singleton.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  isPluginCommandExecutionActiveHere,
  waitForPluginCommandExecutions,
} from "./command-execution-lock.js";
import type {
  PluginHostCleanupResult,
  PluginHostRegistryRetirement,
  PluginHostRetirementOptions,
} from "./host-hook-cleanup.types.js";
import {
  clearPluginHostRuntimeState,
  dispatchPluginAgentEventSubscriptions,
  preparePluginRunContextCleanup,
  publishPluginSessionSchedulerJobs,
} from "./host-hook-runtime.js";
import { notifyPluginHttpRoutesChanged } from "./http-route-owner.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { settlePreparedMessageToolCatalog } from "./prepared-message-tool-catalog.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  adoptPluginRegistryRecords,
  bindPluginRegistryGatewayOwner,
  getPluginRegistryResourceOwner,
  markPluginRegistryActive,
  markPluginRegistryRetired,
  preparePluginRegistryCacheShutdown,
  quiescePluginRegistry,
} from "./registry-lifecycle.js";
import type { PluginRegistry, PluginRegistryGatewayOwner } from "./registry-types.js";
import { getActivePluginChannelRegistrySnapshotFromState } from "./runtime-channel-state.js";
import { PluginRuntimeCloseRetainedError } from "./runtime-close-error.js";
import { PLUGIN_REGISTRY_STATE, type RegistryState } from "./runtime-state.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";
export { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";

const log = createSubsystemLogger("plugins/runtime");
const retirements = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRegistryRetirements"),
  () => new WeakMap<PluginRegistry, PluginHostRegistryRetirement>(),
);
type PluginRegistrySnapshot = ReturnType<typeof captureActivePluginRegistrySnapshot>;
type RegistryOwnerClose = {
  preparation: Promise<readonly unknown[]>;
  promise?: Promise<{
    memoryErrors: readonly unknown[];
    pluginFailures: PluginHostCleanupResult["failures"];
  }>;
  failure?: PluginRuntimeCloseRetainedError;
};
type RegistryOwner = {
  activeRegistry: PluginRegistry;
  closing?: RegistryOwnerClose;
};
const registryOwner = resolveGlobalSingleton<{ current?: RegistryOwner }>(
  Symbol.for("openclaw.pluginRegistryOwner"),
  () => ({}),
);
const loadMemoryRuntime = createLazyRuntimeModule(() => import("./memory-runtime.js"));

const state = resolveGlobalSingleton<RegistryState>(PLUGIN_REGISTRY_STATE, () => ({
  activeRegistry: null,
  activeVersion: 0,
  key: null,
  workspaceDir: null,
  runtimeSubagentMode: "default",
  importedPluginIds: new Set<string>(),
}));

const registryVersions = (state.registryVersions ??= new WeakMap());

function registryHasPluginHostCleanupWork(registry: PluginRegistry): boolean {
  return (
    registry.plugins.some((plugin) => plugin.status === "loaded" || plugin.status === "error") ||
    registry.sessionExtensions.length > 0 ||
    registry.runtimeLifecycles.length > 0 ||
    registry.agentEventSubscriptions.length > 0 ||
    registry.sessionSchedulerJobs.length > 0
  );
}

function isRegistryLive(registry: PluginRegistry): boolean {
  return state.activeRegistry === registry || registryOwner.current?.activeRegistry === registry;
}

const loadPluginHostCleanupRuntime = createLazyRuntimeModule(
  () => import("./host-hook-cleanup.js"),
);

// Completed observations must not retain the retiring or successor registry's scope.
function completedPluginRegistryRetirement(
  result: PluginHostCleanupResult,
): PluginHostRegistryRetirement {
  return async () => ({ ...result, failures: [...result.failures] });
}

/** Candidate retirement releases resources without changing committed session state. */
export function disposePluginRegistryInstances(
  registryView: PluginRegistry,
  retained?: PluginRegistry | (() => PluginRegistry | null),
  options?: {
    cleanupPersistentState?: boolean;
    beforeDispose?: () => Promise<void>;
    cfg?: OpenClawConfig;
    runContextCleanup?: ReturnType<typeof preparePluginRunContextCleanup>;
  },
): Promise<PluginHostCleanupResult> {
  const registry = getPluginRegistryResourceOwner(registryView);
  let wait = retirements.get(registry);
  if (!wait) {
    // Revocation and admitted-work drains may overlap a successor config publication.
    const cfg = options?.cfg ?? getRuntimeConfigSnapshot() ?? undefined;
    const runContextCleanup = options?.runContextCleanup ?? preparePluginRunContextCleanup();
    // Admit initialization before its first await so the caller drains through instance cleanup.
    const initialized = trackAsyncWork(() =>
      runContextCleanup(() =>
        Promise.resolve()
          .then(() => waitForPluginCommandExecutions(registry))
          .then(() => options?.beforeDispose?.())
          .then(loadPluginHostCleanupRuntime)
          .then(({ createPluginHostRegistryRetirement }) => {
            if (retirements.get(registry) !== wait) {
              return undefined;
            }
            if (options?.cleanupPersistentState && isRegistryLive(registry)) {
              retirements.delete(registry);
              return undefined;
            }
            markPluginRegistryRetired(registry);
            return createPluginHostRegistryRetirement({
              cfg,
              previousRegistry: registry,
              nextRegistry: typeof retained === "function" ? retained() : retained,
              skipPersistentSessionState: options?.cleanupPersistentState !== true,
              shouldCleanup: options?.cleanupPersistentState
                ? () => !isRegistryLive(registry)
                : undefined,
            });
          }),
      ),
    );
    // Cache initialization, not one caller's self-retirement acknowledgment.
    wait = async (observation) =>
      (await (await initialized)?.(observation)) ?? { cleanupCount: 0, failures: [] };
    retirements.set(registry, wait);
    // Epoch abort observers can reenter retirement and must receive this same completion.
    quiescePluginRegistry(registry);
    void pluginInstanceInvocation
      .exit(wait)
      .then((result) => {
        if (retirements.get(registry) === wait) {
          retirements.set(registry, completedPluginRegistryRetirement(result));
        }
      })
      .catch((error: unknown) => log.warn(`plugin host registry cleanup failed: ${String(error)}`));
  }
  return wait();
}

function preparePluginRegistryRetirement(
  registry: PluginRegistry | null,
  retained: () => PluginRegistry | null = () => state.activeRegistry,
  cleanupPersistentState = true,
) {
  if (!registry) {
    return undefined;
  }
  const runContextCleanup = preparePluginRunContextCleanup();
  const work = new AsyncWorkScope();
  const completion = createDeferredCore();
  const pending = (state.retiredRegistryCleanups ??= new Map());
  // Publish ownership before activation or retirement listeners can reenter clear.
  pending.set(completion.promise, { registry, work });
  const release = () => {
    pending.delete(completion.promise);
    completion.resolve();
  };
  const cleanup = async () => {
    try {
      await work.track(async () => {
        if (registryHasPluginHostCleanupWork(registry)) {
          await disposePluginRegistryInstances(registry, retained, {
            cleanupPersistentState,
            runContextCleanup,
          });
        } else {
          await waitForPluginCommandExecutions(registry);
          if (!isRegistryLive(registry)) {
            markPluginRegistryRetired(registry);
          }
        }
      });
    } finally {
      await work.drain();
    }
  };
  return {
    release,
    retireIfUnused() {
      if (isRegistryLive(registry)) {
        release();
        return;
      }
      // Close admission only after publishing its cleanup owner; admitted work still drains.
      quiescePluginRegistry(registry);
      void cleanup()
        .catch((error: unknown) => {
          log.warn(`plugin host registry cleanup failed: ${String(error)}`);
        })
        .then(release);
    },
  };
}

function retirePluginRegistryIfUnused(
  registry: PluginRegistry | null,
  retained: () => PluginRegistry | null = () => state.activeRegistry,
): void {
  preparePluginRegistryRetirement(registry, retained)?.retireIfUnused();
}

/** Lifecycle callers observe the same teardown that publication started. */
export async function waitForPluginRegistryRetirement(
  registry: PluginRegistry,
  options?: PluginHostRetirementOptions,
): Promise<PluginHostCleanupResult> {
  return (
    (await retirements.get(getPluginRegistryResourceOwner(registry))?.(options)) ?? {
      cleanupCount: 0,
      failures: [],
    }
  );
}

function syncPluginAgentEventBridge(): void {
  state.agentEventBridgeUnsubscribe?.();
  state.agentEventBridgeUnsubscribe = undefined;
  const registry = state.activeRegistry;
  if (!registry) {
    return;
  }
  const version = state.activeVersion;
  state.agentEventBridgeUnsubscribe = onAgentEvent((event) => {
    dispatchPluginAgentEventSubscriptions({
      registry,
      event,
      // The registry object can become active again after rollback. Its version
      // keeps already-dispatched callback authority bound to this exact cutover.
      isLive: () => state.activeRegistry === registry && state.activeVersion === version,
    });
  });
}

export function recordImportedPluginId(pluginId: string): void {
  state.importedPluginIds.add(pluginId);
}

export function setActivePluginRegistry(
  registry: PluginRegistry,
  cacheKey?: string,
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable" = "default",
  workspaceDir?: string,
) {
  installActivePluginRegistry({
    activeRegistry: registry,
    key: cacheKey ?? null,
    runtimeSubagentMode,
    workspaceDir: workspaceDir ?? null,
  });
}

export function stageActivePluginRegistry(
  registry: PluginRegistry,
  cacheKey: string | null,
  runtimeSubagentMode: RegistryState["runtimeSubagentMode"],
  workspaceDir?: string,
): number {
  return installActivePluginRegistry({
    activeRegistry: registry,
    key: cacheKey,
    runtimeSubagentMode,
    workspaceDir: workspaceDir ?? null,
    retirePrevious: false,
  });
}

export function commitStagedPluginRegistry(
  previousRegistry: PluginRegistry | null,
  registry: PluginRegistry,
): void {
  if (state.activeRegistry === registry) {
    retirePluginRegistryIfUnused(previousRegistry);
  }
}

export function captureActivePluginRegistrySnapshot() {
  return {
    activeRegistry: state.activeRegistry,
    key: state.key,
    runtimeSubagentMode: state.runtimeSubagentMode,
    workspaceDir: state.workspaceDir,
  };
}

export function restoreActivePluginRegistrySnapshot(snapshot: PluginRegistrySnapshot): void {
  installActivePluginRegistry(snapshot);
}

/** Rolls back a staged registry without reactivating the prior committed generation. */
export function rollbackStagedPluginRegistry(
  snapshot: PluginRegistrySnapshot,
  retainedRegistry = snapshot.activeRegistry,
): number {
  const candidate = state.activeRegistry;
  const retirement =
    candidate !== snapshot.activeRegistry
      ? preparePluginRegistryRetirement(candidate, () => retainedRegistry, false)
      : undefined;
  try {
    const installedVersion = installActivePluginRegistry({
      ...snapshot,
      // Staging never retired the prior registry. Reactivating it here would mint a
      // new epoch and revoke closures that remained authoritative through rollback.
      activateRegistry: false,
      retirePrevious: false,
    });
    // The reloading Gateway need not own the process-default projection.
    adoptPluginRegistryRecords(retainedRegistry);
    return installedVersion;
  } finally {
    retirement?.retireIfUnused();
  }
}

function installActivePluginRegistry(
  params: PluginRegistrySnapshot & {
    retirePrevious?: boolean;
    activateRegistry?: boolean;
  },
): number {
  const previousSnapshot = captureActivePluginRegistrySnapshot();
  const registry = params.activeRegistry;
  const retirement =
    previousSnapshot.activeRegistry !== registry
      ? preparePluginRegistryRetirement(previousSnapshot.activeRegistry)
      : undefined;
  state.activeRegistry = registry;
  const installedVersion = ++state.activeVersion;
  if (registry) {
    registryVersions.set(registry, installedVersion);
  }
  state.key = params.key;
  state.workspaceDir = params.workspaceDir;
  state.runtimeSubagentMode = params.runtimeSubagentMode;
  if (registry && previousSnapshot.activeRegistry !== registry) {
    // Retained instances can return with this registry; its old retirement selection cannot.
    retirements.delete(registry);
  }
  try {
    if (params.activateRegistry !== false) {
      markPluginRegistryActive(registry);
    } else {
      adoptPluginRegistryRecords(registry);
    }
    if (registry) {
      publishPluginSessionSchedulerJobs(registry);
      settlePreparedMessageToolCatalog(registry, installedVersion);
    } else {
      settlePreparedMessageToolCatalog();
    }
    syncPluginAgentEventBridge();
    notifyPluginHttpRoutesChanged();
  } catch (error) {
    if (params.retirePrevious === false) {
      rollbackStagedPluginRegistry(previousSnapshot);
    }
    throw error;
  } finally {
    // A stage preserves its predecessor for rollback. Recursive publication is best effort.
    if (params.retirePrevious === false) {
      retirement?.release();
    } else {
      retirement?.retireIfUnused();
    }
  }
  return installedVersion;
}

/** One Gateway owns the process registry; overlapping Gateways are best effort. */
export function createPluginRegistryOwner(registry: PluginRegistry, workspaceDir?: string) {
  void workspaceDir;
  const owner: RegistryOwner = { activeRegistry: registry };
  registryOwner.current = owner;
  const gatewayOwner: PluginRegistryGatewayOwner = {
    current: () =>
      registryOwner.current === owner && !owner.closing ? owner.activeRegistry : undefined,
  };
  bindPluginRegistryGatewayOwner(registry, gatewayOwner);
  const beginClose = (): RegistryOwnerClose => {
    if (owner.closing && !owner.closing.failure) {
      return owner.closing;
    }
    const closing: RegistryOwnerClose = {
      preparation: Promise.resolve().then(async () => {
        const previous = owner.activeRegistry;
        try {
          if (
            !previous.memoryCapabilities.some(
              ({ capability }) => capability.runtime || capability.providerRuntime,
            )
          ) {
            return [];
          }
          const { prepareMemoryRuntimeReload } = await loadMemoryRuntime();
          const memory = prepareMemoryRuntimeReload(previous, createEmptyPluginRegistry());
          const { errors } = await memory.close();
          memory.commit();
          return errors;
        } catch (error) {
          closing.failure = new PluginRuntimeCloseRetainedError(error);
          throw closing.failure;
        }
      }),
    };
    // Install the single-flight owner before preparation can invoke plugin code.
    owner.closing = closing;
    return closing;
  };
  return {
    get registry() {
      return owner.activeRegistry;
    },
    publish(next: PluginRegistry) {
      if (owner.closing || registryOwner.current !== owner || state.activeRegistry !== next) {
        throw new Error("Plugin registry publication requires a live owner and active candidate");
      }
      const previous = owner.activeRegistry;
      owner.activeRegistry = next;
      bindPluginRegistryGatewayOwner(next, gatewayOwner);
      notifyPluginHttpRoutesChanged();
      retirePluginRegistryIfUnused(previous, () =>
        registryOwner.current === owner ? owner.activeRegistry : null,
      );
    },
    prepareClose() {
      return beginClose().preparation;
    },
    close(
      this: void,
      onRetirement?: (
        retire: () => Promise<PluginHostCleanupResult>,
      ) => Promise<void | PluginHostCleanupResult>,
    ) {
      const closing = beginClose();
      closing.promise ??= closing.preparation.then(async (memoryErrors) => {
        const previous = owner.activeRegistry;
        // Memory preparation can be retried; disposal still joins inventory cleanup.
        let retirement: Promise<PluginHostCleanupResult> | undefined;
        const retire = () =>
          (retirement ??= Promise.resolve().then(async () => {
            if (registryOwner.current === owner) {
              registryOwner.current = undefined;
            }
            await clearActivePluginRegistry(previous);
            return await waitForPluginRegistryRetirement(previous);
          }));
        const cleanup = await onRetirement?.(retire);
        const registryCleanup = await retire();
        return { memoryErrors, pluginFailures: (cleanup ?? registryCleanup).failures };
      });
      return closing.promise;
    },
  };
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return state.activeRegistry;
}

export function getActivePluginRegistryWorkspaceDir(): string | undefined {
  return state.workspaceDir ?? undefined;
}

export function requireActivePluginRegistry(): PluginRegistry {
  const registry = getPluginRegistryForContext();
  if (registry) {
    return registry;
  }
  state.activeRegistry = createEmptyPluginRegistry();
  markPluginRegistryActive(state.activeRegistry);
  state.activeVersion += 1;
  registryVersions.set(state.activeRegistry, state.activeVersion);
  settlePreparedMessageToolCatalog(state.activeRegistry, state.activeVersion);
  syncPluginAgentEventBridge();
  return state.activeRegistry;
}

/** Binds unchanged direct SDK facades to the registry currently running synchronous register(). */
export function withPluginRegistrationContext<T>(
  registry: PluginRegistry,
  pluginId: string,
  run: () => T,
  context?: Pick<
    NonNullable<RegistryState["registrationContext"]>,
    "registerMemoryCapability" | "instance"
  >,
): T {
  const previous = state.registrationContext;
  state.registrationContext = { registry, pluginId, ...context };
  try {
    return run();
  } finally {
    state.registrationContext = previous;
  }
}

export function getPluginRegistrationContext() {
  return state.registrationContext;
}

/** Keeps direct registration facades owned by the plugin whose synchronous register() is running. */
export function resolveDirectPluginRegistrationOwner(ownerPluginId?: string): string | undefined {
  return state.registrationContext?.pluginId ?? ownerPluginId;
}

/** A failed plugin must not displace an earlier plugin's builder-local contribution. */
export function assertDirectPluginRegistrationReplacement(
  existingOwnerPluginId: string | undefined,
  capability: string,
): void {
  const pluginId = state.registrationContext?.pluginId;
  if (pluginId && existingOwnerPluginId !== pluginId) {
    throw new Error(`${capability} already registered by ${existingOwnerPluginId || "core"}`);
  }
}

export function getActivePluginChannelRegistry(): PluginRegistry | null {
  return getActivePluginChannelRegistrySnapshotFromState().registry as PluginRegistry | null;
}

export function getActivePluginChannelRegistryVersion(): number {
  return getActivePluginChannelRegistrySnapshotFromState().version;
}

export function requireActivePluginChannelRegistry(): PluginRegistry {
  return getActivePluginChannelRegistry() ?? requireActivePluginRegistry();
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}

export function getActivePluginRegistryVersion(): number {
  return state.activeVersion;
}

/** Includes earlier cached or failed imports; metadata-only bundles never import runtime code. */
export function listImportedRuntimePluginIds(): string[] {
  const imported = new Set(state.importedPluginIds);
  for (const plugin of state.activeRegistry?.plugins ?? []) {
    if (plugin.status === "loaded" && plugin.format !== "bundle") {
      imported.add(plugin.id);
    }
  }
  return [...imported].toSorted((left, right) => left.localeCompare(right));
}

function clearActivePluginRegistryState(): PluginRegistry | null {
  const previousRegistry = state.activeRegistry;
  state.activeRegistry = null;
  state.activeVersion += 1;
  state.key = null;
  state.workspaceDir = null;
  state.runtimeSubagentMode = "default";
  settlePreparedMessageToolCatalog();
  syncPluginAgentEventBridge();
  return previousRegistry;
}

export async function clearActivePluginRegistry(
  previousRegistry: PluginRegistry | null = state.activeRegistry,
): Promise<void> {
  const cfg = getRuntimeConfigSnapshot() ?? undefined;
  const runContextCleanup = preparePluginRunContextCleanup();
  // Final custody can end after projection was cleared; never erase an unrelated successor.
  if (state.activeRegistry === previousRegistry) {
    clearActivePluginRegistryState();
  }
  const clearVersion = state.activeVersion;
  const clearRegistries = (state.commandRegistryClearRegistries ??= new Map());
  if (previousRegistry) {
    clearRegistries.set(previousRegistry, (clearRegistries.get(previousRegistry) ?? 0) + 1);
  }
  const previousTail = state.commandRegistryClearTail ?? Promise.resolve();
  const completion = previousTail
    .catch(() => undefined)
    .then(async () => {
      const cleanupWork = new AsyncWorkScope();
      try {
        if (previousRegistry) {
          await waitForPluginCommandExecutions(previousRegistry);
          if (registryHasPluginHostCleanupWork(previousRegistry)) {
            // Gateway shutdown releases runtime resources; only disable/removal erases session state.
            await cleanupWork.track(() =>
              disposePluginRegistryInstances(previousRegistry, () => state.activeRegistry, {
                cfg,
                runContextCleanup,
              }),
            );
          }
        }
      } finally {
        // A cleanup timeout advances other hooks, but its actual descendants still own state.
        await cleanupWork.drain();
        // Earlier hot publications returned before their retired owners finished cleanup.
        while (state.retiredRegistryCleanups?.size) {
          await Promise.all(state.retiredRegistryCleanups.keys());
        }
        // A handler-triggered clear may publish a successor before its own drain settles.
        // Never let the retired generation's tail erase that successor's host state.
        if (state.activeRegistry === null && state.activeVersion === clearVersion) {
          try {
            await drainGlobalSingletonLifecycleState("plugin-registry");
          } finally {
            clearPluginHostRuntimeState();
          }
        }
      }
    })
    .finally(() => {
      if (previousRegistry) {
        const remaining = (clearRegistries.get(previousRegistry) ?? 1) - 1;
        if (remaining === 0) {
          clearRegistries.delete(previousRegistry);
        } else {
          clearRegistries.set(previousRegistry, remaining);
        }
      }
    });
  state.commandRegistryClearTail = completion.catch((error: unknown) => {
    log.warn(`plugin registry clear failed: ${String(error)}`);
  });
  // Publish the clear owner and tail before synchronous retirement listeners can reenter.
  quiescePluginRegistry(previousRegistry);
  // Reentrant commands and retired cleanup callbacks must not await their own pending attempt.
  if (
    [...clearRegistries.keys()].some(isPluginCommandExecutionActiveHere) ||
    [...(state.retiredRegistryCleanups?.values() ?? [])].some(
      ({ registry, work }) =>
        isPluginCommandExecutionActiveHere(registry) || isAsyncWorkScopeActiveHere(work),
    )
  ) {
    return;
  }
  await completion;
}

export async function prepareActivePluginRegistryShutdown(): Promise<void> {
  await Promise.all([
    loadPluginHostCleanupRuntime(),
    loadMemoryRuntime(),
    preparePluginRegistryCacheShutdown(),
  ]);
}

export function resetPluginRuntimeStateForTest(): void {
  state.registrationContext = undefined;
  registryOwner.current = undefined;
  markPluginRegistryRetired(clearActivePluginRegistryState());
  state.importedPluginIds.clear();
  void drainGlobalSingletonLifecycleState("plugin-registry");
  // Keep the synchronous test reset aligned with clearActivePluginRegistry.
  clearPluginHostRuntimeState();
  clearPluginMetadataLifecycleCaches();
}
