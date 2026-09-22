import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  LegacyMemoryReadResult,
  MemoryReadResult,
  MemorySearchManager,
} from "../memory-host-sdk/host/types.js";
import { resolveUserPath } from "../utils.js";
import { normalizePluginsConfig } from "./config-state.js";
import { withPluginHostCleanupTimeout } from "./host-hook-cleanup-timeout.js";
import { loadPluginRegistryHandle } from "./loader.js";
import {
  getMemoryRuntime,
  resolveMemoryCapabilityRegistration,
  setStandaloneMemoryManagerActive,
} from "./memory-state.js";
import { getPluginValueInstance, runPluginCleanup } from "./plugin-instance-scope.js";
import type {
  MemoryPluginRuntime,
  RegisteredMemorySearchManager,
} from "./registry-contribution-types.js";
import type { PluginRegistry } from "./registry-types.js";

type MemoryRuntime = NonNullable<
  PluginRegistry["memoryCapabilities"][number]["capability"]["runtime"]
>;
type MemorySearchAuthorization = Parameters<
  NonNullable<MemoryPluginRuntime["authorizeSearchHits"]>
>[0];
type WorkspaceMemoryPathClassification = Parameters<
  NonNullable<MemoryPluginRuntime["classifyWorkspaceMemoryPaths"]>
>[0];
type MemoryRuntimeOwner = { runtime: MemoryRuntime; standalone?: true };
const enrolledStandaloneMemoryRuntimes = new WeakSet<MemoryRuntime>();
let standaloneMemoryRegistrySlot:
  | { runtime?: MemoryRuntime; retiredRuntimes: Set<MemoryRuntime> }
  | undefined;
const registeredMemoryManagerAdapters = new WeakMap<
  RegisteredMemorySearchManager,
  MemorySearchManager
>();

function normalizeRegisteredMemoryReadResult(
  result: LegacyMemoryReadResult | MemoryReadResult,
): MemoryReadResult {
  if (result.status === "ok" || result.status === "not_found") {
    return result;
  }
  return { ...result, status: "ok" };
}

function normalizeRegisteredMemoryManager(
  manager: RegisteredMemorySearchManager,
): MemorySearchManager {
  const existing = registeredMemoryManagerAdapters.get(manager);
  if (existing) {
    return existing;
  }
  const readFile: MemorySearchManager["readFile"] = async (params) =>
    normalizeRegisteredMemoryReadResult(await manager.readFile(params));
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
export function resolveMemoryRuntimePluginIds(config: OpenClawConfig): string[] {
  const plugins = normalizePluginsConfig(config.plugins);
  const memorySlot = plugins.slots.memory;
  if (!plugins.enabled || typeof memorySlot !== "string" || memorySlot.trim().length === 0) {
    return [];
  }
  const pluginId = memorySlot.trim();
  if (plugins.deny.includes(pluginId) || plugins.entries[pluginId]?.enabled === false) {
    return [];
  }
  return [pluginId];
}

function resolveMemoryRuntimeWorkspaceDir(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  const dir = resolveAgentWorkspaceDir(cfg, agentId);
  if (typeof dir !== "string" || !dir.trim()) {
    return undefined;
  }
  return resolveUserPath(dir);
}

/**
 * The loader records an import or registration failure on the plugin's record and rolls back its
 * contributions instead of throwing, so a slot owner that failed to load is otherwise
 * indistinguishable from one that loaded cleanly and registered nothing.
 */
function resolveOwnerLoadError(
  registry: PluginRegistry,
  onlyPluginIds: readonly string[],
): string | undefined {
  for (const pluginId of onlyPluginIds) {
    const record = registry.plugins.find((candidate) => candidate.id === pluginId);
    if (record?.status === "error") {
      return record.error ?? `plugin ${pluginId} failed to load`;
    }
  }
  return undefined;
}

function listCurrentMemoryRuntimes(): MemoryRuntime[] {
  const runtimes = new Set(standaloneMemoryRegistrySlot?.retiredRuntimes);
  const current = getMemoryRuntime();
  if (current) {
    runtimes.add(current);
  }
  if (standaloneMemoryRegistrySlot?.runtime) {
    runtimes.add(standaloneMemoryRegistrySlot.runtime);
  }
  return [...runtimes];
}

/**
 * Why the memory slot resolved the way it did, not just what it produced.
 *
 * `capabilityRegistered` answers "did a plugin register a host memory capability", which is a
 * different question from "can this host search memory". `MemoryPluginCapability.runtime` is
 * optional: a plugin may register only a prompt builder or a public-artifact provider and those
 * consumers keep working, so search support is reported separately rather than collapsed into
 * registration.
 */
type MemorySlotResolution = {
  owner?: MemoryRuntimeOwner;
  capabilityRegistered: boolean;
  searchRuntimeRegistered: boolean;
  /** Set only when the selected owner's own load failed, carrying the loader's recorded message. */
  ownerLoadError?: string;
};

const UNRESOLVED_MEMORY_SLOT: MemorySlotResolution = {
  capabilityRegistered: false,
  searchRuntimeRegistered: false,
};

function resolveMemorySlot(params?: {
  cfg: OpenClawConfig;
  agentId: string;
}): MemorySlotResolution {
  const current = getMemoryRuntime();
  if (current || !params) {
    // A live in-process runtime only exists because a capability registered one.
    return current
      ? { owner: { runtime: current }, capabilityRegistered: true, searchRuntimeRegistered: true }
      : UNRESOLVED_MEMORY_SLOT;
  }
  const onlyPluginIds = resolveMemoryRuntimePluginIds(params.cfg);
  if (onlyPluginIds.length === 0) {
    return UNRESOLVED_MEMORY_SLOT;
  }
  const workspaceDir = resolveMemoryRuntimeWorkspaceDir(params.cfg, params.agentId);
  const registry = loadPluginRegistryHandle({
    config: params.cfg,
    onlyPluginIds,
    workspaceDir,
    activate: false,
  });
  const registration = resolveMemoryCapabilityRegistration(registry.memoryCapabilities);
  const runtime = registration?.capability.runtime;
  const ownerLoadError = resolveOwnerLoadError(registry, onlyPluginIds);
  const facts: MemorySlotResolution = {
    // Only the selected owner's registration may be reported here. Dreaming keeps an unselected
    // sidecar in scope (matchesScopedPluginOrDreamingSidecar), and its consolidation registration
    // survives the slot-owner field strip, so a bare presence check reports a capability the owner
    // never registered and the hero then names the owner for someone else's work. The sidecar stays
    // loaded and keeps serving consolidation either way; only the attribution narrows.
    capabilityRegistered: registration?.memorySlotSelected === true,
    searchRuntimeRegistered: runtime !== undefined,
  };
  if (ownerLoadError !== undefined) {
    facts.ownerLoadError = ownerLoadError;
  }
  const previousSlot = standaloneMemoryRegistrySlot;
  if (previousSlot?.runtime === runtime) {
    return runtime ? { ...facts, owner: { runtime, standalone: true } } : facts;
  }
  const retiredRuntimes = new Set(previousSlot?.retiredRuntimes);
  if (previousSlot?.runtime) {
    retiredRuntimes.add(previousSlot.runtime);
  }
  standaloneMemoryRegistrySlot = { runtime, retiredRuntimes };
  if (runtime && !enrolledStandaloneMemoryRuntimes.has(runtime)) {
    const lifecycle = getPluginValueInstance(runtime)?.lifecycle;
    if (lifecycle) {
      lifecycle.onDispose(() => {
        const slot = standaloneMemoryRegistrySlot;
        slot?.retiredRuntimes.delete(runtime);
        if (slot?.runtime === runtime) {
          delete slot.runtime;
        }
      });
      // Selection resets do not end the instance lifetime or remove its existing pruning callback.
      enrolledStandaloneMemoryRuntimes.add(runtime);
    }
  }
  return runtime ? { ...facts, owner: { runtime, standalone: true } } : facts;
}

function ensureMemoryRuntime(params?: {
  cfg: OpenClawConfig;
  agentId: string;
}): MemoryRuntimeOwner | undefined {
  return resolveMemorySlot(params).owner;
}

/**
 * Returns the active plugin-backed memory search manager for an agent.
 *
 * Three separate facts travel with the result, because collapsing any two of them makes the host
 * assert something it cannot observe:
 *
 * - `capabilityRegistered`: a plugin registered a host memory capability. Derived from the
 *   capability registration itself, NOT from `capability.runtime`, which is optional. A plugin
 *   registering only a prompt builder or a public-artifact provider is registered.
 * - `searchRuntimeRegistered`: that capability declares a search runtime. Only this field speaks
 *   to whether host-side memory search can work.
 * - `ownerLoadFailed`: the selected slot owner's own load failed. The loader records that on the
 *   plugin record rather than throwing, so without this field a crashed plugin is
 *   indistinguishable from one that deliberately registered nothing.
 *
 * Callers must use these (not `!!manager`) to distinguish "no memory capability is registered"
 * from "the registered capability's manager failed to construct" - see src/plugins/AGENTS.md
 * "Availability And Selection".
 */
export async function getActiveMemorySearchManagerCore(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status" | "cli";
  inspectSources?: boolean;
}) {
  const resolution = resolveMemorySlot(params);
  if (!resolution.owner) {
    return {
      manager: null,
      error: resolution.ownerLoadError ?? "memory plugin unavailable",
      capabilityRegistered: resolution.capabilityRegistered,
      searchRuntimeRegistered: resolution.searchRuntimeRegistered,
      ownerLoadFailed: resolution.ownerLoadError !== undefined,
    };
  }
  if (resolution.owner.standalone) {
    setStandaloneMemoryManagerActive(true);
  }
  const result = await resolution.owner.runtime.getMemorySearchManager(params);
  return {
    ...result,
    manager: result.manager ? normalizeRegisteredMemoryManager(result.manager) : null,
    capabilityRegistered: true,
    searchRuntimeRegistered: true,
    ownerLoadFailed: false,
  };
}

/** Applies the selected memory plugin's authorization policy to raw search hits. */
export async function authorizeActiveMemorySearchHits(
  params: MemorySearchAuthorization,
): Promise<MemorySearchAuthorization["hits"]> {
  const owner = ensureMemoryRuntime(params);
  if (!owner) {
    // Session artifacts need plugin-owned identity mapping before they are safe
    // to expose. Runtimes without that capability may still return memory hits.
    return params.hits.filter((hit) => hit.source !== "sessions");
  }
  return owner.runtime.authorizeSearchHits
    ? await owner.runtime.authorizeSearchHits(params)
    : params.hits.filter((hit) => hit.source !== "sessions");
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
  if (!owner) {
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
  return owner ? owner.runtime.resolveMemoryBackendConfig(params) : null;
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
        capability.runtime ? [capability.runtime] : [],
      ),
    );
  const nextRuntimes = runtimes(nextRegistry);
  const nextAdapters = new Set(nextRegistry.embeddingProviders.map(({ provider }) => provider));
  const retiringEmbeddingProviders = previousRegistry.embeddingProviders
    .map(({ provider }) => provider)
    .filter((provider) => !nextAdapters.has(provider));
  const prepared: Array<{
    runtime: MemoryPluginRuntime;
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
      cleanup = Promise.allSettled(
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
