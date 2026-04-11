import { registerContextEngineForOwner } from "./registry.js";
import type { ContextEngine } from "./types.js";

const LEGACY_CONTEXT_ENGINE_CANDIDATES = ["./legacy.js", "./legacy.ts"] as const;

type LegacyContextEngineModule = {
  LegacyContextEngine: new () => ContextEngine;
};

async function loadLegacyContextEngineModule(): Promise<LegacyContextEngineModule> {
  for (const candidate of LEGACY_CONTEXT_ENGINE_CANDIDATES) {
    try {
      return (await import(candidate)) as LegacyContextEngineModule;
    } catch {
      // Try runtime/source candidates in order.
    }
  }
  throw new Error("Failed to load legacy context engine runtime.");
}

export function registerLegacyContextEngine(): void {
  registerContextEngineForOwner(
    "legacy",
    async () => {
      const { LegacyContextEngine } = await loadLegacyContextEngineModule();
      return new LegacyContextEngine();
    },
    "core",
    {
      allowSameOwnerRefresh: true,
    },
  );
}
