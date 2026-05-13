import type { OpenClawConfig } from "../config/types.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import type { ContextEngine } from "./types.js";

/**
 * Runtime context passed to context engine factories during resolution.
 * Provides config and path information so plugins can initialize engines
 * without fragile workarounds.
 */
export type ContextEngineFactoryContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
};

/**
 * A factory that creates a ContextEngine instance.
 * Supports async creation for engines that need DB connections etc.
 *
 * The factory receives a {@link ContextEngineFactoryContext} with runtime
 * environment context (config, paths). Existing no-arg factories remain
 * backward compatible because TypeScript permits assigning functions with
 * fewer parameters to wider signatures.
 */
export type ContextEngineFactory = (
  ctx: ContextEngineFactoryContext,
) => ContextEngine | Promise<ContextEngine>;
export type ContextEngineRegistrationResult = { ok: true } | { ok: false; existingOwner: string };

type RegisterContextEngineForOwnerOptions = {
  allowSameOwnerRefresh?: boolean;
};

const RESOLVED_CONTEXT_ENGINE_METADATA = new WeakMap<ContextEngine, { owner: string }>();

function wrapResolvedContextEngine(
  engine: ContextEngine,
  metadata: { owner: string },
): ContextEngine {
  RESOLVED_CONTEXT_ENGINE_METADATA.set(engine, metadata);
  return engine;
}

// ---------------------------------------------------------------------------
// Registry (module-level singleton)
// ---------------------------------------------------------------------------

const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");
const CORE_CONTEXT_ENGINE_OWNER = "core";
const PUBLIC_CONTEXT_ENGINE_OWNER = "public-sdk";

type ContextEngineRegistryState = {
  engines: Map<
    string,
    {
      factory: ContextEngineFactory;
      owner: string;
    }
  >;
};

// Keep context-engine registrations process-global so duplicated dist chunks
// still share one registry map at runtime.
const contextEngineRegistryState = resolveGlobalSingleton<ContextEngineRegistryState>(
  CONTEXT_ENGINE_REGISTRY_STATE,
  () => ({
    engines: new Map(),
  }),
);

function getContextEngineRegistryState(): ContextEngineRegistryState {
  return contextEngineRegistryState;
}

function requireContextEngineOwner(owner: string): string {
  const normalizedOwner = owner.trim();
  if (!normalizedOwner) {
    throw new Error(
      `registerContextEngineForOwner: owner must be a non-empty string, got ${JSON.stringify(owner)}`,
    );
  }
  return normalizedOwner;
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
  const normalizedOwner = requireContextEngineOwner(owner);
  const registry = getContextEngineRegistryState().engines;
  const existing = registry.get(id);
  if (
    id === defaultSlotIdForKey("contextEngine") &&
    normalizedOwner !== CORE_CONTEXT_ENGINE_OWNER
  ) {
    return { ok: false, existingOwner: CORE_CONTEXT_ENGINE_OWNER };
  }
  if (existing && existing.owner !== normalizedOwner) {
    return { ok: false, existingOwner: existing.owner };
  }
  if (existing && opts?.allowSameOwnerRefresh !== true) {
    return { ok: false, existingOwner: existing.owner };
  }
  registry.set(id, { factory, owner: normalizedOwner });
  return { ok: true };
}

/**
 * Public SDK entry point for third-party registrations.
 *
 * This path is intentionally unprivileged: it cannot claim core-owned ids and
 * it cannot safely refresh an existing registration because the caller's
 * identity is not authenticated.
 */
export function registerContextEngine(
  id: string,
  factory: ContextEngineFactory,
): ContextEngineRegistrationResult {
  return registerContextEngineForOwner(id, factory, PUBLIC_CONTEXT_ENGINE_OWNER);
}

/**
 * Return the factory for a registered engine, or undefined.
 */
export function getContextEngineFactory(id: string): ContextEngineFactory | undefined {
  return getContextEngineRegistryState().engines.get(id)?.factory;
}

/**
 * List all registered engine ids.
 */
export function listContextEngineIds(): string[] {
  return [...getContextEngineRegistryState().engines.keys()];
}

export function clearContextEnginesForOwner(owner: string): void {
  const normalizedOwner = requireContextEngineOwner(owner);
  const registry = getContextEngineRegistryState().engines;
  for (const [id, entry] of registry.entries()) {
    if (entry.owner === normalizedOwner) {
      registry.delete(id);
    }
  }
}

/**
 * Return the trusted plugin id that registered a resolved context engine.
 */
export function resolveContextEngineOwnerPluginId(
  engine: ContextEngine | undefined | null,
): string | undefined {
  if (!engine) {
    return undefined;
  }
  const owner = RESOLVED_CONTEXT_ENGINE_METADATA.get(engine)?.owner;
  if (!owner?.startsWith("plugin:")) {
    return undefined;
  }
  const pluginId = owner.slice("plugin:".length).trim();
  return pluginId || undefined;
}

function describeResolvedContextEngineContractError(
  engineId: string,
  engine: unknown,
): string | null {
  if (!engine || typeof engine !== "object") {
    return `Context engine "${engineId}" factory returned ${JSON.stringify(engine)} instead of a ContextEngine object.`;
  }

  const candidate = engine as Record<string, unknown>;
  const issues: string[] = [];
  const info = candidate.info;
  if (!info || typeof info !== "object") {
    issues.push("missing info");
  } else {
    const infoRecord = info as Record<string, unknown>;
    // Engines own their internal info.id; it is metadata, not a handle into the
    // registry. The registered id (plugin slot id) and the engine's own id are
    // allowed to differ, so we only require that info.id is a non-empty string
    // for display/logging purposes and do not enforce equality with engineId.
    const infoId = typeof infoRecord.id === "string" ? infoRecord.id.trim() : "";
    if (!infoId) {
      issues.push("missing info.id");
    }
    if (typeof infoRecord.name !== "string" || !infoRecord.name.trim()) {
      issues.push("missing info.name");
    }
  }

  if (typeof candidate.ingest !== "function") {
    issues.push("missing ingest()");
  }
  if (typeof candidate.assemble !== "function") {
    issues.push("missing assemble()");
  }
  if (typeof candidate.compact !== "function") {
    issues.push("missing compact()");
  }

  if (issues.length === 0) {
    return null;
  }

  return `Context engine "${engineId}" factory returned an invalid ContextEngine: ${issues.join(", ")}.`;
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
};

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
  const slotValue = config?.plugins?.slots?.contextEngine;
  const engineId =
    typeof slotValue === "string" && slotValue.trim()
      ? slotValue.trim()
      : defaultSlotIdForKey("contextEngine");

  const defaultEngineId = defaultSlotIdForKey("contextEngine");
  const isDefaultEngine = engineId === defaultEngineId;

  const factoryCtx: ContextEngineFactoryContext = {
    config,
    agentDir: options?.agentDir,
    workspaceDir: options?.workspaceDir,
  };

  const entry = getContextEngineRegistryState().engines.get(engineId);
  if (!entry) {
    if (isDefaultEngine) {
      throw new Error(
        `Context engine "${engineId}" is not registered. ` +
          `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
      );
    }
    console.error(
      `[context-engine] Context engine "${sanitizeForLog(engineId)}" is not registered; ` +
        `falling back to default engine "${defaultEngineId}".`,
    );
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }

  let engine: ContextEngine;
  try {
    engine = await entry.factory(factoryCtx);
  } catch (factoryError) {
    if (isDefaultEngine) {
      throw factoryError;
    }
    console.error(
      `[context-engine] Context engine "${sanitizeForLog(engineId)}" factory threw during resolution: ` +
        `${sanitizeForLog(factoryError instanceof Error ? factoryError.message : String(factoryError))}; ` +
        `falling back to default engine "${defaultEngineId}".`,
    );
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }

  let contractError: string | null;
  try {
    contractError = describeResolvedContextEngineContractError(engineId, engine);
  } catch (validationError) {
    if (isDefaultEngine) {
      throw validationError;
    }
    console.error(
      `[context-engine] Context engine "${sanitizeForLog(engineId)}" contract validation threw: ` +
        `${sanitizeForLog(validationError instanceof Error ? validationError.message : String(validationError))}; ` +
        `falling back to default engine "${defaultEngineId}".`,
    );
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }
  if (contractError) {
    if (isDefaultEngine) {
      throw new Error(contractError);
    }
    // contractError includes engineId from plugin config; sanitizeForLog covers it
    console.error(
      `[context-engine] ${sanitizeForLog(contractError)}; falling back to default engine "${defaultEngineId}".`,
    );
    return resolveDefaultContextEngine(defaultEngineId, factoryCtx);
  }

  return wrapResolvedContextEngine(engine, { owner: entry.owner });
}

/**
 * Resolve the default context engine as a last-resort fallback.
 *
 * This helper is intentionally strict: if the default engine itself fails,
 * there is no further fallback and the error must propagate.
 */
async function resolveDefaultContextEngine(
  defaultEngineId: string,
  factoryCtx: ContextEngineFactoryContext,
): Promise<ContextEngine> {
  const defaultEntry = getContextEngineRegistryState().engines.get(defaultEngineId);
  if (!defaultEntry) {
    throw new Error(
      `[context-engine] fallback failed: default engine "${defaultEngineId}" is not registered. ` +
        `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
    );
  }
  const engine = await defaultEntry.factory(factoryCtx);
  const contractError = describeResolvedContextEngineContractError(defaultEngineId, engine);
  if (contractError) {
    throw new Error(`[context-engine] ${contractError}`);
  }
  return wrapResolvedContextEngine(engine, { owner: defaultEntry.owner });
}
