import fs from "node:fs/promises";
import path from "node:path";
import type { MemorySearchManager } from "../../packages/memory-host-sdk/src/host/search-manager.types.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { observeDiagnosticsTimelinePhases } from "../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizePluginsConfig } from "./config-state.js";
import { withPluginHostCleanupTimeout } from "./host-hook-cleanup-timeout.js";
import { loadPluginRegistryHandle } from "./loader.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import { assertMemoryCallerCurrent, isHostMemoryAudience } from "./memory-audience.js";
import { resolveMemoryBackendPolicyIds } from "./memory-backend.js";
import { adaptLegacyMemoryProvider } from "./memory-provider-adapter.js";
import {
  createMemoryBackendAccess,
  settleMemoryProviderOpen,
  waitForMemoryCallerRead,
} from "./memory-provider-open.js";
import type {
  ActiveMemoryProviderResult,
  MemoryCallerContext,
  MemoryProviderOpenParams,
  MemoryProviderOpenResult,
} from "./memory-provider-types.js";
import {
  getMemoryRuntime,
  getMemoryProviderRuntime,
  getMemoryCapabilityRegistration,
  listMemoryBackendRegistrations,
  resolveMemoryCapabilityRegistration,
  setStandaloneMemoryManagerActive,
  setStandaloneMemoryOwner,
} from "./memory-state.js";
import { getPluginMetadataSnapshotCache } from "./plugin-cache.js";
import { getPluginValueInstance, runPluginCleanup } from "./plugin-instance-scope.js";
import { runPluginCleanupScope } from "./plugin-invocation-scope.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";
import type {
  MemoryBackendRegistration,
  MemoryPluginRuntime,
  MemoryProviderRuntime,
  RegisteredMemorySearchManager,
} from "./registry-contribution-types.js";
import { listPluginCacheRetiringRegistries } from "./registry-lifecycle.js";
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
  /** Passive backends loaded in the owner's registry. */
  backends?: readonly MemoryBackendRegistration[];
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

/**
 * Resolves the configured memory slot to the single runtime plugin that may own memory,
 * followed by requested backends. The loader still decides which of them become backends.
 */
function resolveMemoryRuntimePluginIds(
  config: OpenClawConfig,
  loadManifests: () => PluginManifestRegistry,
): string[] {
  const plugins = normalizePluginsConfig(config.plugins);
  const pluginId = plugins.slots.memory;
  if (!plugins.enabled || !pluginId) {
    return [];
  }
  const policyId = normalizePluginPolicyId(pluginId);
  if (plugins.deny.includes(policyId) || plugins.entries[policyId]?.enabled === false) {
    return [];
  }
  const backendIds = resolveMemoryBackendPolicyIds({
    ownerId: pluginId,
    entries: plugins.entries,
    allow: plugins.allow,
    deny: plugins.deny,
    manifests: loadManifests().plugins,
    normalizeId: normalizePluginPolicyId,
  });
  return [pluginId, ...backendIds];
}

function listCurrentMemoryRuntimes(): AnyMemoryRuntime[] {
  const runtimes = new Set(standaloneMemoryRegistrySlot?.retiredRuntimes);
  for (const runtime of [
    getMemoryRuntime(),
    getMemoryProviderRuntime(),
    standaloneMemoryRegistrySlot?.providerRuntime,
    standaloneMemoryRegistrySlot?.runtime,
  ]) {
    if (runtime) {
      runtimes.add(runtime);
    }
  }
  return [...runtimes];
}

function assertMemoryProviderRuntime(runtime: MemoryProviderRuntime | undefined): void {
  if (runtime !== undefined && (!runtime || typeof runtime.open !== "function")) {
    throw new Error("memory providerRuntime must implement open");
  }
}

function ensureMemoryRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): MemoryRuntimeOwner | undefined {
  const current = getMemoryRuntime();
  const currentProviderRuntime = getMemoryProviderRuntime();
  assertMemoryProviderRuntime(currentProviderRuntime);
  if (current || currentProviderRuntime) {
    return {
      runtime: current,
      providerRuntime: currentProviderRuntime,
      providerId: getMemoryCapabilityRegistration()?.pluginId,
      searchRuntimeRegistered: true,
      backends: listMemoryBackendRegistrations(),
    };
  }
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  let manifestRegistry: PluginManifestRegistry | undefined;
  const loadManifests = () =>
    (manifestRegistry ??= loadPluginManifestRegistryCore({ config: params.cfg, workspaceDir }));
  const onlyPluginIds = resolveMemoryRuntimePluginIds(params.cfg, loadManifests);
  if (onlyPluginIds.length === 0) {
    return undefined;
  }
  const registry = loadPluginRegistryHandle({
    config: params.cfg,
    registrationConfigOrigin: params.cfg,
    manifestRegistry: loadManifests(),
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
          backends: registry.memoryBackends,
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
  for (const retiredRuntime of [previousSlot?.runtime, previousSlot?.providerRuntime]) {
    if (retiredRuntime) {
      retiredRuntimes.add(retiredRuntime);
    }
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
    ...(owner.runtime.searchForCli
      ? { searchForCli: owner.runtime.searchForCli.bind(owner.runtime) }
      : {}),
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
  using phases = observeDiagnosticsTimelinePhases("memory.provider-open.authority");
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
  // Backend access is host-issued; a caller-supplied value never reaches the owner.
  const { backends: _callerBackends, ...callerParams } = params;
  await waitForMemoryCallerRead(context);
  phases.mark("memory.provider-open.runtime");
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
  const backendAccess =
    owner.providerRuntime && owner.backends?.length
      ? createMemoryBackendAccess(owner.backends, callerParams)
      : undefined;
  const openParams: MemoryProviderOpenParams = {
    ...callerParams,
    context,
    ...(backendAccess ? { backends: backendAccess.access } : {}),
  };
  phases.mark("memory.provider-open.open");
  let result: MemoryProviderOpenResult;
  try {
    result = await settleMemoryProviderOpen(
      owner.providerRuntime
        ? await owner.providerRuntime.open(openParams)
        : await adaptLegacyMemoryProvider(owner.runtime!, providerId, openParams),
      providerId,
      context,
      params.context,
      (owner.providerRuntime ?? owner.runtime)!,
      phases,
      { readOnly: params.purpose === "status" },
    );
  } catch (error) {
    await backendAccess?.end();
    throw error;
  }
  const provider = result.provider;
  if (backendAccess) {
    if (provider) {
      const closeOwner = provider.close.bind(provider);
      // Mutate in place: refresh handoff is keyed by this bound handle.
      provider.close = async () => {
        try {
          await closeOwner();
        } finally {
          await backendAccess.end();
        }
      };
    } else {
      await backendAccess.end();
    }
  }
  return { ...result, providerId, adapter };
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
    // Workspace provenance belongs to the host even when the selected search
    // plugin does not implement classification. Missing support must not hide USER.md.
    const { normalizeMemoryArtifactRelativePath, readMemoryArtifactProvenance } =
      await import("../memory/memory-artifact-provenance.js");
    const workspaceRoot =
      params.readSources === undefined
        ? await fs.realpath(params.workspaceDir).catch(() => undefined)
        : undefined;
    const classifications = await Promise.all(
      params.relativePaths.map(async (relativePath) => {
        let sourcePath = params.readSources?.find(
          (source) => source.relativePath === relativePath,
        )?.canonicalRelativePath;
        if (params.readSources === undefined && workspaceRoot) {
          const filePath = await fs
            .realpath(path.resolve(params.workspaceDir, relativePath))
            .catch(() => undefined);
          if (filePath) {
            sourcePath = path.relative(workspaceRoot, filePath).replaceAll(path.sep, "/");
          }
        }
        const memoryPath = sourcePath && normalizeMemoryArtifactRelativePath(sourcePath);
        if (
          !memoryPath ||
          memoryPath.includes("\0") ||
          memoryPath !== sourcePath ||
          path.posix.normalize(memoryPath) !== memoryPath
        ) {
          return { relativePath, originClass: "untrusted" };
        }
        const provenance = await readMemoryArtifactProvenance({
          workspaceDir: params.workspaceDir,
          relativePath: memoryPath,
        });
        return { relativePath, originClass: provenance?.originClass ?? "agent" };
      }),
    );
    return { status: "classified", classifications };
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

type MemoryRuntimeRegistry = Pick<
  PluginRegistry,
  "memoryCapabilities" | "memoryBackends" | "embeddingProviders"
>;

/**
 * Prepare memory consumers before any changed plugin loses ordinary call admission.
 * `retiringMetadata` is the published metadata snapshot whose plugin cache this reload
 * retires; its lazily loaded registries' adapters retire even when no plugin changes.
 */
export function prepareMemoryRuntimeReload(
  previousRegistry: MemoryRuntimeRegistry,
  nextRegistry: MemoryRuntimeRegistry,
  retiringMetadata?: PluginMetadataSnapshot,
) {
  const retiringCacheRegistries = retiringMetadata
    ? listPluginCacheRetiringRegistries(getPluginMetadataSnapshotCache(retiringMetadata))
    : [];
  // Backends drain with the slot owner; their leases hold the same embedding adapters.
  const runtimes = (registry: MemoryRuntimeRegistry) =>
    new Set([
      ...registry.memoryCapabilities.flatMap(({ capability }) =>
        [capability.runtime, capability.providerRuntime].filter(
          (runtime): runtime is AnyMemoryRuntime => runtime !== undefined,
        ),
      ),
      ...registry.memoryBackends.map(({ providerRuntime }) => providerRuntime),
    ]);
  const nextRuntimes = runtimes(nextRegistry);
  const nextAdapters = new Set(nextRegistry.embeddingProviders.map(({ provider }) => provider));
  const retiringEmbeddingProviders = [
    ...new Set(
      [previousRegistry, ...retiringCacheRegistries].flatMap((registry) =>
        registry.embeddingProviders.map(({ provider }) => provider),
      ),
    ),
  ].filter((provider) => !nextAdapters.has(provider));
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
  // Carried-over managers may hold retiring adapters, including cached ones absent from this
  // registry; their services restart to rebind. Without retiring adapters they keep running.
  const restartPluginIds = new Set(
    retiringEmbeddingProviders.length === 0
      ? []
      : previousRegistry.memoryCapabilities.flatMap(({ pluginId, capability }) =>
          [capability.runtime, capability.providerRuntime].some(
            (runtime) => runtime !== undefined && nextRuntimes.has(runtime),
          )
            ? [pluginId]
            : [],
        ),
  );
  return {
    restartPluginIds,
    drain: () => withPluginHostCleanupTimeout("memory managers", close),
    close,
    commit: (retained = nextRegistry) => resume(true, retained),
    rollback: () => {
      resume(false);
      // Admission can be prepared without draining; only drained owners need service restart.
      return new Set(
        previousRegistry.memoryCapabilities.flatMap(({ pluginId, capability }) =>
          cleanup &&
          prepared.some(
            ({ runtime }) =>
              runtime === capability.runtime || runtime === capability.providerRuntime,
          )
            ? [pluginId]
            : [],
        ),
      );
    },
  };
}
