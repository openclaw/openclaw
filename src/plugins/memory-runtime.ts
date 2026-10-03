import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { MemorySearchManager } from "../memory-host-sdk/host/types.js";
import { resolveUserPath } from "../utils.js";
import { normalizePluginsConfig } from "./config-state.js";
import { withPluginHostCleanupTimeout } from "./host-hook-cleanup-timeout.js";
import { loadPluginRegistryHandle } from "./loader.js";
import { assertMemoryCallerCurrent, isHostMemoryAudience } from "./memory-audience.js";
import { adaptLegacyMemoryProvider, bindMemoryProvider } from "./memory-provider-adapter.js";
import type {
  ActiveMemoryProviderResult,
  MemoryCallerContext,
  MemoryProviderCapabilities,
  MemoryProviderOpenParams,
} from "./memory-provider-types.js";
import {
  getMemoryRuntime,
  getMemoryProviderRuntime,
  getMemoryCapabilityRegistration,
  resolveMemoryCapabilityRegistration,
  setStandaloneMemoryManagerActive,
  setStandaloneMemoryOwner,
} from "./memory-state.js";
import { getPluginValueInstance, runPluginCleanup } from "./plugin-instance-scope.js";
import { runPluginCleanupScope } from "./plugin-invocation-scope.js";
import type {
  MemoryPluginRuntime,
  MemoryProviderRuntime,
  RegisteredMemorySearchManager,
} from "./registry-contribution-types.js";
import type { PluginRegistry } from "./registry-types.js";

type MemorySearchAuthorization = Parameters<
  NonNullable<MemoryPluginRuntime["authorizeSearchHits"]>
>[0];
type WorkspaceMemoryPathClassification = Parameters<
  NonNullable<MemoryPluginRuntime["classifyWorkspaceMemoryPaths"]>
>[0];
type MemoryRuntimeOwner = {
  runtime?: MemoryPluginRuntime;
  providerRuntime?: MemoryProviderRuntime;
  providerId?: string;
  standalone?: true;
  searchRuntimeRegistered?: boolean;
  error?: string;
};
type AnyMemoryRuntime = MemoryPluginRuntime | MemoryProviderRuntime;
const enrolledStandaloneMemoryRuntimes = new WeakSet<AnyMemoryRuntime>();
let standaloneMemoryRegistrySlot:
  | {
      runtime?: MemoryPluginRuntime;
      providerRuntime?: MemoryProviderRuntime;
      retiredRuntimes: Set<AnyMemoryRuntime>;
    }
  | undefined;
const registeredMemoryManagerAdapters = new WeakMap<
  RegisteredMemorySearchManager,
  MemorySearchManager
>();

function normalizeRegisteredMemoryManager(
  manager: RegisteredMemorySearchManager,
): MemorySearchManager {
  const existing = registeredMemoryManagerAdapters.get(manager);
  if (existing) {
    return existing;
  }
  const readFile: MemorySearchManager["readFile"] = async (params) => {
    const result = await manager.readFile(params);
    return result.status === "ok" || result.status === "not_found"
      ? result
      : { ...result, status: "ok" };
  };
  // A neutral target permits wrapped methods even when the manager is frozen.
  const adapter = new Proxy(
    { readFile },
    {
      get(_target, property) {
        if (property === "readFile") {
          return readFile;
        }
        const value = Reflect.get(manager, property, manager) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        // Registered managers may use class/private state, so calls retain the target receiver.
        return value.bind(manager);
      },
    },
    // SAFETY: readFile is canonical; every other member is forwarded from the manager.
  ) as MemorySearchManager;
  registeredMemoryManagerAdapters.set(manager, adapter);
  return adapter;
}

/** Resolves the configured memory slot to the single runtime plugin that may load memory. */
function resolveMemoryRuntimePluginIds(config: OpenClawConfig): string[] {
  const plugins = normalizePluginsConfig(config.plugins);
  const pluginId = plugins.slots.memory;
  if (!plugins.enabled || !pluginId) {
    return [];
  }
  if (plugins.deny.includes(pluginId) || plugins.entries[pluginId]?.enabled === false) {
    return [];
  }
  return [pluginId];
}

function listCurrentMemoryRuntimes(): AnyMemoryRuntime[] {
  const runtimes = new Set(standaloneMemoryRegistrySlot?.retiredRuntimes);
  const current = getMemoryRuntime();
  if (current) {
    runtimes.add(current);
  }
  const providerRuntime = getMemoryProviderRuntime();
  if (providerRuntime) {
    runtimes.add(providerRuntime);
  }
  if (standaloneMemoryRegistrySlot?.providerRuntime) {
    runtimes.add(standaloneMemoryRegistrySlot.providerRuntime);
  }
  if (standaloneMemoryRegistrySlot?.runtime) {
    runtimes.add(standaloneMemoryRegistrySlot.runtime);
  }
  return [...runtimes];
}

function assertMemoryProviderRuntime(runtime: MemoryProviderRuntime | undefined): void {
  if (runtime !== undefined && (!runtime || typeof runtime.open !== "function")) {
    throw new Error("memory providerRuntime must implement open");
  }
}

function isValidMemoryProviderCapabilities(
  capabilities: MemoryProviderCapabilities | undefined,
): capabilities is MemoryProviderCapabilities {
  return (
    Array.isArray(capabilities?.sources) &&
    capabilities.sources.length > 0 &&
    capabilities.sources.every((source) => source === "memory" || source === "sessions") &&
    typeof capabilities.pagination === "boolean" &&
    Array.isArray(capabilities.candidates) &&
    capabilities.candidates.every((kind) => kind === "trigger" || kind === "project") &&
    typeof capabilities.projectFilter === "boolean"
  );
}

function ensureMemoryRuntime(params?: {
  cfg: OpenClawConfig;
  agentId: string;
}): MemoryRuntimeOwner | undefined {
  const current = getMemoryRuntime();
  const currentProviderRuntime = getMemoryProviderRuntime();
  assertMemoryProviderRuntime(currentProviderRuntime);
  if (current || currentProviderRuntime || !params) {
    return current || currentProviderRuntime
      ? {
          runtime: current,
          providerRuntime: currentProviderRuntime,
          providerId: getMemoryCapabilityRegistration()?.pluginId,
          searchRuntimeRegistered: true,
        }
      : undefined;
  }
  const onlyPluginIds = resolveMemoryRuntimePluginIds(params.cfg);
  if (onlyPluginIds.length === 0) {
    return undefined;
  }
  const dir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const workspaceDir = typeof dir === "string" && dir.trim() ? resolveUserPath(dir) : undefined;
  const registry = loadPluginRegistryHandle({
    config: params.cfg,
    onlyPluginIds,
    workspaceDir,
    activate: false,
  });
  const registration = resolveMemoryCapabilityRegistration(registry.memoryCapabilities);
  const runtime = registration?.capability.runtime;
  const registeredProviderRuntime = registration?.capability.providerRuntime;
  assertMemoryProviderRuntime(registeredProviderRuntime);
  const record =
    runtime || registeredProviderRuntime
      ? undefined
      : registry.plugins.find((entry) => entry.id === onlyPluginIds[0]);
  // Only a successfully loaded slot owner can establish that search is not provided.
  const owner: MemoryRuntimeOwner | undefined =
    runtime || registeredProviderRuntime
      ? {
          runtime,
          providerRuntime: registeredProviderRuntime,
          providerId: registration?.pluginId,
          standalone: true,
          searchRuntimeRegistered: true,
        }
      : record?.status === "error"
        ? { error: record.error ?? `Memory plugin "${record.id}" failed to load` }
        : record?.status === "loaded" && record.memorySlotSelected === true
          ? { searchRuntimeRegistered: false }
          : undefined;
  const previousSlot = standaloneMemoryRegistrySlot;
  if (
    previousSlot?.runtime === runtime &&
    previousSlot?.providerRuntime === registeredProviderRuntime
  ) {
    return owner;
  }
  const retiredRuntimes = new Set(previousSlot?.retiredRuntimes);
  if (previousSlot?.runtime) {
    retiredRuntimes.add(previousSlot.runtime);
  }
  if (previousSlot?.providerRuntime) {
    retiredRuntimes.add(previousSlot.providerRuntime);
  }
  standaloneMemoryRegistrySlot = {
    runtime,
    providerRuntime: registeredProviderRuntime,
    retiredRuntimes,
  };
  setStandaloneMemoryOwner(
    registration && (runtime || registeredProviderRuntime)
      ? { pluginId: registration.pluginId, native: registeredProviderRuntime !== undefined }
      : undefined,
  );
  for (const ownedRuntime of [owner?.runtime, owner?.providerRuntime]) {
    if (ownedRuntime && !enrolledStandaloneMemoryRuntimes.has(ownedRuntime)) {
      const lifecycle = getPluginValueInstance(ownedRuntime)?.lifecycle;
      if (lifecycle) {
        lifecycle.onDispose(() => {
          const slot = standaloneMemoryRegistrySlot;
          slot?.retiredRuntimes.delete(ownedRuntime);
          if (slot?.runtime === ownedRuntime) {
            delete slot.runtime;
          }
          if (slot?.providerRuntime === ownedRuntime) {
            delete slot.providerRuntime;
          }
        });
        // Selection resets do not end the instance lifetime or remove its existing pruning callback.
        enrolledStandaloneMemoryRuntimes.add(ownedRuntime);
      }
    }
  }
  return owner;
}

/** Returns the active plugin-backed memory search manager for an agent. */
export async function getActiveMemorySearchManagerCore(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status" | "cli";
  inspectSources?: boolean;
}) {
  const owner = ensureMemoryRuntime(params);
  if (!owner?.runtime) {
    return {
      manager: null,
      error: owner?.error ?? "memory plugin unavailable",
      searchRuntimeRegistered: owner?.searchRuntimeRegistered,
    };
  }
  if (owner.standalone) {
    setStandaloneMemoryManagerActive(true);
  }
  const result = await owner.runtime.getMemorySearchManager(params);
  return {
    ...result,
    manager: result.manager ? normalizeRegisteredMemoryManager(result.manager) : null,
    searchRuntimeRegistered: true,
  };
}

/** Applies the selected memory plugin's authorization policy to raw search hits. */
export async function authorizeActiveMemorySearchHits(
  params: MemorySearchAuthorization,
): Promise<MemorySearchAuthorization["hits"]> {
  const owner = ensureMemoryRuntime(params);
  // Session artifacts need plugin-owned identity mapping before they are safe
  // to expose. Runtimes without that capability may still return memory hits.
  return owner?.runtime?.authorizeSearchHits
    ? await owner.runtime.authorizeSearchHits(params)
    : params.hits.filter((hit) => hit.source !== "sessions");
}

/**
 * Reports whether the selected slot owner registers the provider-neutral runtime.
 * Consumers keep their legacy manager path for every other owner, so this resolves
 * the owner the same way that path would without opening a manager.
 */
export function isActiveMemoryProviderNative(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): boolean {
  return ensureMemoryRuntime(params)?.providerRuntime !== undefined;
}

/** Resolves one selected provider; native provider failures never retry through legacy storage. */
export async function getActiveMemoryProviderCore(
  params: MemoryProviderOpenParams,
): Promise<ActiveMemoryProviderResult> {
  if (typeof params.context.assertCurrent !== "function") {
    throw new Error("memory provider requires caller authority with assertCurrent");
  }
  if (
    params.context.authority.kind === "session" &&
    params.context.authority.audience !== undefined &&
    !isHostMemoryAudience(params.context.authority.audience)
  ) {
    throw new Error("memory provider requires a host-minted memory audience");
  }
  // The audience is part of the caller's authority: a stale grant never reaches open(), and
  // the provider's own `context.assertCurrent()` before I/O rejects it too.
  const context: MemoryCallerContext = {
    ...params.context,
    assertCurrent: () => assertMemoryCallerCurrent(params.context),
  };
  const openParams: MemoryProviderOpenParams = { ...params, context };
  context.assertCurrent();
  const owner = ensureMemoryRuntime(params);
  if (!owner?.runtime && !owner?.providerRuntime) {
    return { provider: null, error: owner?.error ?? "memory plugin unavailable" };
  }
  if (owner.standalone) {
    setStandaloneMemoryManagerActive(true);
  }
  const providerId = owner.providerId ?? normalizePluginsConfig(params.cfg.plugins).slots.memory;
  if (typeof providerId !== "string" || !providerId) {
    return { provider: null, error: "memory provider identity unavailable" };
  }
  const adapter = owner.providerRuntime ? "native" : "legacy";
  const result = owner.providerRuntime
    ? await owner.providerRuntime.open(openParams)
    : await adaptLegacyMemoryProvider(owner.runtime!, providerId, openParams);
  try {
    context.assertCurrent();
    if (
      result.provider &&
      (typeof result.provider.search !== "function" ||
        typeof result.provider.get !== "function" ||
        typeof result.provider.health !== "function" ||
        typeof result.provider.close !== "function" ||
        !isValidMemoryProviderCapabilities(result.provider.capabilities) ||
        result.provider.capabilities.candidates.length > 0 !==
          (typeof result.provider.candidates === "function"))
    ) {
      throw new Error(
        "memory provider must implement search, get, health, close, and valid capabilities with matching candidates",
      );
    }
  } catch (error) {
    if (result.provider && typeof result.provider.close === "function") {
      await runPluginCleanup(result.provider, () => result.provider!.close());
    }
    throw error;
  }
  return {
    ...result,
    providerId,
    adapter,
    provider: result.provider
      ? bindMemoryProvider(
          result.provider,
          providerId,
          params.context,
          owner.providerRuntime ?? owner.runtime,
        )
      : null,
  };
}

/** Classifies workspace memory paths through the selected memory plugin's provenance owner. */
export async function classifyActiveMemoryWorkspacePaths(
  params: WorkspaceMemoryPathClassification,
): Promise<
  | { status: "unavailable" }
  | { status: "unsupported" }
  | {
      status: "classified";
      classifications: Array<{ relativePath: string; originClass: string }>;
    }
> {
  const owner = ensureMemoryRuntime(params);
  if (!owner?.runtime) {
    return { status: "unavailable" };
  }
  if (
    !owner.runtime.classifyWorkspaceMemoryPaths ||
    (params.readSources !== undefined && !owner.runtime.supportsWorkspaceMemoryReadSources)
  ) {
    return { status: "unsupported" };
  }
  const classifications = await owner.runtime.classifyWorkspaceMemoryPaths(params);
  return { status: "classified", classifications };
}

/** Resolves current memory backend config without constructing a manager. */
export function resolveActiveMemoryBackendConfig(params: { cfg: OpenClawConfig; agentId: string }) {
  const owner = ensureMemoryRuntime(params);
  if (owner?.providerRuntime) {
    const providerId =
      owner.providerId ?? normalizePluginsConfig(params.cfg.plugins).slots.memory?.trim();
    return providerId ? ({ backend: "provider-runtime", providerId } as const) : null;
  }
  return owner?.runtime ? owner.runtime.resolveMemoryBackendConfig(params) : null;
}

/** Closes all active plugin-backed memory search managers. */
export async function closeActiveMemorySearchManagersCore(cfg?: OpenClawConfig): Promise<void> {
  void cfg;
  // CLI cleanup retires registries first; teardown remains admitted until instance disposal.
  await Promise.all(
    listCurrentMemoryRuntimes().map(async (runtime) =>
      runPluginCleanup(runtime, () => runtime.closeAllMemorySearchManagers?.()),
    ),
  );
  standaloneMemoryRegistrySlot?.retiredRuntimes.clear();
  setStandaloneMemoryManagerActive(false);
}

/** Closes the plugin-backed memory search manager for one agent. */
export async function closeActiveMemorySearchManagerCore(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  await Promise.all(
    listCurrentMemoryRuntimes().map(async (runtime) =>
      runPluginCleanup(runtime, () => runtime.closeMemorySearchManager?.(params)),
    ),
  );
}

function resetStandaloneMemoryRegistrySlot(): void {
  standaloneMemoryRegistrySlot = undefined;
  setStandaloneMemoryOwner(undefined);
  setStandaloneMemoryManagerActive(false);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.memoryRuntimeTestApi")] = {
    resetStandaloneMemoryRegistrySlot,
  };
}

type MemoryRuntimeRegistry = Pick<PluginRegistry, "memoryCapabilities" | "embeddingProviders">;

/** Prepare memory consumers before any changed plugin loses ordinary call admission. */
export function prepareMemoryRuntimeReload(
  previousRegistry: MemoryRuntimeRegistry,
  nextRegistry: MemoryRuntimeRegistry,
) {
  const runtimes = (registry: MemoryRuntimeRegistry) =>
    new Set(
      registry.memoryCapabilities.flatMap(({ capability }) =>
        [capability.runtime, capability.providerRuntime].filter(
          (runtime): runtime is AnyMemoryRuntime => runtime !== undefined,
        ),
      ),
    );
  const nextRuntimes = runtimes(nextRegistry);
  const nextAdapters = new Set(nextRegistry.embeddingProviders.map(({ provider }) => provider));
  const retiringEmbeddingProviders = previousRegistry.embeddingProviders
    .map(({ provider }) => provider)
    .filter((provider) => !nextAdapters.has(provider));
  const prepared: Array<{
    runtime: AnyMemoryRuntime;
    handle: ReturnType<NonNullable<MemoryPluginRuntime["prepareReload"]>>;
  }> = [];
  let cleanup: Promise<{ errors: readonly unknown[] }> | undefined;
  const resume = (committed: boolean, retained = nextRegistry) => {
    const failures: unknown[] = [];
    const retainedRuntimes = runtimes(retained);
    for (const { runtime, handle } of prepared) {
      if (!committed || retainedRuntimes.has(runtime)) {
        try {
          runPluginCleanup(runtime, () => handle.resume());
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Memory reload admission recovery failed");
    }
  };
  try {
    for (const runtime of runtimes(previousRegistry)) {
      const retireRuntime = !nextRuntimes.has(runtime);
      if (!retireRuntime && retiringEmbeddingProviders.length === 0) {
        continue;
      }
      const handle = runPluginCleanup(runtime, () => {
        if (runtime.prepareReload) {
          return runtime.prepareReload({ retireRuntime, retiringEmbeddingProviders });
        }
        // Legacy runtimes cannot identify dependent managers. Close them conservatively
        // when an adapter retires so cached managers do not retain its revoked callbacks.
        if (runtime.closeAllMemorySearchManagers) {
          return { drain: () => runtime.closeAllMemorySearchManagers!(), resume() {} };
        }
        return undefined;
      });
      if (handle) {
        prepared.push({ runtime, handle });
      }
    }
  } catch (error) {
    try {
      resume(false);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Memory reload preparation failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  // A deadline limits an operation's observation, never the cleanup retained by
  // the Gateway owner. Final shutdown must join close() before disposing shared state.
  const close = () => {
    if (!cleanup) {
      cleanup = runPluginCleanupScope(
        [...prepared.map(({ runtime }) => runtime), ...retiringEmbeddingProviders],
        () =>
          Promise.allSettled(
            prepared.map(({ runtime, handle }) =>
              Promise.resolve().then(() =>
                runPluginCleanup(runtime, async () => {
                  // Admission stays outside this catch; only admitted teardown reports faults.
                  try {
                    return await handle.drain();
                  } catch (error) {
                    return { errors: [error] };
                  }
                }),
              ),
            ),
          ),
      ).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new AggregateError(failures, failures.map(formatErrorMessage).join("; "));
        }
        return {
          errors: results.flatMap((result) =>
            result.status === "fulfilled" ? (result.value?.errors ?? []) : [],
          ),
        };
      });
    }
    return cleanup;
  };
  return {
    drain: () => withPluginHostCleanupTimeout("memory managers", close),
    close,
    commit: (retained = nextRegistry) => resume(true, retained),
    rollback: () => resume(false),
  };
}
