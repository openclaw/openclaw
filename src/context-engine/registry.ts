// Context-engine registry owns engine registration, resolution, compatibility, and quarantine.
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.js";
import { runPluginCleanup } from "../plugins/plugin-instance-scope.js";
import type {
  ContextEngineFactory,
  ContextEngineFactoryContext,
  ContextEngineRegistration,
  ContextEngineRegistrationLifecycle,
} from "../plugins/registry-contribution-types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry, requireActivePluginRegistry } from "../plugins/runtime.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  inheritRuntimeCompactionDelegate,
  markRuntimeCompactionDelegate,
} from "./compaction-watchdog.js";
import { contextEngineAbortSignal, isContextEngineAbortRejection } from "./context-engine-abort.js";
import {
  clearPersistedContextEngineQuarantineForProcess,
  listPersistedContextEngineQuarantines,
  recordPersistedContextEngineQuarantine,
} from "./quarantine-health.js";
import { pluginIdFromContextEngineOwner } from "./registry-adoption.js";
import {
  describeResolvedContextEngineContractError,
  projectContextEngineHostParams,
} from "./registry-contract.js";
import {
  recordContextEngineRegistrationSource,
  createContextEngineWithResources,
  disposeContextEngineSources,
  resolveContextEngineFactory,
  retainLogicalTurnContextEngineSources,
  runContextEngineFactoryResolution,
  type ContextEngineFactoryResources,
} from "./registry.resources.js";
import type {
  BootstrapResult,
  ContextEngine,
  ContextEngineMaintenanceResult,
  IngestBatchResult,
  IngestResult,
} from "./types.js";

export type { ContextEngineFactory } from "../plugins/registry-contribution-types.js";

/**
 * Runtime context passed to context engine factories during resolution.
 * Provides config and path information so plugins can initialize engines
 * without fragile workarounds.
 */
type ContextEngineRegistrationResult = { ok: true } | { ok: false; existingOwner: string };

type RegisterContextEngineForOwnerOptions = {
  allowSameOwnerRefresh?: boolean;
  lifecycle?: ContextEngineRegistrationLifecycle;
};

type GuardedContextEngineMethodName = Exclude<keyof ContextEngine, "info" | "dispose">;
type GuardedContextEngineMethod = (...args: never[]) => unknown;
const GUARDED_CONTEXT_ENGINE_METHODS = new Set<PropertyKey>(
  "bootstrap maintain ingest ingestBatch afterTurn commitTurn assemble compact prepareSubagentSpawn onSubagentEnded".split(
    " ",
  ),
);
type ResolvedContextEngineMetadata = {
  owner: string;
  engineId: string;
  sourceEngine?: ContextEngine;
  source?: ContextEngineFactoryResources;
  ownsSource?: boolean;
};

const resolvedEngineMetadata = new WeakMap<ContextEngine, ResolvedContextEngineMetadata>();

function inheritCompactionWatchdogOwnership(
  property: PropertyKey,
  source: GuardedContextEngineMethod,
  wrapped: GuardedContextEngineMethod,
): GuardedContextEngineMethod {
  if (property !== "compact") {
    return wrapped;
  }
  // SAFETY: the compact property narrows both functions to the ContextEngine compact contract.
  const compact = source as ContextEngine["compact"];
  // SAFETY: guarded compact wrappers preserve the source method's single-parameter contract.
  const wrappedCompact = wrapped as ContextEngine["compact"];
  return inheritRuntimeCompactionDelegate(compact, wrappedCompact);
}

function wrapResolvedContextEngine(
  rawEngine: ContextEngine,
  metadata: ResolvedContextEngineMetadata & {
    factory: ContextEngineFactory;
    defaultEngineId?: string;
    factoryCtx?: ContextEngineFactoryContext;
  },
): ContextEngine {
  let disposal: Promise<void> | undefined;
  const source = metadata.source;
  const engine = source?.wrap(rawEngine) ?? rawEngine;
  const fallback =
    metadata.defaultEngineId &&
    metadata.factoryCtx &&
    metadata.engineId !== metadata.defaultEngineId
      ? { defaultEngineId: metadata.defaultEngineId, factoryCtx: metadata.factoryCtx }
      : undefined;
  let fallbackEnginePromise: Promise<ContextEngine> | undefined;
  let resolvedFallbackEngine: ContextEngine | undefined;
  const getFallbackEngine = fallback
    ? async () => {
        if (disposal) {
          throw new Error("Context engine has been disposed");
        }
        const resolve = () =>
          resolveDefaultContextEngine(fallback.defaultEngineId, fallback.factoryCtx);
        // Failed factories return before cleanup; capture that work in this engine's source owner.
        return await (fallbackEnginePromise ??= (source ? source.run(resolve) : resolve()).then(
          (resolved) => {
            resolvedFallbackEngine = resolved;
            return resolved;
          },
        ));
      }
    : undefined;
  const disposeOwned = () => {
    if (disposal) {
      return disposal;
    }
    const completion = createDeferredCore();
    disposal = completion.promise;
    void (async () => {
      // Join only a fallback already admitted before closure; disposal must never create one.
      const fallbackResult: PromiseSettledResult<ContextEngine | undefined> =
        fallbackEnginePromise && !resolvedFallbackEngine
          ? (await Promise.allSettled([fallbackEnginePromise]))[0]!
          : { status: "fulfilled", value: resolvedFallbackEngine };
      const fallbackEngine =
        fallbackResult.status === "fulfilled" ? fallbackResult.value : undefined;
      const sources = metadata.ownsSource && source ? [source] : [];
      const shared = fallbackEngine && hasSameContextEngineInstance(wrapped, fallbackEngine);
      const fallbackSource = fallbackEngine && resolvedEngineMetadata.get(fallbackEngine)?.source;
      if (shared && fallbackSource) {
        sources.push(fallbackSource);
      }
      // The fallback is a child of this factory; start its disposer before closing the parent signal.
      const fallbackCleanup = (async () => {
        if (!shared) {
          await fallbackEngine?.dispose?.();
        }
      })();
      // Shared raw engines dispose once with both source claims held; independent cleanup all runs.
      const results = await Promise.allSettled([
        (async () => {
          if (source && !metadata.ownsSource) {
            await source.runCleanup(() => rawEngine.dispose?.());
          } else {
            await disposeContextEngineSources(rawEngine, sources, () =>
              source
                ? rawEngine.dispose?.()
                : runPluginCleanup(metadata.factory, () => rawEngine.dispose?.()),
            );
          }
        })(),
        fallbackCleanup,
      ]);
      for (const result of [...results, fallbackResult]) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
    })().then(completion.resolve, completion.reject);
    return disposal;
  };
  // A fresh target keeps Proxy invariants compatible with frozen engines and private getters.
  const wrapped = new Proxy(
    Object.create(engine, { info: { get: () => engine.info } }) as ContextEngine,
    {
      get(_target, property) {
        if (property === "dispose" && (source || fallback)) {
          return disposeOwned;
        }
        if (property === "info") {
          if (!fallback || !getContextEngineQuarantine(metadata.engineId)) {
            return engine.info;
          }
          return (
            resolvedFallbackEngine?.info ?? {
              id: fallback.defaultEngineId,
              name:
                fallback.defaultEngineId === "legacy"
                  ? "Legacy Context Engine"
                  : `${fallback.defaultEngineId} Context Engine`,
            }
          );
        }

        // Disposal keeps its registered owner while ordinary methods retain their normal fences.
        const invokeMember = <T>(run: () => T): T =>
          property === "dispose" ? runPluginCleanup(metadata.factory, run) : run();
        const method = invokeMember(() => Reflect.get(engine, property, engine));
        if (typeof method !== "function") {
          return method;
        }
        if (!GUARDED_CONTEXT_ENGINE_METHODS.has(property)) {
          return (...args: unknown[]) => invokeMember(() => Reflect.apply(method, engine, args));
        }
        const methodName = property as GuardedContextEngineMethodName;
        if (!fallback || !getFallbackEngine) {
          const invoke = (params: Record<string, unknown>) =>
            method.call(engine, projectContextEngineHostParams(engine, methodName, params));
          return inheritCompactionWatchdogOwnership(property, method, invoke);
        }
        const invokeFallback = async (methodParams: Record<string, unknown>) => {
          contextEngineAbortSignal(methodParams);
          return await invokeFallbackContextEngineMethod({
            getFallbackEngine,
            methodName,
            methodParams,
          });
        };
        if (getContextEngineQuarantine(metadata.engineId)) {
          return methodName === "compact"
            ? markRuntimeCompactionDelegate(invokeFallback as ContextEngine["compact"]) // SAFETY: compact keeps this parameter contract.
            : invokeFallback;
        }
        const invoke = async (methodParams: Record<string, unknown>) => {
          const abortSignal = contextEngineAbortSignal(methodParams);
          if (getContextEngineQuarantine(metadata.engineId)) {
            // Runtime failures downgrade future guarded calls for this process.
            return await invokeFallback(methodParams);
          }
          try {
            return await method.call(
              engine,
              projectContextEngineHostParams(engine, methodName, methodParams),
            );
          } catch (error) {
            if (isContextEngineAbortRejection(error, abortSignal)) {
              // Abort is caller intent, not engine instability; never quarantine for it.
              throw error;
            }
            recordContextEngineQuarantine({
              engineId: metadata.engineId,
              owner: metadata.owner,
              operation: methodName,
              error,
              defaultEngineId: fallback.defaultEngineId,
            });
            if (methodName === "compact" || methodName === "prepareSubagentSpawn") {
              throw error;
            }
            return await invokeFallback(methodParams).catch(() => {
              throw error;
            });
          }
        };
        return inheritCompactionWatchdogOwnership(property, method, invoke);
      },
    },
  );
  resolvedEngineMetadata.set(wrapped, {
    ...metadata,
    sourceEngine:
      metadata.sourceEngine ?? resolvedEngineMetadata.get(engine)?.sourceEngine ?? engine,
  });
  return wrapped;
}
// ---------------------------------------------------------------------------
// Registry (module-level singleton)
// ---------------------------------------------------------------------------

const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");
const CORE_CONTEXT_ENGINE_OWNER = "core";

type ContextEngineRuntimeQuarantine = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAt: Date;
};

type ContextEngineRegistryState = {
  quarantinedEngines: Map<string, ContextEngineRuntimeQuarantine>;
};

// Keep context-engine registrations process-global so duplicated dist chunks
// still share one registry map at runtime.
const contextEngineRegistryState = resolveGlobalSingleton<ContextEngineRegistryState>(
  CONTEXT_ENGINE_REGISTRY_STATE,
  () => ({
    quarantinedEngines: new Map(),
  }),
);

const getContextEngines = () => requireActivePluginRegistry().contextEngines;

function requireContextEngineOwner(owner: string): string {
  const normalizedOwner = owner.trim();
  if (!normalizedOwner) {
    throw new Error(
      `registerContextEngineForOwner: owner must be a non-empty string, got ${JSON.stringify(owner)}`,
    );
  }
  return normalizedOwner;
}

function recordContextEngineQuarantine(params: {
  engineId: string;
  owner?: string;
  operation: string;
  error: unknown;
  defaultEngineId: string;
}): ContextEngineRuntimeQuarantine {
  const existing = contextEngineRegistryState.quarantinedEngines.get(params.engineId);
  if (existing) {
    // First failure wins so logs and diagnostics point at the root cause, not follow-on fallback use.
    return existing;
  }

  const quarantine: ContextEngineRuntimeQuarantine = {
    engineId: params.engineId,
    operation: params.operation,
    reason: params.error instanceof Error ? params.error.message : String(params.error),
    failedAt: new Date(),
    ...(params.owner ? { owner: params.owner } : {}),
  };
  contextEngineRegistryState.quarantinedEngines.set(params.engineId, quarantine);
  try {
    recordPersistedContextEngineQuarantine(quarantine);
  } catch {
    // Quarantine behavior must not depend on the best-effort health mirror.
  }
  const ownerSuffix = params.owner ? ` owner=${sanitizeForLog(params.owner)}` : "";
  console.error(
    `[context-engine] Context engine "${sanitizeForLog(params.engineId)}"${ownerSuffix} failed during ${sanitizeForLog(params.operation)}: ` +
      `${sanitizeForLog(quarantine.reason)}; quarantining it for this process and falling back to default engine "${params.defaultEngineId}".`,
  );
  return quarantine;
}

function getContextEngineQuarantine(engineId: string): ContextEngineRuntimeQuarantine | undefined {
  return contextEngineRegistryState.quarantinedEngines.get(engineId);
}

export function listContextEngineQuarantines(): ContextEngineRuntimeQuarantine[] {
  const quarantines = Array.from(
    contextEngineRegistryState.quarantinedEngines.values(),
    ({ failedAt, ...quarantine }) => ({ ...quarantine, failedAt: new Date(failedAt) }),
  );
  const seenEngineIds = new Set(quarantines.map((entry) => entry.engineId));
  return quarantines.concat(
    listPersistedContextEngineQuarantines().filter(({ engineId }) => !seenEngineIds.has(engineId)),
  );
}

function clearContextEngineRuntimeQuarantine(engineId: string): void {
  contextEngineRegistryState.quarantinedEngines.delete(engineId);
  clearPersistedContextEngineQuarantineForProcess(engineId, process.pid);
}

/**
 * Register a context engine implementation under an explicit trusted owner.
 */
export function registerContextEngineForOwner(
  id: string,
  factory: ContextEngineFactory,
  owner: string,
  opts?: RegisterContextEngineForOwnerOptions,
): ContextEngineRegistrationResult {
  const targetRegistry = requireActivePluginRegistry();
  const result = registerContextEngineInRegistry(targetRegistry, id, factory, owner, opts);
  if (
    result.ok &&
    (opts?.lifecycle ?? "runtime") === "runtime" &&
    getActivePluginRegistry() === targetRegistry
  ) {
    clearContextEngineRuntimeQuarantine(id);
  }
  return result;
}

/** Registers an engine in a registry value while that value is being assembled. */
export function registerContextEngineInRegistry(
  pluginRegistry: PluginRegistry,
  id: string,
  factory: ContextEngineFactory,
  owner: string,
  opts?: RegisterContextEngineForOwnerOptions,
): ContextEngineRegistrationResult {
  const normalizedOwner = requireContextEngineOwner(owner);
  const lifecycle = opts?.lifecycle ?? "runtime";
  const registry = pluginRegistry.contextEngines;
  const existing = registry.get(id);
  if (
    id === defaultSlotIdForKey("contextEngine") &&
    normalizedOwner !== CORE_CONTEXT_ENGINE_OWNER
  ) {
    // The default fallback id is core-owned; plugins can select other ids through slots.
    return { ok: false, existingOwner: CORE_CONTEXT_ENGINE_OWNER };
  }
  if (existing && existing.owner !== normalizedOwner) {
    return { ok: false, existingOwner: existing.owner };
  }
  if (existing?.lifecycle === "runtime" && lifecycle === "readOnlyDiscovery") {
    // Read-only discovery may re-run after live activation. It can collect metadata, but it must
    // not replace the runtime-safe factory with a closure that captured a read-only plugin mode.
    return { ok: true };
  }
  if (existing && opts?.allowSameOwnerRefresh !== true) {
    return { ok: false, existingOwner: existing.owner };
  }
  const registration = { factory, owner: normalizedOwner, lifecycle };
  recordContextEngineRegistrationSource(registration, pluginRegistry);
  registry.set(id, registration);
  return { ok: true };
}

export { adoptRuntimeContextEngineRegistrations } from "./registry-adoption.js";

/** Clear runtime quarantine only after a complete builder-local registry becomes active. */
export function activateContextEngineRegistrations(pluginRegistry: PluginRegistry): void {
  for (const [id, registration] of pluginRegistry.contextEngines) {
    if (registration.lifecycle === "runtime") {
      clearContextEngineRuntimeQuarantine(id);
    }
  }
}

/** Returns registration metadata so callers can distinguish discovery snapshots from runtime entries. */
export function getContextEngineRegistration(id: string): ContextEngineRegistration | undefined {
  return getContextEngines().get(id);
}

const listContextEngineIds = () => [...getContextEngines().keys()].toSorted();

/**
 * Return the trusted plugin id that registered a resolved context engine.
 * Downgraded engines intentionally report no plugin owner.
 */
export function resolveContextEngineOwnerPluginId(
  engine: ContextEngine | undefined | null,
): string | undefined {
  const metadata = engine ? resolvedEngineMetadata.get(engine) : undefined;
  // Downgraded work belongs to its core-owned fallback, never the disabled plugin.
  const owner =
    metadata && !getContextEngineQuarantine(metadata.engineId) ? metadata.owner : undefined;
  return owner ? pluginIdFromContextEngineOwner(owner) : undefined;
}

export const hasSameContextEngineInstance = (left: ContextEngine, right: ContextEngine): boolean =>
  (resolvedEngineMetadata.get(left)?.sourceEngine ?? left) ===
  (resolvedEngineMetadata.get(right)?.sourceEngine ?? right);

const CONTEXT_ENGINE_FALLBACK_RESULTS = {
  bootstrap: { bootstrapped: false, reason: "context engine downgraded to legacy" },
  maintain: {
    changed: false,
    bytesFreed: 0,
    rewrittenEntries: 0,
    reason: "context engine downgraded to legacy",
  },
  ingest: { ingested: false },
  ingestBatch: { ingestedCount: 0 },
} as const satisfies {
  bootstrap: BootstrapResult;
  maintain: ContextEngineMaintenanceResult;
  ingest: IngestResult;
  ingestBatch: IngestBatchResult;
};

export { isContextEngineAbortRejection };

async function invokeFallbackContextEngineMethod(params: {
  getFallbackEngine: () => Promise<ContextEngine>;
  methodName: GuardedContextEngineMethodName;
  methodParams: unknown;
}): Promise<unknown> {
  const fallbackEngine = await params.getFallbackEngine();
  const fallbackMethod = fallbackEngine[params.methodName] as
    | ((methodParams: unknown) => unknown)
    | undefined;
  if (typeof fallbackMethod === "function") {
    return await fallbackMethod.call(fallbackEngine, params.methodParams);
  }
  if (params.methodName === "assemble" || params.methodName === "compact") {
    throw new Error(`No legacy fallback result for ${params.methodName}`);
  }
  const fallbackResult =
    CONTEXT_ENGINE_FALLBACK_RESULTS[
      params.methodName as keyof typeof CONTEXT_ENGINE_FALLBACK_RESULTS
    ];
  return fallbackResult ? { ...fallbackResult } : undefined;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Options for {@link resolveContextEngine}.
 */
export type ResolveContextEngineOptions = {
  agentDir?: string;
  workspaceDir?: string;
  onCleanupFailure?: () => void;
};

export type ResolvedContextEngineRef = Readonly<{
  engine: ContextEngine;
  registeredId: string;
  ownerPluginId?: string;
}>;

export type LogicalTurnContextEngineResolution = {
  configured: ResolvedContextEngineRef;
  configuredId: string;
  configuredFailure?: string;
  fallback: ResolvedContextEngineRef;
  sourceResources?: ReadonlyMap<ContextEngine, readonly ContextEngineFactoryResources[]>;
};

function resolvedContextEngineRef(params: {
  engine: ContextEngine;
  registeredId: string;
  owner: string;
}): ResolvedContextEngineRef {
  const pluginId = pluginIdFromContextEngineOwner(params.owner);
  return Object.freeze({
    engine: params.engine,
    registeredId: params.registeredId,
    ...(pluginId ? { ownerPluginId: pluginId } : {}),
  });
}

async function createOwnedContextEngine(
  engineId: string,
  entry: ContextEngineRegistration,
  factoryCtx: ContextEngineFactoryContext,
  options: {
    defaultEngineId?: string;
    onValidation?: () => void;
    contractErrorPrefix?: string;
    source?: ContextEngineFactoryResources;
    ownsSource?: boolean;
  } = {},
): Promise<ContextEngine> {
  let engine: ContextEngine | undefined;
  try {
    engine = await entry.factory(factoryCtx);
    options.onValidation?.();
    const contractError = describeResolvedContextEngineContractError(engineId, engine);
    if (contractError) {
      throw new Error(`${options.contractErrorPrefix ?? ""}${contractError}`);
    }
    return wrapResolvedContextEngine(engine, {
      sourceEngine: resolvedEngineMetadata.get(engine)?.sourceEngine ?? engine,
      source: options.source,
      ownsSource: options.ownsSource,
      engineId,
      owner: entry.owner,
      factory: entry.factory,
      defaultEngineId: options.defaultEngineId,
      factoryCtx,
    });
  } catch (error) {
    const dispose = () => engine?.dispose?.();
    await Promise.resolve()
      .then(() =>
        options.source
          ? options.source.runCleanup(dispose)
          : runPluginCleanup(entry.factory, dispose),
      )
      .catch(() => undefined);
    throw error;
  }
}

async function resolveRawContextEngineRef(
  engineId: string,
  factoryCtx: ContextEngineFactoryContext,
  entry: ContextEngineRegistration | undefined,
  source: ContextEngineFactoryResources | undefined,
): Promise<ResolvedContextEngineRef> {
  if (!entry) {
    throw new Error(
      `Context engine "${engineId}" is not registered. ` +
        `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
    );
  }
  return resolvedContextEngineRef({
    engine: await createOwnedContextEngine(engineId, entry, factoryCtx, { source }),
    registeredId: engineId,
    owner: entry.owner,
  });
}

/**
 * Resolve fresh engines for one logical turn without consulting or mutating
 * process quarantine. A failed configured engine is retried by the next turn.
 */
export async function resolveLogicalTurnContextEngines(
  config?: OpenClawConfig,
  options?: ResolveContextEngineOptions,
): Promise<LogicalTurnContextEngineResolution> {
  return await runContextEngineFactoryResolution(async (abandon) => {
    const defaultEngineId = defaultSlotIdForKey("contextEngine");
    const slotValue = config?.plugins?.slots?.contextEngine;
    const configuredEngineId =
      typeof slotValue === "string" && slotValue.trim() ? slotValue.trim() : defaultEngineId;
    const factoryCtx: ContextEngineFactoryContext = {
      config,
      agentDir: options?.agentDir,
      workspaceDir: options?.workspaceDir,
    };
    const registry = requireActivePluginRegistry();
    const entries = registry.contextEngines;
    const fallbackEntry = entries.get(defaultEngineId);
    const configuredEntry = entries.get(configuredEngineId);
    const sources = retainLogicalTurnContextEngineSources(
      registry,
      fallbackEntry,
      configuredEngineId === defaultEngineId ? undefined : configuredEntry,
      abandon,
    );
    const sourceResources = new Map<ContextEngine, ContextEngineFactoryResources[]>();
    let fallback: ResolvedContextEngineRef;
    try {
      fallback = await resolveContextEngineFactory(sources.fallback, sourceResources, () =>
        resolveRawContextEngineRef(defaultEngineId, factoryCtx, fallbackEntry, sources.fallback),
      );
    } catch (error) {
      abandon(sources.fallback);
      abandon(sources.configured);
      throw error;
    }
    if (configuredEngineId === defaultEngineId) {
      return { configured: fallback, configuredId: configuredEngineId, fallback, sourceResources };
    }
    if (!configuredEntry || configuredEntry.lifecycle === "readOnlyDiscovery") {
      return {
        configured: fallback,
        configuredId: configuredEngineId,
        configuredFailure: !configuredEntry
          ? `context engine "${configuredEngineId}" is not registered`
          : `context engine "${configuredEngineId}" is available for discovery only`,
        fallback,
        sourceResources,
      };
    }
    try {
      if (sources.configuredFailure) {
        throw sources.configuredFailure.error;
      }
      const configured = await resolveContextEngineFactory(
        sources.configured,
        sourceResources,
        () =>
          resolveRawContextEngineRef(
            configuredEngineId,
            factoryCtx,
            configuredEntry,
            sources.configured,
          ),
      );
      return { configured, configuredId: configuredEngineId, fallback, sourceResources };
    } catch (error) {
      abandon(sources.configured);
      return {
        configured: fallback,
        configuredId: configuredEngineId,
        configuredFailure: error instanceof Error ? error.message : String(error),
        fallback,
        sourceResources,
      };
    }
  }, options?.onCleanupFailure);
}

/**
 * Resolve which ContextEngine to use based on plugin slot configuration.
 *
 * Resolution order:
 *   1. `config.plugins.slots.contextEngine` (explicit slot override)
 *   2. Default slot value ("legacy")
 *
 * When `config` is provided it is forwarded to the factory as part of a
 * {@link ContextEngineFactoryContext}. Additional runtime paths can be
 * supplied via `options`. Existing no-arg factories continue to work
 * because JavaScript permits extra arguments at call sites.
 *
 * Non-default engines that fail (unregistered, factory throw, or contract
 * violation) are logged and silently replaced by the default engine.
 * Throws only when the default engine itself cannot be resolved.
 */
export async function resolveContextEngine(
  config?: OpenClawConfig,
  options?: ResolveContextEngineOptions,
): Promise<ContextEngine> {
  const defaultEngineId = defaultSlotIdForKey("contextEngine");
  const slotValue = config?.plugins?.slots?.contextEngine;
  const engineId =
    typeof slotValue === "string" && slotValue.trim() ? slotValue.trim() : defaultEngineId;
  const isDefaultEngine = engineId === defaultEngineId;

  const factoryCtx: ContextEngineFactoryContext = {
    config,
    agentDir: options?.agentDir,
    workspaceDir: options?.workspaceDir,
  };

  const quarantine = !isDefaultEngine ? getContextEngineQuarantine(engineId) : undefined;
  if (quarantine) {
    // Previously failed custom engines stay downgraded until explicit quarantine clear/restart.
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }

  const entry = getContextEngines().get(engineId);
  if (!entry) {
    if (isDefaultEngine) {
      throw new Error(
        `Context engine "${engineId}" is not registered. ` +
          `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
      );
    }
    recordContextEngineQuarantine({
      engineId,
      operation: "resolve",
      error: "not registered",
      defaultEngineId,
    });
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }

  if (!isDefaultEngine && entry.lifecycle === "readOnlyDiscovery") {
    console.warn(
      `[context-engine] Context engine "${engineId}" owner=${entry.owner} is registered for read-only discovery only; falling back to default engine "${defaultEngineId}" without quarantine until runtime activation registers it.`,
    );
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }

  let operation: "factory" | "contract-validation" = "factory";
  try {
    return await createContextEngineWithResources(requireActivePluginRegistry(), entry, (source) =>
      createOwnedContextEngine(engineId, entry, factoryCtx, {
        source,
        ownsSource: true,
        defaultEngineId,
        onValidation: () => {
          operation = "contract-validation";
        },
      }),
    );
  } catch (error) {
    if (isDefaultEngine) {
      throw error;
    }
    recordContextEngineQuarantine({
      engineId,
      owner: entry.owner,
      operation,
      error,
      defaultEngineId,
    });
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }
}

/** Default-engine failures propagate; they cannot select another fallback. */
async function resolveDefaultContextEngine(
  defaultEngineId: string,
  factoryCtx: ContextEngineFactoryContext,
): Promise<ContextEngine> {
  const defaultEntry = getContextEngines().get(defaultEngineId);
  if (!defaultEntry) {
    throw new Error(
      `[context-engine] fallback failed: default engine "${defaultEngineId}" is not registered. ` +
        `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
    );
  }
  return await createContextEngineWithResources(
    requireActivePluginRegistry(),
    defaultEntry,
    (source) =>
      createOwnedContextEngine(defaultEngineId, defaultEntry, factoryCtx, {
        source,
        ownsSource: true,
        contractErrorPrefix: "[context-engine] ",
      }),
  );
}
