import type { OpenClawConfig } from "../config/config.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import type { ContextEngine } from "./types.js";

/**
 * A factory that creates a ContextEngine instance.
 * Supports async creation for engines that need DB connections etc.
 */
export type ContextEngineFactory = () => ContextEngine | Promise<ContextEngine>;
export type ContextEngineRegistrationResult = { ok: true } | { ok: false; existingOwner: string };

// ---------------------------------------------------------------------------
// Registry (module-level singleton)
// ---------------------------------------------------------------------------

const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");

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
function getContextEngineRegistryState(): ContextEngineRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [CONTEXT_ENGINE_REGISTRY_STATE]?: ContextEngineRegistryState;
  };
  if (!globalState[CONTEXT_ENGINE_REGISTRY_STATE]) {
    globalState[CONTEXT_ENGINE_REGISTRY_STATE] = {
      engines: new Map(),
    };
  }
  return globalState[CONTEXT_ENGINE_REGISTRY_STATE];
}

/**
 * Register a context engine implementation under the given id.
 */
export function registerContextEngine(
  id: string,
  factory: ContextEngineFactory,
  opts?: { owner?: string },
): ContextEngineRegistrationResult {
  const rawOwner = opts?.owner?.trim();
  if (opts?.owner !== undefined && !rawOwner) {
    throw new Error(
      `registerContextEngine: owner must be a non-empty string, got ${JSON.stringify(opts.owner)}`,
    );
  }
  const owner = rawOwner || "core";
  const registry = getContextEngineRegistryState().engines;
  const existing = registry.get(id);
  if (existing && existing.owner !== owner) {
    return { ok: false, existingOwner: existing.owner };
  }
  registry.set(id, { factory, owner });
  return { ok: true };
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

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which ContextEngine to use based on plugin slot configuration.
 *
 * Resolution order:
 *   1. `config.plugins.slots.contextEngine` (explicit slot override)
 *   2. Default slot value ("legacy")
 *
 * Throws if the resolved engine id has no registered factory.
 */
export async function resolveContextEngine(config?: OpenClawConfig): Promise<ContextEngine> {
  const slotValue = config?.plugins?.slots?.contextEngine;
  const engineId =
    typeof slotValue === "string" && slotValue.trim()
      ? slotValue.trim()
      : defaultSlotIdForKey("contextEngine");

  const entry = getContextEngineRegistryState().engines.get(engineId);
  if (!entry) {
    throw new Error(
      `Context engine "${engineId}" is not registered. ` +
        `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
    );
  }

  return entry.factory();
}
