// Context-engine registry owns engine registration, resolution, compatibility, and quarantine.
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
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { contextEngineAbortSignal, isContextEngineAbortRejection } from "./context-engine-abort.js";
import { pluginIdFromContextEngineOwner } from "./registry-adoption.js";
import {
  describeResolvedContextEngineContractError,
  projectContextEngineHostParams,
} from "./registry-contract.js";
import {
  clearContextEngineQuarantineForActivation,
  clearContextEngineRuntimeQuarantine,
  getContextEngineQuarantine,
  recordContextEngineQuarantine,
} from "./registry-quarantine.js";
import { resolveEffectiveContextEngineId } from "./registry-selection.js";
import {
  recordContextEngineRegistrationSource,
  createContextEngineWithResources,
  disposeContextEngineSources,
  resolveContextEngineFactory,
  retainLogicalTurnContextEngineSources,
  runContextEngineFactoryResolution,
  type ContextEngineFactoryResources,
  type ContextEngineFactoryPreparation,
} from "./registry.resources.js";
import type {
  BootstrapResult,
  ContextEngine,
  ContextEngineMaintenanceResult,
  IngestBatchResult,
  IngestResult,
} from "./types.js";

export type { ContextEngineFactory } from "../plugins/registry-contribution-types.js";
export { listContextEngineQuarantines } from "./registry-quarantine.js";

type ContextEngineRegistrationResult = { ok: true } | { ok: false; existingOwner: string };

type RegisterContextEngineForOwnerOptions = {
  allowSameOwnerRefresh?: boolean;
  lifecycle?: ContextEngineRegistrationLifecycle;
};

type GuardedContextEngineMethodName = Exclude<keyof ContextEngine, "info" | "dispose">;
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

function wrapResolvedContextEngine(
  rawEngine: ContextEngine,
  metadata: ResolvedContextEngineMetadata & {
    factory: ContextEngineFactory;
    defaultEngineId?: string;
    factoryCtx: ContextEngineFactoryContext;
  },
): ContextEngine {
  let disposal: Promise<void> | undefined;
  const source = metadata.source;
  const engine = source?.wrap(rawEngine) ?? rawEngine;
  const fallback =
    metadata.defaultEngineId && metadata.engineId !== metadata.defaultEngineId
      ? { defaultEngineId: metadata.defaultEngineId, factoryCtx: metadata.factoryCtx }
      : undefined;
  let fallbackEnginePromise: Promise<ContextEngine> | undefined;
  let resolvedFallbackEngine: ContextEngine | undefined;
  const getFallbackEngine = fallback
    ? async (beforeFactory?: Promise<unknown>) => {
        if (disposal) {
          throw new Error("Context engine has been disposed");
        }
        if (beforeFactory && fallbackEnginePromise) {
          await beforeFactory;
          if (disposal) {
            throw new Error("Context engine has been disposed");
          }
        }
        const resolve = () =>
          resolveDefaultContextEngine(
            fallback.defaultEngineId,
            fallback.factoryCtx,
            beforeFactory ? { completion: beforeFactory } : undefined,
          );
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
          return (params: Record<string, unknown>) =>
            method.call(engine, projectContextEngineHostParams(engine, methodName, params));
        }
        const invokeFallback = async (
          methodParams: Record<string, unknown>,
          beforeFactory?: Promise<unknown>,
        ) => {
          contextEngineAbortSignal(methodParams);
          const fallbackEngine = await getFallbackEngine(beforeFactory);
          const fallbackMethod = fallbackEngine[methodName] as
            | ((params: unknown) => unknown)
            | undefined;
          if (typeof fallbackMethod === "function") {
            return await fallbackMethod.call(fallbackEngine, methodParams);
          }
          if (methodName === "assemble" || methodName === "compact") {
            throw new Error(`No legacy fallback result for ${methodName}`);
          }
          const result =
            CONTEXT_ENGINE_FALLBACK_RESULTS[
              methodName as keyof typeof CONTEXT_ENGINE_FALLBACK_RESULTS
            ];
          return result ? { ...result } : undefined;
        };
        if (getContextEngineQuarantine(metadata.engineId)) {
          return invokeFallback;
        }
        return async (methodParams: Record<string, unknown>) => {
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
            const recording = recordContextEngineQuarantine({
              engineId: metadata.engineId,
              owner: metadata.owner,
              operation: methodName,
              error,
              defaultEngineId: fallback.defaultEngineId,
            });
            if (methodName === "compact" || methodName === "prepareSubagentSpawn") {
              await recording;
              throw error;
            }
            try {
              return await invokeFallback(methodParams, recording);
            } catch {
              throw error;
            } finally {
              await recording;
            }
          }
        };
      },
    },
  );
  resolvedEngineMetadata.set(wrapped, {
    ...metadata,
    sourceEngine: resolvedEngineMetadata.get(rawEngine)?.sourceEngine ?? rawEngine,
  });
  return wrapped;
}
const CORE_CONTEXT_ENGINE_OWNER = "core";

const getContextEngines = () => requireActivePluginRegistry().contextEngines;

/**
 * Register a context engine implementation under an explicit trusted owner.
 */
export async function registerContextEngineForOwner(
  id: string,
  factory: ContextEngineFactory,
  owner: string,
  opts?: RegisterContextEngineForOwnerOptions,
): Promise<ContextEngineRegistrationResult> {
  const targetRegistry = requireActivePluginRegistry();
  const result = registerContextEngineInRegistry(targetRegistry, id, factory, owner, opts);
  if (
    result.ok &&
    (opts?.lifecycle ?? "runtime") === "runtime" &&
    getActivePluginRegistry() === targetRegistry
  ) {
    const assertCurrent = () => {
      if (getActivePluginRegistry() !== targetRegistry) {
        throw new Error("Context engine registration was superseded");
      }
    };
    // Health cleanup cannot turn the already-applied registration into a refusal.
    await clearContextEngineRuntimeQuarantine(id, assertCurrent);
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
  const normalizedOwner = owner.trim();
  if (!normalizedOwner) {
    throw new Error(
      `registerContextEngineForOwner: owner must be a non-empty string, got ${JSON.stringify(owner)}`,
    );
  }
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
export function activateContextEngineRegistrations(
  pluginRegistry: PluginRegistry,
  activation?: {
    assertCurrent: () => void;
    trackCleanup: (completion: Promise<void>) => void;
  },
): void {
  for (const [id, registration] of pluginRegistry.contextEngines) {
    if (registration.lifecycle === "runtime") {
      if (activation) {
        activation.trackCleanup(
          clearContextEngineRuntimeQuarantine(id, () => {
            activation.assertCurrent();
            // An RPC can retain its predecessor registry while publishing this one.
            if (pluginRegistry.contextEngines.get(id) !== registration) {
              throw new Error("Context engine registration changed during activation cleanup");
            }
          }),
        );
      } else {
        // The shipped provider-catalog SDK can activate while returning a synchronous array.
        clearContextEngineQuarantineForActivation(id);
      }
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

export type ResolveContextEngineOptions = {
  agentDir?: string;
  workspaceDir?: string;
  onCleanupFailure?: () => void;
  /** Publishes built-ins synchronously; persistence settles after source capture. */
  initialize?: () => Promise<void>;
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
  const engine = await createOwnedContextEngine(engineId, entry, factoryCtx, { source });
  const pluginId = pluginIdFromContextEngineOwner(entry.owner);
  return Object.freeze({
    engine,
    registeredId: engineId,
    ...(pluginId ? { ownerPluginId: pluginId } : {}),
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
  const initialization = options?.initialize?.();
  try {
    return await runContextEngineFactoryResolution(async (abandon) => {
      const defaultEngineId = defaultSlotIdForKey("contextEngine");
      const configuredEngineId = resolveEffectiveContextEngineId(config, getContextEngines());
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
        if (initialization) {
          await initialization;
          getAsyncWorkSignal()?.throwIfAborted();
        }
        fallback = await resolveContextEngineFactory(sources.fallback, sourceResources, () =>
          resolveRawContextEngineRef(defaultEngineId, factoryCtx, fallbackEntry, sources.fallback),
        );
      } catch (error) {
        abandon(sources.fallback);
        abandon(sources.configured);
        throw error;
      }
      const resolution: LogicalTurnContextEngineResolution = {
        configured: fallback,
        configuredId: configuredEngineId,
        fallback,
        sourceResources,
      };
      if (configuredEngineId === defaultEngineId) {
        return resolution;
      }
      if (!configuredEntry || configuredEntry.lifecycle === "readOnlyDiscovery") {
        resolution.configuredFailure = !configuredEntry
          ? `context engine "${configuredEngineId}" is not registered`
          : `context engine "${configuredEngineId}" is available for discovery only`;
        return resolution;
      }
      try {
        if (sources.configuredFailure) {
          throw sources.configuredFailure.error;
        }
        resolution.configured = await resolveContextEngineFactory(
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
      } catch (error) {
        abandon(sources.configured);
        resolution.configuredFailure = error instanceof Error ? error.message : String(error);
      }
      return resolution;
    }, options?.onCleanupFailure);
  } finally {
    await initialization;
  }
}

/**
 * Resolve which ContextEngine to use based on plugin slot configuration.
 *
 * Resolution order:
 *   1. `config.plugins.slots.contextEngine` when its plugin policy permits it
 *   2. Default slot value ("legacy")
 *
 * Non-default engines that fail (unregistered, factory throw, or contract
 * violation) are logged and silently replaced by the default engine.
 * Host admission/resource failures and owner cancellation propagate without quarantine.
 * Default-engine failures also propagate.
 */
export async function resolveContextEngine(
  config?: OpenClawConfig,
  options?: ResolveContextEngineOptions,
): Promise<ContextEngine> {
  const abortSignal = getAsyncWorkSignal();
  const initialization = options?.initialize?.();
  const preparation = initialization
    ? { completion: initialization, assertCurrent: () => abortSignal?.throwIfAborted() }
    : undefined;
  try {
    const defaultEngineId = defaultSlotIdForKey("contextEngine");
    const engineId = resolveEffectiveContextEngineId(config, getContextEngines());
    const isDefaultEngine = engineId === defaultEngineId;

    const factoryCtx: ContextEngineFactoryContext = {
      config,
      agentDir: options?.agentDir,
      workspaceDir: options?.workspaceDir,
    };

    const quarantine = !isDefaultEngine ? getContextEngineQuarantine(engineId) : undefined;
    if (quarantine) {
      // Previously failed custom engines stay downgraded until explicit quarantine clear/restart.
      return await resolveDefaultContextEngine(defaultEngineId, factoryCtx, preparation);
    }

    const entry = getContextEngines().get(engineId);
    if (!entry) {
      if (isDefaultEngine) {
        throw new Error(
          `Context engine "${engineId}" is not registered. ` +
            `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
        );
      }
      const record = () =>
        recordContextEngineQuarantine({
          engineId,
          operation: "resolve",
          error: "not registered",
          defaultEngineId,
        });
      const recording = initialization ? initialization.then(record) : record();
      return await resolveDefaultContextEngine(defaultEngineId, factoryCtx, {
        completion: recording,
        assertCurrent: () => abortSignal?.throwIfAborted(),
      });
    }

    if (!isDefaultEngine && entry.lifecycle === "readOnlyDiscovery") {
      console.warn(
        `[context-engine] Context engine "${engineId}" owner=${entry.owner} is registered for read-only discovery only; falling back to default engine "${defaultEngineId}" without quarantine until runtime activation registers it.`,
      );
      return await resolveDefaultContextEngine(defaultEngineId, factoryCtx, preparation);
    }

    let operation: "factory" | "contract-validation" | undefined;
    try {
      return await createContextEngineWithResources(
        requireActivePluginRegistry(),
        entry,
        (source) => {
          // Admission and source retention belong to the host, not the plugin factory.
          operation = "factory";
          return createOwnedContextEngine(engineId, entry, factoryCtx, {
            source,
            ownsSource: true,
            defaultEngineId,
            onValidation: () => {
              operation = "contract-validation";
            },
          });
        },
        preparation,
      );
    } catch (error) {
      if (isDefaultEngine || !operation || isContextEngineAbortRejection(error, abortSignal)) {
        throw error;
      }
      const recording = recordContextEngineQuarantine({
        engineId,
        owner: entry.owner,
        operation,
        error,
        defaultEngineId,
      });
      // Recovery continues the admitted factory operation; recording is not new admission.
      return await resolveDefaultContextEngine(defaultEngineId, factoryCtx, {
        completion: recording,
      });
    }
  } finally {
    await initialization;
  }
}

/** Default-engine failures propagate; they cannot select another fallback. */
async function resolveDefaultContextEngine(
  defaultEngineId: string,
  factoryCtx: ContextEngineFactoryContext,
  preparation?: ContextEngineFactoryPreparation,
): Promise<ContextEngine> {
  try {
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
      preparation,
    );
  } finally {
    await preparation?.completion;
  }
}
