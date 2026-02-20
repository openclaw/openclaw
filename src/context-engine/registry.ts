import type { OpenClawConfig } from "../config/config.js";
import type { ContextEngine } from "./types.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";

/**
 * A factory that creates a ContextEngine instance.
 * Supports async creation for engines that need DB connections etc.
 */
export type ContextEngineFactory = () => ContextEngine | Promise<ContextEngine>;

// ---------------------------------------------------------------------------
// Registry (module-level singleton)
// ---------------------------------------------------------------------------

const _engines = new Map<string, ContextEngineFactory>();

/**
 * Register a context engine implementation under the given id.
 */
export function registerContextEngine(id: string, factory: ContextEngineFactory): void {
  _engines.set(id, factory);
}

/**
 * Return the factory for a registered engine, or undefined.
 */
export function getContextEngineFactory(id: string): ContextEngineFactory | undefined {
  return _engines.get(id);
}

/**
 * List all registered engine ids.
 */
export function listContextEngineIds(): string[] {
  return [..._engines.keys()];
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

  const factory = _engines.get(engineId);
  if (!factory) {
    throw new Error(
      `Context engine "${engineId}" is not registered. ` +
        `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
    );
  }

  return factory();
}
