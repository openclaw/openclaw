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
function resolveMemoryRuntimePluginIds(config: OpenClawConfig): string[] {
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

function resolveMemoryRuntimeFromRegistry(registry: PluginRegistry) {
  return resolveMemoryCapabilityRegistration(registry.memoryCapabilities)?.capability.runtime;
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

function ensureMemoryRuntime(params?: {
  cfg: OpenClawConfig;
  agentId: string;
}): MemoryRuntimeOwner | undefined {
  const current = getMemoryRuntime();
  if (current || !params) {
    return current ? { runtime: current } : undefined;
  }
  const onlyPluginIds = resolveMemoryRuntimePluginIds(params.cfg);
  if (onlyPluginIds.length === 0) {
    return undefined;
  }
  const workspaceDir = resolveMemoryRuntimeWorkspaceDir(params.cfg, params.agentId);
  const registry = loadPluginRegistryHandle({
    config: params.cfg,
    onlyPluginIds,
    workspaceDir,
    activate: false,
  });
  const runtime = resolveMemoryRuntimeFromRegistry(registry);
  const previousSlot = standaloneMemoryRegistrySlot;
  if (previousSlot?.runtime === runtime) {
    return runtime ? { runtime, standalone: true } : undefined;
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
  return runtime ? { runtime, standalone: true } : undefined;
}

/** Returns the active plugin-backed memory search manager for an agent. */
export async function getActiveMemorySearchManagerCore(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status" | "cli";
  inspectSources?: boolean;
}) {
  const owner = ensureMemoryRuntime(params);
  if (!owner) {
    return { manager: null, error: "memory plugin unavailable" };
  }
  if (owner.standalone) {
    setStandaloneMemoryManagerActive(true);
  }
  const result = await owner.runtime.getMemorySearchManager(params);
  return {
    ...result,
    manager: result.manager ? normalizeRegisteredMemoryManager(result.manager) : null,
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
  if (!owner.runtime.classifyWorkspaceMemoryPaths) {
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
